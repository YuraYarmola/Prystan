use bollard::query_parameters::{
    CreateImageOptionsBuilder, ListImagesOptionsBuilder, ListNetworksOptions,
    ListVolumesOptions, PruneContainersOptions, PruneImagesOptions, PruneVolumesOptions,
    RemoveImageOptionsBuilder,
};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
#[allow(unused_imports)]
use bollard::query_parameters::PruneBuildOptions;

use crate::AppState;

#[derive(Serialize)]
pub struct ImageRow {
    id: String,
    tags: Vec<String>,
    size: i64,
    created: i64,
}

#[derive(Serialize)]
pub struct VolumeRow {
    name: String,
    driver: String,
    mountpoint: String,
}

#[derive(Serialize)]
pub struct NetworkRow {
    id: String,
    name: String,
    driver: String,
    scope: String,
}

#[tauri::command]
pub async fn list_images(
    state: State<'_, AppState>,
    conn: String,
) -> Result<Vec<ImageRow>, String> {
    let d = state.docker(&conn)?;
    let opts = ListImagesOptionsBuilder::new().all(false).build();
    let list = d.list_images(Some(opts)).await.map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .map(|i| ImageRow {
            id: i.id,
            tags: i.repo_tags,
            size: i.size,
            created: i.created,
        })
        .collect())
}

