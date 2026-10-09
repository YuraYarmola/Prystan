use super::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

type Step = (&'static str, &'static str, u16, Value);

fn mock(steps: Vec<Step>) -> (Docker, std::thread::JoinHandle<Vec<Value>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let thread = std::thread::spawn(move || {
        let mut bodies = Vec::new();
        for (method, path, status, body) in steps {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "missing {method} {path}"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            let header_end = loop {
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let header = String::from_utf8_lossy(&bytes[..header_end]);
            let first = header.lines().next().unwrap();
            assert!(first.starts_with(method), "{first}");
            assert!(first.contains(path), "expected {path}, got {first}");
            let length = header
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|s| s.parse::<usize>().ok())
                })
                .unwrap_or(0);
            while bytes.len() < header_end + length {
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
            }
            if length > 0 {
                bodies.push(serde_json::from_slice(&bytes[header_end..]).unwrap());
            }
            let body = if status == 204 {
                String::new()
            } else {
                body.to_string()
            };
            write!(socket, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        bodies
    });
    let docker = Docker::connect_with_http(
        &format!("http://{address}"),
        5,
        bollard::API_DEFAULT_VERSION,
    )
    .unwrap();
    (docker, thread)
}

fn inspect(running: bool) -> Value {
    json!({"Id":"old", "Name":"/example", "Image":"sha256:pinned", "State":{"Running":running},
        "Config":{"Image":"mutable:latest", "Env":["OLD=1"], "Volumes":{"/data":{}}},
        "HostConfig":{"RestartPolicy":{"Name":"always"}},
        "Mounts":[{"Type":"volume","Name":"anonymous-existing","Destination":"/data","RW":true}],
        "NetworkSettings":{"Networks":{"app":{"Aliases":["example"]}}}})
}

fn ok(method: &'static str, path: &'static str) -> Step {
    (method, path, 204, Value::Null)
}
fn fail(method: &'static str, path: &'static str) -> Step {
    (method, path, 500, json!({"message":"injected failure"}))
}
fn initial(running: bool) -> Step {
    ("GET", "/containers/old/json", 200, inspect(running))
}
fn create() -> Step {
    (
        "POST",
        "/containers/create",
        201,
        json!({"Id":"new", "Warnings":[]}),
    )
}

#[tokio::test]
async fn preserves_existing_anonymous_volume_and_image_without_starting_stopped_container() {
    let (d, server) = mock(vec![
        initial(false),
        ok("POST", "/containers/old/rename"),
        create(),
        ok("DELETE", "/containers/old"),
    ]);
    assert_eq!(
        recreate(&d, "old", vec!["NEW=2".into()], |_| {})
            .await
            .unwrap(),
        "new"
    );
    let bodies = server.join().unwrap();
    let body = &bodies[0];
    assert_eq!(body["Image"], "sha256:pinned");
    assert_eq!(body["Env"], json!(["NEW=2"]));
    assert_eq!(
        body["HostConfig"]["Mounts"][0]["Source"],
        "anonymous-existing"
    );
    assert_eq!(
        body["NetworkingConfig"]["EndpointsConfig"]["app"]["Aliases"],
        json!(["example"])
    );
}

#[tokio::test]
async fn rename_failure_restarts_original() {
    let (d, server) = mock(vec![
        initial(true),
        ok("POST", "/containers/old/stop"),
        fail("POST", "/containers/old/rename"),
        ok("POST", "/containers/old/start"),
    ]);
    assert!(recreate(&d, "old", vec![], |_| {})
        .await
        .unwrap_err()
        .contains("відновлено"));
    server.join().unwrap();
}

#[tokio::test]
async fn lost_stop_response_checks_and_restores_original() {
    let (d, server) = mock(vec![
        initial(true),
        fail("POST", "/containers/old/stop"),
        initial(false),
        ok("POST", "/containers/old/start"),
    ]);
    assert!(recreate(&d, "old", vec![], |_| {})
        .await
        .unwrap_err()
        .contains("відновлено"));
    server.join().unwrap();
}

