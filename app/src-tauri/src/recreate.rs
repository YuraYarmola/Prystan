use bollard::Docker;

pub async fn recreate(
    d: &Docker,
    id: &str,
    env: Vec<String>,
    step: impl Fn(&str),
) -> Result<String, String> {
    use bollard::query_parameters::{
        CreateContainerOptionsBuilder, InspectContainerOptions, RemoveContainerOptionsBuilder,
        RenameContainerOptions, StartContainerOptions, StopContainerOptions,
    };

    step("читаю конфігурацію…");
    let info = d
        .inspect_container(id, None::<InspectContainerOptions>)
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
    let was_running = info.state.as_ref().and_then(|s| s.running).unwrap_or(false);
    let cfg = info.config.clone().unwrap_or_default();

    // Фіксована адреса зайнята старим endpoint: не зупиняємо контейнер,
    // доки немає безпечного способу передати її новому.
    if info
        .network_settings
        .as_ref()
        .and_then(|n| n.networks.as_ref())
        .is_some_and(|nets| {
            nets.values().any(|v| {
                v.ipam_config.as_ref().is_some_and(|ip| {
                    ip.ipv4_address.as_ref().is_some_and(|s| !s.is_empty())
                        || ip.ipv6_address.as_ref().is_some_and(|s| !s.is_empty())
                })
            })
        })
    {
        return Err(
            "контейнер має статичну IP-адресу; змініть env у Compose і застосуйте конфігурацію"
                .into(),
        );
    }
    let mut hc = info.host_config.clone().unwrap_or_default();
    // Анонімні томи мають отримати старе ім'я, інакше Docker створить порожні.
    for mount in info.mounts.as_deref().unwrap_or_default() {
        if mount.typ != Some(bollard::models::MountPointTypeEnum::VOLUME) {
            continue;
        }
        let (Some(source), Some(target)) = (&mount.name, &mount.destination) else {
            continue;
        };
        if let Some(existing) = hc
            .mounts
            .as_mut()
            .and_then(|m| m.iter_mut().find(|m| m.target.as_ref() == Some(target)))
        {
            existing.source = Some(source.clone());
        } else if !hc
            .binds
            .as_ref()
            .is_some_and(|b| b.iter().any(|b| b.split(':').nth(1) == Some(target)))
        {
            hc.mounts
                .get_or_insert_with(Vec::new)
                .push(bollard::models::Mount {
                    typ: Some(bollard::models::MountTypeEnum::VOLUME),
                    source: Some(source.clone()),
                    target: Some(target.clone()),
                    read_only: mount.rw.map(|rw| !rw),
                    ..Default::default()
                });
        }
    }

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
                            driver_opts: v.driver_opts,
                            gw_priority: v.gw_priority,
                            ..Default::default()
                        },
                    )
                })
                .collect::<std::collections::HashMap<_, _>>()
        })
        .filter(|m| !m.is_empty());

    let body = bollard::models::ContainerCreateBody {
        image: info.image.clone().or(cfg.image.clone()),
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
        host_config: Some(hc),
        networking_config: endpoints.map(|e| bollard::models::NetworkingConfig {
            endpoints_config: Some(e),
        }),
        ..Default::default()
    };

    if was_running {
        step("зупиняю контейнер…");
        if let Err(e) = d.stop_container(id, None::<StopContainerOptions>).await {
            // При втраті відповіді демон міг уже зупинити сервіс.
            let recovered = match d
                .inspect_container(id, None::<InspectContainerOptions>)
                .await
            {
                Ok(info) if info.state.as_ref().and_then(|s| s.running) == Some(true) => Ok(()),
                Ok(_) => d
                    .start_container(id, None::<StartContainerOptions>)
                    .await
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            return Err(recovery_error(format!("stop: {e}"), recovered));
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let backup_name = format!("{name}__prystan_backup_{stamp}");
    step("резервую старий контейнер…");
    if let Err(e) = d
        .rename_container(
            id,
            RenameContainerOptions {
                name: backup_name.clone(),
            },
        )
        .await
    {
        let recovered = if was_running {
            d.start_container(id, None::<StartContainerOptions>)
                .await
                .map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        return Err(recovery_error(format!("rename: {e}"), recovered));
    }

    step("створюю новий контейнер…");
    let opts = CreateContainerOptionsBuilder::new().name(&name).build();
    let created = match d.create_container(Some(opts), body).await {
        Ok(c) => c,
        Err(e) => {
            return Err(recovery_error(
                format!("create: {e}"),
                rollback(d, id, &name, was_running).await,
            ));
        }
    };

    if was_running {
        step("запускаю…");
        if let Err(e) = d
            .start_container(&created.id, None::<StartContainerOptions>)
            .await
        {
            let ropts = RemoveContainerOptionsBuilder::new().force(true).build();
            if let Err(cleanup) = d.remove_container(&created.id, Some(ropts)).await {
                // Повертаємо старий сервіс під резервним ім'ям, не видаляючи дані.
                let restarted = if was_running {
                    d.start_container(id, None::<StartContainerOptions>)
                        .await
                        .map_err(|e| e.to_string())
                } else {
                    Ok(())
                };
                return Err(format!("start: {e}; новий контейнер {} не видалено: {cleanup}; старий збережено як {backup_name}; запуск: {restarted:?}", created.id));
            }
            return Err(recovery_error(
                format!("start: {e}"),
                rollback(d, id, &name, was_running).await,
            ));
        }
    }

    if was_running {
        step("перевіряю стан нового контейнера…");
        if let Err(e) = wait_ready(d, &created.id).await {
            let ropts = RemoveContainerOptionsBuilder::new()
                .force(true)
                .v(false)
                .build();
            if let Err(cleanup) = d.remove_container(&created.id, Some(ropts)).await {
                return Err(format!(
                    "{e}; cleanup: {cleanup}; старий контейнер збережено як {backup_name}"
                ));
            }
            return Err(recovery_error(e, rollback(d, id, &name, was_running).await));
        }
    }
    step("прибираю старий контейнер…");
    let ropts = RemoveContainerOptionsBuilder::new()
        .force(true)
        .v(false)
        .build();
    if let Err(e) = d.remove_container(id, Some(ropts)).await {
        // новий уже працює — старий лишається як резерв
        step(&format!(
            "увага: старий контейнер {backup_name} не видалено: {e}"
        ));
    }

    step("готово ✓");
    Ok(created.id)
}

fn recovery_error(error: String, recovery: Result<(), String>) -> String {
    match recovery {
        Ok(()) => format!("{error}; старий контейнер відновлено"),
        Err(e) => format!("{error}; відновлення не завершено: {e}; старий контейнер збережено, перевірте його вручну"),
    }
}

async fn rollback(d: &Docker, id: &str, name: &str, running: bool) -> Result<(), String> {
    use bollard::query_parameters::{RenameContainerOptions, StartContainerOptions};
    let rename = d
        .rename_container(id, RenameContainerOptions { name: name.into() })
        .await
        .map_err(|e| format!("rename: {e}"));
    let start = if running {
        d.start_container(id, None::<StartContainerOptions>)
            .await
            .map_err(|e| format!("start: {e}"))
    } else {
        Ok(())
    };
    match (rename, start) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(a), Err(b)) => Err(format!("{a}; {b}")),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}

async fn wait_ready(d: &Docker, id: &str) -> Result<(), String> {
    use bollard::query_parameters::InspectContainerOptions;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let info = d
            .inspect_container(id, None::<InspectContainerOptions>)
            .await
            .map_err(|e| e.to_string())?;
        let state = info.state.ok_or("немає стану нового контейнера")?;
        if state.running != Some(true) {
            return Err("новий контейнер завершився; повертаю старий".into());
        }
        if let Some(health) = state.health {
            let status = health.status.map(|s| s.to_string()).unwrap_or_default();
            if status == "healthy" {
                return Ok(());
            }
            if status == "unhealthy" {
                return Err("новий контейнер unhealthy; повертаю старий".into());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("healthcheck не підтвердив готовність за 60 с; повертаю старий".into());
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        } else {
            return Ok(());
        }
    }
}

#[cfg(test)]
#[path = "recreate_tests.rs"]
mod tests;