#[tauri::command]
pub async fn remove_image(
    state: State<'_, AppState>,
    conn: String,
    id: String,
) -> Result<(), String> {
    let d = state.docker(&conn)?;
    let opts = RemoveImageOptionsBuilder::new().force(false).build();
    d.remove_image(&id, Some(opts), None)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pull_image(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    image: String,
) -> Result<(), String> {
    let d = state.docker(&conn)?;
    let (name, tag) = match image.rsplit_once(':') {
        Some((n, t)) if !t.contains('/') => (n.to_string(), t.to_string()),
        _ => (image.clone(), "latest".into()),
    };
    let opts = CreateImageOptionsBuilder::new()
        .from_image(&name)
        .tag(&tag)
        .build();
    // приватні образи тягнемо зі збереженими креденшелами
    let creds = creds_for(&registry_of(&image));
    let mut stream = d.create_image(Some(opts), None, creds);
    while let Some(item) = stream.next().await {
        match item {
            Ok(info) => {
                let line = format!(
                    "{} {} {}",
                    info.id.unwrap_or_default(),
                    info.status.unwrap_or_default(),
                    info.progress.unwrap_or_default()
                );
                let _ = app.emit(
                    "pull-progress",
                    serde_json::json!({ "conn": conn, "image": image, "line": line, "done": false }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "pull-progress",
                    serde_json::json!({ "conn": conn, "image": image, "line": format!("Помилка: {e}"), "done": true }),
                );
                return Err(e.to_string());
            }
        }
    }
    let _ = app.emit(
        "pull-progress",
        serde_json::json!({ "conn": conn, "image": image, "line": "Готово ✓", "done": true }),
    );
    Ok(())
}

#[tauri::command]
pub async fn list_volumes(
    state: State<'_, AppState>,
    conn: String,
) -> Result<Vec<VolumeRow>, String> {
    let d = state.docker(&conn)?;
    let r = d
        .list_volumes(None::<ListVolumesOptions>)
        .await
        .map_err(|e| e.to_string())?;
    Ok(r.volumes
        .unwrap_or_default()
        .into_iter()
        .map(|v| VolumeRow {
            name: v.name,
            driver: v.driver,
            mountpoint: v.mountpoint,
        })
        .collect())
}

#[tauri::command]
pub async fn remove_volume(
    state: State<'_, AppState>,
    conn: String,
    name: String,
) -> Result<(), String> {
    let d = state.docker(&conn)?;
    d.remove_volume(&name, None::<bollard::query_parameters::RemoveVolumeOptions>)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_networks(
    state: State<'_, AppState>,
    conn: String,
) -> Result<Vec<NetworkRow>, String> {
    let d = state.docker(&conn)?;
    let list = d
        .list_networks(None::<ListNetworksOptions>)
        .await
        .map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .map(|n| NetworkRow {
            id: n.id.unwrap_or_default(),
            name: n.name.unwrap_or_default(),
            driver: n.driver.unwrap_or_default(),
            scope: n.scope.unwrap_or_default(),
        })
        .collect())
}

#[tauri::command]
pub async fn remove_network(
    state: State<'_, AppState>,
    conn: String,
    id: String,
) -> Result<(), String> {
    let d = state.docker(&conn)?;
    d.remove_network(&id).await.map_err(|e| e.to_string())
}

/// Шари образу: що скільки важить і якою інструкцією створене.
#[tauri::command]
pub async fn image_history(
    state: State<'_, AppState>,
    conn: String,
    id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let d = state.docker(&conn)?;
    let hist = d.image_history(&id).await.map_err(|e| e.to_string())?;
    Ok(hist
        .into_iter()
        .map(|h| {
            serde_json::json!({
                "id": h.id,
                "created": h.created,
                "created_by": h.created_by,
                "size": h.size,
                "comment": h.comment,
                "tags": h.tags,
            })
        })
        .collect())
}

/// Diff файлової системи контейнера відносно образу (0=змінено, 1=додано, 2=видалено).
#[tauri::command]
pub async fn container_diff(
    state: State<'_, AppState>,
    conn: String,
    id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let d = state.docker(&conn)?;
    let changes = d
        .container_changes(&id)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(changes
        .into_iter()
        .map(|c| {
            use bollard::models::ChangeType;
            // Docker: 0 = змінено, 1 = додано, 2 = видалено
            let kind = match c.kind {
                ChangeType::_0 => "modified",
                ChangeType::_1 => "added",
                _ => "deleted",
            };
            serde_json::json!({ "path": c.path, "kind": kind })
        })
        .collect())
}

/// Зміна лімітів CPU/RAM без пересоздання контейнера.
#[tauri::command]
pub async fn update_resources(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    cpus: Option<f64>,
    memory_mb: Option<i64>,
    memory_swap_mb: Option<i64>,
    cpu_shares: Option<i64>,
) -> Result<(), String> {
    let d = state.docker(&conn)?;
    let mut body = bollard::models::ContainerUpdateBody::default();

    if let Some(c) = cpus {
        if c > 0.0 {
            // Docker рахує CPU через period/quota: 1 CPU = quota == period
            body.cpu_period = Some(100_000);
            body.cpu_quota = Some((c * 100_000.0).round() as i64);
        } else {
            body.cpu_period = Some(100_000);
            body.cpu_quota = Some(0); // 0 = без ліміту
        }
    }
    if let Some(m) = memory_mb {
        body.memory = Some(m * 1024 * 1024);
        // swap не може бути меншим за memory; -1 = необмежений
        body.memory_swap = Some(match memory_swap_mb {
            Some(s) if s < 0 => -1,
            Some(s) => (s * 1024 * 1024).max(m * 1024 * 1024),
            None => m * 1024 * 1024,
        });
    }
    if let Some(s) = cpu_shares {
        body.cpu_shares = Some(s);
    }

    let r = d.update_container(&id, body).await;
    crate::journal::log(
        &state,
        &conn,
        "limits",
        &id.chars().take(12).collect::<String>(),
        &format!("cpus={cpus:?} mem={memory_mb:?}МБ"),
        r.is_ok(),
    );
    r.map_err(|e| e.to_string())
}

/* ── реєстри: креденшели в системному сховищі ── */

const KEY_SERVICE: &str = "Prystan";

fn reg_key(server: &str) -> String {
    format!("registry:{server}")
}

/// Реєстр із назви образу: ghcr.io/user/app → ghcr.io, redis:7 → docker.io
pub fn registry_of(image: &str) -> String {
    let first = image.split('/').next().unwrap_or("");
    if image.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost") {
        first.to_string()
    } else {
        "docker.io".to_string()
    }
}

fn creds_for(server: &str) -> Option<bollard::auth::DockerCredentials> {
    let e = keyring::Entry::new(KEY_SERVICE, &reg_key(server)).ok()?;
    let raw = e.get_password().ok()?;
    let mut it = raw.splitn(2, '\n');
    let username = it.next()?.to_string();
    let password = it.next()?.to_string();
    Some(bollard::auth::DockerCredentials {
        username: Some(username),
        password: Some(password),
        serveraddress: Some(server.to_string()),
        ..Default::default()
    })
}

#[tauri::command]
pub fn registry_save(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
) -> Result<Vec<String>, String> {
    let e = keyring::Entry::new(KEY_SERVICE, &reg_key(&server)).map_err(|e| e.to_string())?;
    e.set_password(&format!("{username}\n{password}"))
        .map_err(|e| format!("keychain: {e}"))?;

    // індекс серверів тримаємо поруч із профілями (без паролів)
    let path = state.profiles_path.with_file_name("registries.json");
    let mut list: Vec<String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if !list.contains(&server) {
        list.push(server.clone());
    }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&list).unwrap());
    crate::journal::log(&state, "", "registry-login", &server, &username, true);
    Ok(list)
}

