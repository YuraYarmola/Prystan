use super::*;

fn profile() -> Profile {
    Profile {
        id: "fixture".into(),
        name: "Fixture SSH".into(),
        kind: "ssh".into(),
        host: "127.0.0.1".into(),
        user: "tester".into(),
        port: 2222,
        readonly: true,
        ..Default::default()
    }
}
fn row() -> ForwardRow {
    ForwardRow {
        key: "fixture|localhost|8081".into(),
        conn: "fixture".into(),
        server_name: "Fixture SSH".into(),
        local_port: 18081,
        remote_host: "localhost".into(),
        remote_port: 8081,
        remote: "localhost:8081".into(),
        label: "Adminer".into(),
        url: "http://127.0.0.1:18081".into(),
        status: "active".into(),
        error: String::new(),
        ssh_command: String::new(),
    }
}
#[test]
fn arguments_bind_loopback_and_preserve_ports_and_ipv6() {
    let mut p = profile();
    p.port = 1;
    p.key_path = "C:/keys/a key's file".into();
    let args = ssh_args(&p, "::1", 8081, 18081);
    assert!(args
        .windows(2)
        .any(|a| a == ["-L", "127.0.0.1:18081:[::1]:8081"]));
    assert!(args.windows(2).any(|a| a == ["-p", "1"]));
    assert!(args.windows(2).any(|a| a == ["-i", "C:/keys/a key's file"]));
    assert!(!args.contains(&"-R".to_string()));
    assert!(args.contains(&"ExitOnForwardFailure=yes".into()));
    assert!(command_text(&args).contains("127.0.0.1:18081:[::1]:8081"));
}
#[test]
fn invalid_destinations_and_non_ssh_profiles_are_rejected() {
    for host in [
        "-oProxyCommand=evil",
        "host name",
        "x\n-y",
        "x/evil",
        "[::1]",
        "",
    ] {
        assert!(validate(&profile(), host, 80, "x").is_err(), "{host}");
    }
    assert!(validate(&profile(), "::1", 80, "x").is_ok());
    assert!(validate(&profile(), "db.internal", 0, "x").is_err());
    let mut p = profile();
    p.kind = "tcp".into();
    assert!(validate(&p, "localhost", 80, "x").is_err());
}
#[tokio::test]
async fn exited_children_are_reported_as_failed_and_disconnect_is_scoped() {
    let store = crate::database_profiles::test_store();
    let state = &store.state;
    #[cfg(windows)]
    let mut command = {
        let mut c = Command::new("cmd");
        c.args(["/C", "exit 7"]);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut c = Command::new("sh");
        c.args(["-c", "exit 7"]);
        c
    };
    let child = command.kill_on_drop(true).spawn().unwrap();
    state.forwards.lock().unwrap().insert(
        "a".into(),
        ForwardHandle {
            child: Some(child),
            row: row(),
            generation: "a".into(),
        },
    );
    for _ in 0..50 {
        if list(state)[0].status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(list(state)[0].status, "failed");
    assert!(!list(state)[0].error.is_empty());
    let mut other = row();
    other.conn = "other".into();
    other.key = "b".into();
    state.forwards.lock().unwrap().insert(
        "b".into(),
        ForwardHandle {
            child: None,
            row: other,
            generation: "b".into(),
        },
    );
    kill_forwards_for(state, "fixture");
    assert_eq!(state.forwards.lock().unwrap()["a"].row.status, "stopped");
    assert_eq!(state.forwards.lock().unwrap()["b"].row.status, "active");
}

struct Fixture {
    id: String,
    token: String,
    dir: std::path::PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let output = std::process::Command::new("docker")
            .args([
                "inspect",
                "--format",
                "{{index .Config.Labels \"prystan.tunnel-test\"}}",
                &self.id,
            ])
            .output();
        if output.is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == self.token
        }) {
            let _ = std::process::Command::new("docker")
                .args(["rm", "-f", "-v", &self.id])
                .output();
        }
        // Лише перелічені файли нашої тимчасової теки, без recursive remove.
        for name in [
            "key",
            "key.pub",
            "known_hosts",
            "known_hosts.old",
            "ssh_config",
        ] {
            let _ = std::fs::remove_file(self.dir.join(name));
        }
        let _ = std::fs::remove_dir(&self.dir);
    }
}
fn docker(args: &[&str]) -> std::process::Output {
    std::process::Command::new("docker")
        .args(args)
        .output()
        .unwrap()
}
async fn response(port: u16) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let work = async {
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        socket
            .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut b = Vec::new();
        socket.read_to_end(&mut b).await.unwrap();
        String::from_utf8_lossy(&b).into_owned()
    };
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .unwrap()
}
#[tokio::test]
#[ignore = "requires local Docker, ssh-keygen and lscr.io/linuxserver/openssh-server:latest; only labelled disposable resources"]
async fn local_ssh_tunnel_transfers_data_detects_exit_and_cancels_start() {
    let token = format!("{}-{}", next_generation(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let dir = std::env::temp_dir().join(format!("prystan-tunnel-test-{token}"));
    std::fs::create_dir(&dir).unwrap();
    let key = dir.join("key");
    let out = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let public = std::fs::read_to_string(dir.join("key.pub")).unwrap();
    let name = format!("prystan-tunnel-test-{token}");
    let out = docker(&[
        "run",
        "-d",
        "--name",
        &name,
        "--label",
        &format!("prystan.tunnel-test={token}"),
        "-p",
        "127.0.0.1::2222",
        "-e",
        "USER_NAME=tester",
        "-e",
        "PASSWORD_ACCESS=false",
        "-e",
        &format!("PUBLIC_KEY={}", public.trim()),
        "lscr.io/linuxserver/openssh-server:latest",
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let fixture = Fixture {
        id: String::from_utf8_lossy(&out.stdout).trim().into(),
        token,
        dir,
    };
    for i in 0..60 {
        let out = docker(&[
            "exec",
            &fixture.id,
            "sh",
            "-c",
            "test -f /config/.ssh/authorized_keys && pgrep sshd >/dev/null",
        ]);
        if out.status.success() {
            break;
        }
        assert!(i < 59, "SSH fixture not ready");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let out=docker(&["exec",&fixture.id,"sh","-c","apk add --no-cache busybox-extras && sed -i 's/^AllowTcpForwarding .*/AllowTcpForwarding yes/' /config/sshd/sshd_config && pkill -HUP sshd && mkdir -p /tmp/prystan-http && printf prystan-tunnel-fixture > /tmp/prystan-http/index.html && busybox-extras httpd -p 8081 -h /tmp/prystan-http"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let port = docker(&[
        "inspect",
        "--format",
        "{{(index (index .NetworkSettings.Ports \"2222/tcp\") 0).HostPort}}",
        &fixture.id,
    ]);
    let mut p = profile();
    p.port = String::from_utf8_lossy(&port.stdout)
        .trim()
        .parse()
        .unwrap();
    p.key_path = key.to_string_lossy().into_owned();
    let config = fixture.dir.join("ssh_config");
    std::fs::write(&config, "").unwrap();
    let options = vec![
        "-F".into(),
        config.to_string_lossy().into_owned(),
        "-o".into(),
        format!(
            "UserKnownHostsFile={}",
            fixture.dir.join("known_hosts").display()
        ),
        "-o".into(),
        "GlobalKnownHostsFile=none".into(),
        "-o".into(),
        "IdentityAgent=none".into(),
        "-o".into(),
        "IdentitiesOnly=yes".into(),
    ];
    let store = crate::database_profiles::test_store();
    let state = &store.state;
    let r = start(
        state,
        &p,
        "fixture",
        "127.0.0.1".into(),
        8081,
        "Fixture HTTP".into(),
        None,
        &options,
    )
    .await
    .unwrap();
    assert_eq!(r.status, "active");
    assert!(response(r.local_port)
        .await
        .contains("prystan-tunnel-fixture"));
    let duplicate = start(
        state,
        &p,
        "fixture",
        "127.0.0.1".into(),
        8081,
        "Fixture HTTP".into(),
        None,
        &options,
    )
    .await
    .unwrap();
    assert_eq!(duplicate.local_port, r.local_port);
    assert_eq!(list(state).len(), 1);
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = busy.local_addr().unwrap().port();
    assert!(start(
        state,
        &p,
        "fixture",
        "127.0.0.1".into(),
        8082,
        "Busy port".into(),
        Some(port),
        &options
    )
    .await
    .is_err());
    assert_eq!(list(state).len(), 1);
    state
        .forwards
        .lock()
        .unwrap()
        .get_mut(&r.key)
        .unwrap()
        .child
        .as_mut()
        .unwrap()
        .start_kill()
        .unwrap();
    for _ in 0..50 {
        if list(state)[0].status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(list(state)[0].status, "failed");
    let r = start(
        state,
        &p,
        "fixture",
        "127.0.0.1".into(),
        8081,
        "Fixture HTTP".into(),
        Some(r.local_port),
        &options,
    )
    .await
    .unwrap();
    assert!(response(r.local_port)
        .await
        .contains("prystan-tunnel-fixture"));
    kill_forwards_for(state, "fixture");
    assert_eq!(list(state)[0].status, "stopped");
    state.forwards.lock().unwrap().clear();
    // TCP endpoint, що не відповідає як SSH: старт точно перебуває в очікуванні.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut waiting = p.clone();
    waiting.port = listener.local_addr().unwrap().port();
    let work = start(
        state,
        &waiting,
        "cancel",
        "127.0.0.1".into(),
        8081,
        "Cancel fixture".into(),
        None,
        &options,
    );
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let mut map = state.forwards.lock().unwrap();
        assert!(map.values().any(|f| f.row.status == "starting"));
        map.clear();
    };
    let (result, _) = tokio::join!(work, cancel);
    assert!(result.is_err());
    assert!(list(state).is_empty());
    eprintln!("PASS: isolated SSH HTTP transfer, readonly profile, deduplication, busy port, child exit, reconnect, disconnect and cancellation");
}