#[tokio::test]
async fn create_failure_restores_name_and_running_state() {
    let (d, server) = mock(vec![
        initial(true),
        ok("POST", "/containers/old/stop"),
        ok("POST", "/containers/old/rename"),
        fail("POST", "/containers/create"),
        ok("POST", "/containers/old/rename"),
        ok("POST", "/containers/old/start"),
    ]);
    assert!(recreate(&d, "old", vec![], |_| {})
        .await
        .unwrap_err()
        .contains("відновлено"));
    server.join().unwrap();
}

#[tokio::test]
async fn start_failure_removes_replacement_and_restores_original() {
    let (d, server) = mock(vec![
        initial(true),
        ok("POST", "/containers/old/stop"),
        ok("POST", "/containers/old/rename"),
        create(),
        fail("POST", "/containers/new/start"),
        ok("DELETE", "/containers/new"),
        ok("POST", "/containers/old/rename"),
        ok("POST", "/containers/old/start"),
    ]);
    assert!(recreate(&d, "old", vec![], |_| {})
        .await
        .unwrap_err()
        .contains("відновлено"));
    server.join().unwrap();
}

#[tokio::test]
async fn rollback_failure_does_not_claim_success() {
    let (d, server) = mock(vec![
        initial(true),
        ok("POST", "/containers/old/stop"),
        ok("POST", "/containers/old/rename"),
        fail("POST", "/containers/create"),
        fail("POST", "/containers/old/rename"),
        fail("POST", "/containers/old/start"),
    ]);
    let error = recreate(&d, "old", vec![], |_| {}).await.unwrap_err();
    assert!(error.contains("відновлення не завершено"));
    assert!(!error.contains("відновлено"));
    server.join().unwrap();
}

#[tokio::test]
async fn unhealthy_replacement_restores_original() {
    let (d, server) = mock(vec![
        initial(true),
        ok("POST", "/containers/old/stop"),
        ok("POST", "/containers/old/rename"),
        create(),
        ok("POST", "/containers/new/start"),
        (
            "GET",
            "/containers/new/json",
            200,
            json!({"State":{"Running":true,"Health":{"Status":"unhealthy"}}}),
        ),
        ok("DELETE", "/containers/new"),
        ok("POST", "/containers/old/rename"),
        ok("POST", "/containers/old/start"),
    ]);
    assert!(recreate(&d, "old", vec![], |_| {})
        .await
        .unwrap_err()
        .contains("unhealthy"));
    server.join().unwrap();
}

#[tokio::test]
async fn static_ip_is_rejected_before_any_change() {
    let mut info = inspect(true);
    info["NetworkSettings"]["Networks"]["app"]["IPAMConfig"] = json!({"IPv4Address":"192.0.2.20"});
    let (d, server) = mock(vec![("GET", "/containers/old/json", 200, info)]);
    assert!(recreate(&d, "old", vec![], |_| {})
        .await
        .unwrap_err()
        .contains("статичну"));
    server.join().unwrap();
}

#[tokio::test]
async fn old_container_cleanup_failure_is_reported() {
    let (d, server) = mock(vec![
        initial(false),
        ok("POST", "/containers/old/rename"),
        create(),
        fail("DELETE", "/containers/old"),
    ]);
    let progress = Arc::new(Mutex::new(Vec::new()));
    recreate(&d, "old", vec![], |s| {
        progress.lock().unwrap().push(s.to_owned())
    })
    .await
    .unwrap();
    assert!(progress
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.contains("не видалено")));
    server.join().unwrap();
}