#[tauri::command]
pub fn registry_list(state: State<'_, AppState>) -> Vec<String> {
    let path = state.profiles_path.with_file_name("registries.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn registry_delete(state: State<'_, AppState>, server: String) -> Vec<String> {
    if let Ok(e) = keyring::Entry::new(KEY_SERVICE, &reg_key(&server)) {
        let _ = e.delete_credential();
    }
    let path = state.profiles_path.with_file_name("registries.json");
    let mut list: Vec<String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.retain(|s| s != &server);
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&list).unwrap());
    list
}

/// Відправити образ у реєстр (креденшели беруться з keychain за хостом тега).
#[tauri::command]
pub async fn push_image(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    tag: String,
) -> Result<(), String> {
    use bollard::query_parameters::PushImageOptionsBuilder;

    let d = state.docker(&conn)?;
    let server = registry_of(&tag);
    let creds = creds_for(&server);
    if creds.is_none() && server != "docker.io" {
        return Err(format!("немає збережених креденшелів для {server}"));
    }

    let (name, t) = match tag.rsplit_once(':') {
        Some((n, tt)) if !tt.contains('/') => (n.to_string(), tt.to_string()),
        _ => (tag.clone(), "latest".to_string()),
    };
    let opts = PushImageOptionsBuilder::new().tag(&t).build();
    let mut stream = d.push_image(&name, Some(opts), creds);

    while let Some(item) = stream.next().await {
        match item {
            Ok(info) => {
                let line = format!(
                    "{} {}",
                    info.status.unwrap_or_default(),
                    info.progress.unwrap_or_default()
                );
                let _ = app.emit(
                    "push-progress",
                    serde_json::json!({ "conn": conn, "tag": tag, "line": line.trim(), "done": false }),
                );
                if let Some(err) = info.error {
                    let _ = app.emit(
                        "push-progress",
                        serde_json::json!({ "conn": conn, "tag": tag, "line": format!("✗ {err}"), "done": true }),
                    );
                    crate::journal::log(&state, &conn, "push", &tag, &err, false);
                    return Err(err);
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "push-progress",
                    serde_json::json!({ "conn": conn, "tag": tag, "line": format!("✗ {e}"), "done": true }),
                );
                crate::journal::log(&state, &conn, "push", &tag, &e.to_string(), false);
                return Err(e.to_string());
            }
        }
    }
    let _ = app.emit(
        "push-progress",
        serde_json::json!({ "conn": conn, "tag": tag, "line": "✓ Готово", "done": true }),
    );
    crate::journal::log(&state, &conn, "push", &tag, "", true);
    Ok(())
}

