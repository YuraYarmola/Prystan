use bollard::query_parameters::{
    CreateContainerOptionsBuilder, CreateImageOptionsBuilder, LogsOptionsBuilder,
    RemoveContainerOptionsBuilder, StartContainerOptions, WaitContainerOptions,
};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

const TRIVY_IMAGE: &str = "aquasec/trivy:latest";

#[derive(Serialize)]
pub struct Vuln {
    id: String,
    pkg: String,
    installed: String,
    fixed: String,
    severity: String,
    title: String,
    url: String,
}

#[derive(Serialize)]
pub struct ScanResult {
    image: String,
    total: usize,
    critical: usize,
    high: usize,
    medium: usize,
    low: usize,
    unknown: usize,
    fixable: usize,
    vulns: Vec<Vuln>,
}

/// Сканування образу на вразливості локальним контейнером Trivy.
/// Нічого не надсилається у хмару: trivy працює на тому ж демоні,
/// куди ми підключені, і читає образ через змонтований docker.sock.
#[tauri::command]
pub async fn scan_image(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    image: String,
) -> Result<ScanResult, String> {
    let d = state.docker(&conn)?;
    let step = |s: &str| {
        let _ = app.emit(
            "scan-progress",
            serde_json::json!({ "conn": conn, "image": image, "line": s }),
        );
    };

    // 1. переконуємось, що trivy є на цьому демоні
    if d.inspect_image(TRIVY_IMAGE).await.is_err() {
        step("завантажую aquasec/trivy (одноразово, ~150 МБ)…");
        let opts = CreateImageOptionsBuilder::new()
            .from_image("aquasec/trivy")
            .tag("latest")
            .build();
        let mut s = d.create_image(Some(opts), None, None);
        while let Some(item) = s.next().await {
            match item {
                Ok(info) => {
                    if let Some(st) = info.status {
                        step(&st);
                    }
                }
                Err(e) => return Err(format!("pull trivy: {e}")),
            }
        }
    }

    step(&format!("сканую {image}…"));

    // 2. запускаємо разовий контейнер зі змонтованим сокетом
    let cfg = bollard::models::ContainerCreateBody {
        image: Some(TRIVY_IMAGE.to_string()),
        cmd: Some(vec![
            "image".into(),
            "--quiet".into(),
            "--scanners".into(),
            "vuln".into(),
            "--format".into(),
            "json".into(),
            "--timeout".into(),
            "10m".into(),
            image.clone(),
        ]),
        host_config: Some(bollard::models::HostConfig {
            binds: Some(vec![
                "/var/run/docker.sock:/var/run/docker.sock:ro".to_string(),
                "prystan-trivy-cache:/root/.cache".to_string(),
            ]),
            auto_remove: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    };
    let name = format!(
        "prystan-scan-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let created = d
        .create_container(Some(CreateContainerOptionsBuilder::new().name(&name).build()), cfg)
        .await
        .map_err(|e| format!("create trivy: {e}"))?;

    let cleanup = |id: String, d: bollard::Docker| async move {
        let opts = RemoveContainerOptionsBuilder::new().force(true).build();
        let _ = d.remove_container(&id, Some(opts)).await;
    };

    if let Err(e) = d
        .start_container(&created.id, None::<StartContainerOptions>)
        .await
    {
        cleanup(created.id, d.clone()).await;
        return Err(format!("start trivy: {e}"));
    }

    // 3. чекаємо завершення
    let mut wait = d.wait_container(&created.id, None::<WaitContainerOptions>);
    let mut code = 0i64;
    while let Some(r) = wait.next().await {
        match r {
            Ok(w) => code = w.status_code,
            Err(e) => {
                // bollard повертає помилку на ненульовому коді — це нормально
                let msg = e.to_string();
                if !msg.contains("exit code") {
                    cleanup(created.id.clone(), d.clone()).await;
                    return Err(format!("wait trivy: {e}"));
                }
                code = 1;
            }
        }
    }

    // 4. збираємо stdout
    let opts = LogsOptionsBuilder::new().stdout(true).stderr(true).tail("all").build();
    let mut logs = d.logs(&created.id, Some(opts));
    let mut out = String::new();
    while let Some(chunk) = logs.next().await {
        if let Ok(c) = chunk {
            out.push_str(&String::from_utf8_lossy(&c.into_bytes()));
        }
    }
    cleanup(created.id, d.clone()).await;

    // trivy пише JSON у stdout; діагностика може бути домішана — беремо від першої {
    let start = out.find('{').ok_or_else(|| {
        format!(
            "trivy не повернув JSON (код {code}): {}",
            out.lines().rev().take(3).collect::<Vec<_>>().join(" ")
        )
    })?;
    let json: serde_json::Value =
        serde_json::from_str(&out[start..]).map_err(|e| format!("розбір звіту: {e}"))?;

    let mut res = ScanResult {
        image: image.clone(),
        total: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
        fixable: 0,
        vulns: vec![],
    };

    for target in json["Results"].as_array().cloned().unwrap_or_default() {
        for v in target["Vulnerabilities"].as_array().cloned().unwrap_or_default() {
            let sev = v["Severity"].as_str().unwrap_or("UNKNOWN").to_string();
            match sev.as_str() {
                "CRITICAL" => res.critical += 1,
                "HIGH" => res.high += 1,
                "MEDIUM" => res.medium += 1,
                "LOW" => res.low += 1,
                _ => res.unknown += 1,
            }
            let fixed = v["FixedVersion"].as_str().unwrap_or("").to_string();
            if !fixed.is_empty() {
                res.fixable += 1;
            }
            res.total += 1;
            if res.vulns.len() < 800 {
                res.vulns.push(Vuln {
                    id: v["VulnerabilityID"].as_str().unwrap_or("").to_string(),
                    pkg: v["PkgName"].as_str().unwrap_or("").to_string(),
                    installed: v["InstalledVersion"].as_str().unwrap_or("").to_string(),
                    fixed,
                    severity: sev,
                    title: v["Title"].as_str().unwrap_or("").to_string(),
                    url: v["PrimaryURL"].as_str().unwrap_or("").to_string(),
                });
            }
        }
    }

    // критичні — вгору
    let rank = |s: &str| match s {
        "CRITICAL" => 0,
        "HIGH" => 1,
        "MEDIUM" => 2,
        "LOW" => 3,
        _ => 4,
    };
    res.vulns.sort_by_key(|v| (rank(&v.severity), v.pkg.clone()));

    crate::journal::log(
        &state,
        &conn,
        "scan",
        &image,
        &format!("{} вразливостей (crit {}, high {})", res.total, res.critical, res.high),
        true,
    );
    Ok(res)
}

