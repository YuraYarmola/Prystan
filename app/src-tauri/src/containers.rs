use bollard::query_parameters::{
    KillContainerOptions, ListContainersOptionsBuilder, LogsOptionsBuilder,
    RemoveContainerOptionsBuilder, RestartContainerOptions, StartContainerOptions,
    StatsOptionsBuilder, StopContainerOptions,
};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

#[derive(Serialize)]
pub struct ContainerRow {
    id: String,
    name: String,
    image: String,
    state: String,
    status: String,
    project: String,
    service: String,
    ports: String,
    workdir: String,
    config_file: String,
}

#[derive(Clone, Serialize)]
struct LogEvent {
    conn: String,
    cid: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct StatsEvent {
    conn: String,
    cid: String,
    cpu_pct: f64,
    mem_usage: u64,
    mem_limit: u64,
}

#[tauri::command]
pub async fn list_containers(
    state: State<'_, AppState>,
    conn: String,
) -> Result<Vec<ContainerRow>, String> {
    let docker = state.docker(&conn)?;
    let opts = ListContainersOptionsBuilder::new().all(true).build();
    let list = docker
        .list_containers(Some(opts))
        .await
        .map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .map(|c| {
            let labels = c.labels.unwrap_or_default();
            let ports = c
                .ports
                .unwrap_or_default()
                .iter()
                .filter_map(|p| {
                    p.public_port
                        .map(|pp| format!("{}:{}", pp, p.private_port))
                })
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            ContainerRow {
                id: c.id.unwrap_or_default(),
                name: c
                    .names
                    .unwrap_or_default()
                    .first()
                    .map(|n| n.trim_start_matches('/').to_string())
                    .unwrap_or_default(),
                image: c.image.unwrap_or_default(),
                state: c
                    .state
                    .map(|s| s.to_string().to_lowercase())
                    .unwrap_or_default(),
                status: c.status.unwrap_or_default(),
                project: labels
                    .get("com.docker.compose.project")
                    .cloned()
                    .unwrap_or_default(),
                service: labels
                    .get("com.docker.compose.service")
                    .cloned()
                    .unwrap_or_default(),
                ports,
                workdir: labels
                    .get("com.docker.compose.project.working_dir")
                    .cloned()
                    .unwrap_or_default(),
                config_file: labels
                    .get("com.docker.compose.project.config_files")
                    .cloned()
                    .unwrap_or_default(),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn container_action(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    action: String,
) -> Result<(), String> {
    let d = state.docker(&conn)?;
    let r = match action.as_str() {
        "start" => d.start_container(&id, None::<StartContainerOptions>).await,
        "stop" => d.stop_container(&id, None::<StopContainerOptions>).await,
        "restart" => {
            d.restart_container(&id, None::<RestartContainerOptions>)
                .await
        }
        "pause" => d.pause_container(&id).await,
        "unpause" => d.unpause_container(&id).await,
        "kill" => d.kill_container(&id, None::<KillContainerOptions>).await,
        "rm" => {
            let opts = RemoveContainerOptionsBuilder::new().force(true).build();
            d.remove_container(&id, Some(opts)).await
        }
        _ => return Err(format!("unknown action: {action}")),
    };
    // у журнал пишемо лише те, що змінює стан
    if matches!(action.as_str(), "stop" | "restart" | "kill" | "rm" | "start" | "pause" | "unpause") {
        crate::journal::log(
            &state,
            &conn,
            &action,
            &id.chars().take(12).collect::<String>(),
            &r.as_ref().err().map(|e| e.to_string()).unwrap_or_default(),
            r.is_ok(),
        );
    }
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn inspect_container(
    state: State<'_, AppState>,
    conn: String,
    id: String,
) -> Result<serde_json::Value, String> {
    let d = state.docker(&conn)?;
    let info = d
        .inspect_container(&id, None::<bollard::query_parameters::InspectContainerOptions>)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(info).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_logs(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    id: String,
    tail: Option<String>,
) -> Result<(), String> {
    if let Some(t) = state.logs_task.lock().unwrap().take() {
        t.abort();
    }

    let docker = state.docker(&conn)?;
    let cid = id.clone();
    let handle = tokio::spawn(async move {
        let opts = LogsOptionsBuilder::new()
            .follow(true)
            .stdout(true)
            .stderr(true)
            .tail(&tail.unwrap_or_else(|| "500".into()))
            .build();
        let mut stream = docker.logs(&cid, Some(opts));
        let _ = app.emit(
            "log-state",
            serde_json::json!({ "conn": conn, "cid": cid, "state": "open" }),
        );
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(out) => {
                    let line = String::from_utf8_lossy(&out.into_bytes()).to_string();
                    let _ = app.emit(
                        "docker-log",
                        LogEvent {
                            conn: conn.clone(),
                            cid: cid.clone(),
                            line,
                        },
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        "log-state",
                        serde_json::json!({ "conn": conn, "cid": cid, "state": "error", "msg": e.to_string() }),
                    );
                    break;
                }
            }
        }
        let _ = app.emit(
            "log-state",
            serde_json::json!({ "conn": conn, "cid": cid, "state": "closed" }),
        );
    });

    *state.logs_task.lock().unwrap() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_logs(state: State<'_, AppState>) {
    if let Some(t) = state.logs_task.lock().unwrap().take() {
        t.abort();
    }
}

#[tauri::command]
pub async fn start_stats(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    id: String,
) -> Result<(), String> {
    if let Some(t) = state.stats_task.lock().unwrap().take() {
        t.abort();
    }

    let docker = state.docker(&conn)?;
    let cid = id.clone();
    let handle = tokio::spawn(async move {
        let opts = StatsOptionsBuilder::new().stream(true).build();
        let mut stream = docker.stats(&cid, Some(opts));
        while let Some(Ok(st)) = stream.next().await {
            let cpu_total = st
                .cpu_stats
                .as_ref()
                .and_then(|c| c.cpu_usage.as_ref())
                .and_then(|u| u.total_usage)
                .unwrap_or(0);
            let pre_total = st
                .precpu_stats
                .as_ref()
                .and_then(|c| c.cpu_usage.as_ref())
                .and_then(|u| u.total_usage)
                .unwrap_or(0);
            let sys = st
                .cpu_stats
                .as_ref()
                .and_then(|c| c.system_cpu_usage)
                .unwrap_or(0);
            let pre_sys = st
                .precpu_stats
                .as_ref()
                .and_then(|c| c.system_cpu_usage)
                .unwrap_or(0);
            let ncpu = st
                .cpu_stats
                .as_ref()
                .and_then(|c| c.online_cpus)
                .unwrap_or(1)
                .max(1) as f64;

            let cpu_delta = cpu_total.saturating_sub(pre_total) as f64;
            let sys_delta = sys.saturating_sub(pre_sys) as f64;
            let cpu_pct = if sys_delta > 0.0 {
                cpu_delta / sys_delta * ncpu * 100.0
            } else {
                0.0
            };

            let mem_usage = st.memory_stats.as_ref().and_then(|m| m.usage).unwrap_or(0);
            let mem_limit = st.memory_stats.as_ref().and_then(|m| m.limit).unwrap_or(0);

            let _ = app.emit(
                "docker-stats",
                StatsEvent {
                    conn: conn.clone(),
                    cid: cid.clone(),
                    cpu_pct,
                    mem_usage,
                    mem_limit,
                },
            );
        }
    });

    *state.stats_task.lock().unwrap() = Some(handle);
    Ok(())
}