/// B1 — скільки місця їдять образи/контейнери/томи/build cache.
#[tauri::command]
pub async fn system_df(state: State<'_, AppState>, conn: String) -> Result<serde_json::Value, String> {
    let d = state.docker(&conn)?;
    let df = d
        .df(None::<bollard::query_parameters::DataUsageOptions>)
        .await
        .map_err(|e| e.to_string())?;

    let images_total: i64 = df.images.as_ref().map(|v| v.iter().map(|i| i.size).sum()).unwrap_or(0);
    let images_unused: i64 = df
        .images
        .as_ref()
        .map(|v| v.iter().filter(|i| i.containers == 0).map(|i| i.size).sum())
        .unwrap_or(0);
    let containers_total: i64 = df
        .containers
        .as_ref()
        .map(|v| v.iter().map(|c| c.size_rw.unwrap_or(0)).sum())
        .unwrap_or(0);
    let volumes_total: i64 = df
        .volumes
        .as_ref()
        .map(|v| {
            v.iter()
                .filter_map(|x| x.usage_data.as_ref().map(|u| u.size))
                .sum()
        })
        .unwrap_or(0);
    let volumes_unused: i64 = df
        .volumes
        .as_ref()
        .map(|v| {
            v.iter()
                .filter_map(|x| x.usage_data.as_ref())
                .filter(|u| u.ref_count == 0)
                .map(|u| u.size)
                .sum()
        })
        .unwrap_or(0);
    let build_cache: i64 = df
        .build_cache
        .as_ref()
        .map(|v| v.iter().map(|c| c.size.unwrap_or(0)).sum())
        .unwrap_or(0);

    Ok(serde_json::json!({
        "images_total": images_total,
        "images_unused": images_unused,
        "images_count": df.images.as_ref().map(|v| v.len()).unwrap_or(0),
        "containers_total": containers_total,
        "containers_count": df.containers.as_ref().map(|v| v.len()).unwrap_or(0),
        "volumes_total": volumes_total,
        "volumes_unused": volumes_unused,
        "volumes_count": df.volumes.as_ref().map(|v| v.len()).unwrap_or(0),
        "build_cache": build_cache,
    }))
}