#[tokio::test]
#[ignore = "requires local Docker Desktop and busybox:1.37; creates disposable labelled resources"]
async fn local_docker_preserves_data_network_restart_policy_and_new_env() {
    use bollard::models::{ContainerCreateBody, HostConfig, RestartPolicy, RestartPolicyNameEnum};
    use bollard::query_parameters::{
        CreateContainerOptionsBuilder, InspectContainerOptions, RemoveContainerOptionsBuilder,
        StartContainerOptions,
    };
    let d = Docker::connect_with_local_defaults().unwrap();
    d.ping().await.unwrap();
    let name = format!(
        "prystan-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let created = d
        .create_container(
            Some(CreateContainerOptionsBuilder::new().name(&name).build()),
            ContainerCreateBody {
                image: Some("busybox:1.37".into()),
                cmd: Some(vec!["sh".into(), "-c".into(), "exec sleep 300".into()]),
                env: Some(vec!["PRYSTAN_TEST=before".into()]),
                labels: Some(std::collections::HashMap::from([(
                    "prystan.test".into(),
                    "recreate".into(),
                )])),
                volumes: Some(std::collections::HashMap::from([(
                    "/data".into(),
                    std::collections::HashMap::new(),
                )])),
                host_config: Some(HostConfig {
                    restart_policy: Some(RestartPolicy {
                        name: Some(RestartPolicyNameEnum::ALWAYS),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut replacement = None;
    let mut volume = None;
    let result: Result<(), String> = async {
        d.start_container(&created.id, None::<StartContainerOptions>).await.map_err(|e| e.to_string())?;
        crate::files::exec_capture(&d, &created.id, vec!["sh".into(), "-c".into(), "echo preserved > /data/marker".into()]).await?;
        crate::files::exec_capture(&d, &created.id, vec!["sh".into(), "-c".into(), "echo original > /data/script; chmod 750 /data/script; chown 1001:1002 /data/script".into()]).await?;
        crate::files::write_file(&d, &created.id, "/data/script", b"edited".to_vec(), true).await?;
        let metadata = crate::files::exec_capture(&d, &created.id, vec!["sh".into(), "-c".into(), "stat -c '%a:%u:%g' /data/script; cat /data/script.bak".into()]).await?;
        if metadata.trim() != "750:1001:1002\noriginal" { return Err(format!("file metadata/backup mismatch: {metadata}")); }
        crate::files::exec_capture(&d, &created.id, vec!["sh".into(), "-c".into(), "rm /data/script.bak; mkdir /data/script.bak".into()]).await?;
        if crate::files::write_file(&d, &created.id, "/data/script", b"must not be saved".to_vec(), true).await.is_ok() { return Err("failed backup was accepted".into()); }
        let untouched = crate::files::exec_capture(&d, &created.id, vec!["cat".into(), "/data/script".into()]).await?;
        if untouched != "edited" { return Err("failed backup overwrote original".into()); }
        let before = d.inspect_container(&created.id, None::<InspectContainerOptions>).await.map_err(|e| e.to_string())?;
        volume = before.mounts.as_ref().and_then(|m| m.first()).and_then(|m| m.name.clone());
        let id = recreate(&d, &created.id, vec!["PRYSTAN_TEST=after".into()], |_| {}).await?;
        replacement = Some(id.clone());
        let after = d.inspect_container(&id, None::<InspectContainerOptions>).await.map_err(|e| e.to_string())?;
        if after.mounts.as_ref().and_then(|m| m.first()).and_then(|m| m.name.clone()) != volume { return Err("anonymous volume changed".into()); }
        if after.image != before.image { return Err("image changed".into()); }
        if after.host_config.unwrap().restart_policy.unwrap().name != Some(RestartPolicyNameEnum::ALWAYS) { return Err("restart policy changed".into()); }
        let out = crate::files::exec_capture(&d, &id, vec!["sh".into(), "-c".into(), "cat /data/marker; echo $PRYSTAN_TEST".into()]).await?;
        if out.trim() != "preserved\nafter" { return Err(format!("data/env mismatch: {out}")); }
        Ok(())
    }.await;
    let options = RemoveContainerOptionsBuilder::new()
        .force(true)
        .v(false)
        .build();
    if let Some(id) = replacement {
        d.remove_container(&id, Some(options.clone()))
            .await
            .unwrap();
    }
    let _ = d.remove_container(&created.id, Some(options)).await;
    if let Some(name) = volume {
        d.remove_volume(
            &name,
            None::<bollard::query_parameters::RemoveVolumeOptions>,
        )
        .await
        .unwrap();
    }
    result.unwrap();
}