/// B7 — створення контейнера з форми.
#[tauri::command]
pub async fn create_container(
    state: State<'_, AppState>,
    conn: String,
    spec: serde_json::Value,
) -> Result<String, String> {
    use bollard::models::{HostConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum};
    use bollard::query_parameters::CreateContainerOptionsBuilder;
    use std::collections::HashMap;

    let d = state.docker(&conn)?;
    let name = spec["name"].as_str().unwrap_or("").to_string();
    let image = spec["image"].as_str().unwrap_or_default().to_string();
    if image.is_empty() {
        return Err("вкажіть образ".into());
    }

    // порти: ["8080:80", "5432:5432/tcp"]
    let mut port_bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
    let mut exposed: HashMap<String, HashMap<(), ()>> = HashMap::new();
    for p in spec["ports"].as_array().cloned().unwrap_or_default() {
        let s = p.as_str().unwrap_or("").trim().to_string();
        if s.is_empty() {
            continue;
        }
        let (host, rest) = s.split_once(':').ok_or(format!("порт '{s}': очікується host:container"))?;
        let cport = if rest.contains('/') { rest.to_string() } else { format!("{rest}/tcp") };
        port_bindings.insert(
            cport.clone(),
            Some(vec![PortBinding {
                host_ip: Some("0.0.0.0".into()),
                host_port: Some(host.to_string()),
            }]),
        );
        exposed.insert(cport, HashMap::new());
    }

    let binds: Vec<String> = spec["volumes"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();

    let env: Vec<String> = spec["env"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();

    let restart = match spec["restart"].as_str().unwrap_or("no") {
        "always" => Some(RestartPolicyNameEnum::ALWAYS),
        "unless-stopped" => Some(RestartPolicyNameEnum::UNLESS_STOPPED),
        "on-failure" => Some(RestartPolicyNameEnum::ON_FAILURE),
        _ => Some(RestartPolicyNameEnum::NO),
    };

    let cmd: Option<Vec<String>> = spec["cmd"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.split_whitespace().map(|x| x.to_string()).collect());

    let config = bollard::models::ContainerCreateBody {
        image: Some(image),
        cmd,
        env: if env.is_empty() { None } else { Some(env) },
        exposed_ports: if exposed.is_empty() { None } else { Some(exposed) },
        host_config: Some(HostConfig {
            port_bindings: if port_bindings.is_empty() { None } else { Some(port_bindings) },
            binds: if binds.is_empty() { None } else { Some(binds) },
            restart_policy: Some(RestartPolicy { name: restart, maximum_retry_count: None }),
            ..Default::default()
        }),
        ..Default::default()
    };

    let opts = CreateContainerOptionsBuilder::new().name(&name).build();
    let res = d
        .create_container(Some(opts), config)
        .await
        .map_err(|e| e.to_string())?;

    if spec["start"].as_bool().unwrap_or(true) {
        d.start_container(&res.id, None::<bollard::query_parameters::StartContainerOptions>)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(res.id)
}

/// Редагування env працюючого контейнера.
/// Docker не вміє змінювати env на льоту, тому (як і плагін JetBrains)
/// контейнер перестворюється: конфіг зберігається, змінюється лише Env.
/// Старий контейнер перейменовується, і при будь-якій помилці все відкочується.
#[tauri::command]
pub async fn recreate_with_env(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    id: String,
    env: Vec<String>,
) -> Result<String, String> {
    use bollard::query_parameters::{
        CreateContainerOptionsBuilder, InspectContainerOptions, RemoveContainerOptionsBuilder,
        RenameContainerOptions, StartContainerOptions, StopContainerOptions,
    };

    let d = state.docker(&conn)?;
    let step = |s: &str| {
        let _ = app.emit("recreate-progress", serde_json::json!({ "conn": conn, "line": s }));
    };

    step("читаю конфігурацію…");
    let info = d
        .inspect_container(&id, None::<InspectContainerOptions>)
        .await
        .map_err(|e| e.to_string())?;

    let name = info
        .name
        .clone()
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_string();
    if name.is_empty() {
        return Err("не вдалося визначити ім'я контейнера".into());
    }
    let was_running = info
        .state
        .as_ref()
        .and_then(|s| s.running)
        .unwrap_or(false);
    let cfg = info.config.clone().unwrap_or_default();

    // мережі: зберігаємо імена й аліаси, скидаємо динамічні адреси
    let endpoints = info
        .network_settings
        .as_ref()
        .and_then(|n| n.networks.clone())
        .map(|nets| {
            nets.into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        bollard::models::EndpointSettings {
                            aliases: v.aliases,
                            links: v.links,
                            ..Default::default()
                        },
                    )
                })
                .collect::<std::collections::HashMap<_, _>>()
        })
        .filter(|m| !m.is_empty());

    let body = bollard::models::ContainerCreateBody {
        image: cfg.image.clone(),
        cmd: cfg.cmd.clone(),
        entrypoint: cfg.entrypoint.clone(),
        env: Some(env),
        working_dir: cfg.working_dir.clone(),
        user: cfg.user.clone(),
        labels: cfg.labels.clone(),
        exposed_ports: cfg.exposed_ports.clone(),
        tty: cfg.tty,
        open_stdin: cfg.open_stdin,
        stdin_once: cfg.stdin_once,
        attach_stdin: cfg.attach_stdin,
        attach_stdout: cfg.attach_stdout,
        attach_stderr: cfg.attach_stderr,
        healthcheck: cfg.healthcheck.clone(),
        hostname: cfg.hostname.clone(),
        domainname: cfg.domainname.clone(),
        volumes: cfg.volumes.clone(),
        stop_signal: cfg.stop_signal.clone(),
        stop_timeout: cfg.stop_timeout,
        host_config: info.host_config.clone(),
        networking_config: endpoints.map(|e| bollard::models::NetworkingConfig {
            endpoints_config: Some(e),
        }),
        ..Default::default()
    };

    if was_running {
        step("зупиняю контейнер…");
        d.stop_container(&id, None::<StopContainerOptions>)
            .await
            .map_err(|e| format!("stop: {e}"))?;
    }

    let backup_name = format!("{name}__da_old");
    step("резервую старий контейнер…");
    d.rename_container(&id, RenameContainerOptions { name: backup_name.clone() })
        .await
        .map_err(|e| format!("rename: {e}"))?;

    // відкат: повертаємо ім'я і, якщо треба, запускаємо
    async fn rollback(
        d: &bollard::Docker,
        id: &str,
        name: &str,
        was_running: bool,
    ) {
        use bollard::query_parameters::{RenameContainerOptions, StartContainerOptions};
        let _ = d
            .rename_container(id, RenameContainerOptions { name: name.to_string() })
            .await;
        if was_running {
            let _ = d.start_container(id, None::<StartContainerOptions>).await;
        }
    }

    step("створюю новий контейнер…");
    let opts = CreateContainerOptionsBuilder::new().name(&name).build();
    let created = match d.create_container(Some(opts), body).await {
        Ok(c) => c,
        Err(e) => {
            rollback(&d, &id, &name, was_running).await;
            return Err(format!("create: {e} (зміни відкочено)"));
        }
    };

    if was_running {
        step("запускаю…");
        if let Err(e) = d
            .start_container(&created.id, None::<StartContainerOptions>)
            .await
        {
            let ropts = RemoveContainerOptionsBuilder::new().force(true).build();
            let _ = d.remove_container(&created.id, Some(ropts)).await;
            rollback(&d, &id, &name, was_running).await;
            return Err(format!("start: {e} (зміни відкочено)"));
        }
    }

    step("прибираю старий контейнер…");
    let ropts = RemoveContainerOptionsBuilder::new().force(true).v(false).build();
    if let Err(e) = d.remove_container(&id, Some(ropts)).await {
        // новий уже працює — старий лишається як резерв
        step(&format!("увага: старий контейнер {backup_name} не видалено: {e}"));
    }

    step("готово ✓");
    Ok(created.id)
}

/// B8 — build образу з локальної теки (тар-контекст → Engine API).
#[tauri::command]
pub async fn build_image(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    context_dir: String,
    dockerfile: Option<String>,
    tag: String,
) -> Result<(), String> {
    use bollard::query_parameters::BuildImageOptionsBuilder;

    let d = state.docker(&conn)?;
    let dir = std::path::PathBuf::from(&context_dir);
    if !dir.is_dir() {
        return Err(format!("тека не знайдена: {context_dir}"));
    }

    // пакуємо контекст у tar (поважаємо .dockerignore на рівні базових правил)
    let ignore: Vec<String> = std::fs::read_to_string(dir.join(".dockerignore"))
        .map(|s| {
            s.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .collect()
        })
        .unwrap_or_default();
    let skip = |rel: &str| {
        rel.starts_with(".git/")
            || rel == ".git"
            || ignore.iter().any(|p| {
                let p = p.trim_end_matches('/');
                rel == p || rel.starts_with(&format!("{p}/"))
            })
    };

    let mut builder = tar::Builder::new(Vec::new());
    let mut stack = vec![dir.clone()];
    let mut files = 0usize;
    while let Some(cur) = stack.pop() {
        for e in std::fs::read_dir(&cur).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let path = e.path();
            let rel = path
                .strip_prefix(&dir)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if skip(&rel) {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else {
                builder
                    .append_path_with_name(&path, &rel)
                    .map_err(|e| e.to_string())?;
                files += 1;
                if files > 20000 {
                    return Err("контекст завеликий (>20000 файлів)".into());
                }
            }
        }
    }
    let tar_bytes = builder.into_inner().map_err(|e| e.to_string())?;

    let mut ob = BuildImageOptionsBuilder::new().t(&tag).rm(true);
    if let Some(df) = dockerfile.as_deref().filter(|s| !s.is_empty()) {
        ob = ob.dockerfile(df);
    }
    let _ = app.emit(
        "build-output",
        serde_json::json!({ "conn": conn, "tag": tag, "line": format!("контекст: {files} файлів, {} КБ", tar_bytes.len() / 1024), "done": false }),
    );

    let mut stream = d.build_image(ob.build(), None, Some(bollard::body_full(tar_bytes.into())));
    while let Some(item) = stream.next().await {
        match item {
            Ok(info) => {
                let line = info
                    .stream
                    .or(info.status)
                    .or_else(|| info.error.clone())
                    .unwrap_or_default();
                let line = line.trim_end().to_string();
                if !line.is_empty() {
                    let _ = app.emit(
                        "build-output",
                        serde_json::json!({ "conn": conn, "tag": tag, "line": line, "done": false }),
                    );
                }
                if let Some(err) = info.error {
                    let _ = app.emit(
                        "build-output",
                        serde_json::json!({ "conn": conn, "tag": tag, "line": format!("✗ {err}"), "done": true }),
                    );
                    return Err(err);
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "build-output",
                    serde_json::json!({ "conn": conn, "tag": tag, "line": format!("✗ {e}"), "done": true }),
                );
                return Err(e.to_string());
            }
        }
    }
    let _ = app.emit(
        "build-output",
        serde_json::json!({ "conn": conn, "tag": tag, "line": "✓ Готово", "done": true }),
    );
    Ok(())
}

/// B9 — імпорт docker contexts із ~/.docker/contexts
#[tauri::command]
pub fn import_contexts() -> Result<Vec<serde_json::Value>, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "не знайдено домашню теку")?;
    let meta = std::path::PathBuf::from(home).join(".docker").join("contexts").join("meta");
    if !meta.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for e in std::fs::read_dir(&meta).map_err(|e| e.to_string())? {
        let e = match e { Ok(e) => e, Err(_) => continue };
        let f = e.path().join("meta.json");
        let txt = match std::fs::read_to_string(&f) { Ok(t) => t, Err(_) => continue };
        let j: serde_json::Value = match serde_json::from_str(&txt) { Ok(j) => j, Err(_) => continue };
        let name = j["Name"].as_str().unwrap_or("").to_string();
        let host = j["Endpoints"]["docker"]["Host"].as_str().unwrap_or("").to_string();
        if name.is_empty() || host.is_empty() || name == "default" {
            continue;
        }
        // ssh://user@host:port | tcp://host:port
        let parsed = if let Some(rest) = host.strip_prefix("ssh://") {
            let (userhost, port) = rest.rsplit_once(':').unwrap_or((rest, "22"));
            let (user, h) = userhost.split_once('@').unwrap_or(("root", userhost));
            serde_json::json!({ "kind": "ssh", "user": user, "host": h, "port": port.parse::<u16>().unwrap_or(22) })
        } else if let Some(rest) = host.strip_prefix("tcp://") {
            let (h, port) = rest.rsplit_once(':').unwrap_or((rest, "2375"));
            serde_json::json!({ "kind": "tcp", "user": "", "host": h, "port": port.parse::<u16>().unwrap_or(2375) })
        } else {
            continue;
        };
        out.push(serde_json::json!({ "name": name, "raw": host, "profile": parsed }));
    }
    Ok(out)
}

#[tauri::command]
pub async fn prune(
    state: State<'_, AppState>,
    conn: String,
    what: String,
) -> Result<String, String> {
    let d = state.docker(&conn)?;
    match what.as_str() {
        "containers" => {
            let r = d
                .prune_containers(None::<PruneContainersOptions>)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "Видалено контейнерів: {}",
                r.containers_deleted.map(|v| v.len()).unwrap_or(0)
            ))
        }
        "images" => {
            let r = d
                .prune_images(None::<PruneImagesOptions>)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "Звільнено: {} МБ",
                r.space_reclaimed.unwrap_or(0) / 1024 / 1024
            ))
        }
        "volumes" => {
            let r = d
                .prune_volumes(None::<PruneVolumesOptions>)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "Видалено томів: {}",
                r.volumes_deleted.map(|v| v.len()).unwrap_or(0)
            ))
        }
        "builder" => {
            let r = d
                .prune_build(None::<PruneBuildOptions>)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "Build cache звільнено: {} МБ",
                r.space_reclaimed.unwrap_or(0) / 1024 / 1024
            ))
        }
        _ => Err("невідомий тип prune".into()),
    }
}
