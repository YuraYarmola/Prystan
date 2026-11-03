use std::process::Stdio;
use std::time::Duration;

fn next_generation() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!("{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

use serde::Serialize;
use tauri::State;
use tokio::process::{Child, Command};

use crate::{AppState, Profile};

pub struct ForwardHandle {
    pub child: Option<Child>,
    pub row: ForwardRow,
    generation: String,
}
impl Drop for ForwardHandle {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Some(pid) = child.id() {
                crate::procguard::release(pid);
            }
            let _ = child.start_kill();
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ForwardRow {
    pub key: String,
    pub conn: String,
    pub server_name: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub remote: String,
    pub label: String,
    pub url: String,
    pub status: String,
    pub error: String,
    pub ssh_command: String,
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && (host.parse::<std::net::IpAddr>().is_ok()
            || (!host.starts_with('-')
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))))
}
fn validate(p: &Profile, host: &str, port: u16, label: &str) -> Result<(), String> {
    if p.kind != "ssh" {
        return Err("Choose an SSH server to create a tunnel".into());
    }
    if !valid_host(host) || port == 0 {
        return Err("Enter a valid destination host and port (1–65535)".into());
    }
    if !valid_host(&p.host)
        || p.user.is_empty()
        || p.user.starts_with('-')
        || !p
            .user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Invalid SSH server address or user".into());
    }
    if label.len() > 240 || label.chars().any(char::is_control) {
        return Err("Tunnel name is too long or contains control characters".into());
    }
    Ok(())
}
fn ssh_args(p: &Profile, host: &str, port: u16, local: u16) -> Vec<String> {
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let mut args: Vec<String> = [
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(format!("127.0.0.1:{local}:{host}:{port}"));
    args.extend([
        "-p".into(),
        if p.port == 0 { 22 } else { p.port }.to_string(),
    ]);
    if !p.key_path.is_empty() {
        args.extend(["-i".into(), p.key_path.clone()]);
    }
    args.push(format!("{}@{}", p.user, p.host));
    args
}
fn command_text(args: &[String]) -> String {
    let quote = |s: &String| {
        #[cfg(windows)]
        let escaped = s.replace('\'', "''");
        #[cfg(not(windows))]
        let escaped = s.replace('\'', "'\\''");
        format!("'{escaped}'")
    };
    format!(
        "ssh {}",
        args.iter().map(quote).collect::<Vec<_>>().join(" ")
    )
}
fn probe_process(f: &mut ForwardHandle) {
    let result = f.child.as_mut().map(|c| {
        let pid = c.id();
        (pid, c.try_wait())
    });
    if let Some((pid, result)) = result {
        let error = match result {
            Ok(None) => return,
            Ok(Some(code)) => format!("SSH connection closed ({code}). Check SSH access and the local port, then reconnect."),
            Err(e) => format!("Cannot inspect SSH process: {e}"),
        };
        if let Some(pid) = pid {
            crate::procguard::release(pid);
        }
        if let Some(mut child) = f.child.take() {
            let _ = child.start_kill();
        }
        f.row.status = "failed".into();
        f.row.error = error;
    }
}
fn fail(state: &AppState, key: &str, generation: &str, message: &str) {
    if let Some(f) = state.forwards.lock().unwrap().get_mut(key) {
        if f.generation != generation {
            return;
        }
        if let Some(mut child) = f.child.take() {
            if let Some(pid) = child.id() {
                crate::procguard::release(pid);
            }
            let _ = child.start_kill();
        }
        f.row.status = "failed".into();
        f.row.error = message.into();
    }
}

#[tauri::command]
pub async fn forward_start(
    state: State<'_, AppState>,
    conn: String,
    remote_host: String,
    remote_port: u16,
    label: String,
    local_port: Option<u16>,
) -> Result<ForwardRow, String> {
    let p = crate::host::get_profile(&state, &conn)?;
    start(
        &state,
        &p,
        &conn,
        remote_host,
        remote_port,
        label,
        local_port,
        &[],
    )
    .await
}
async fn start(
    state: &AppState,
    p: &Profile,
    conn: &str,
    remote_host: String,
    remote_port: u16,
    label: String,
    local_port: Option<u16>,
    client_options: &[String],
) -> Result<ForwardRow, String> {
    validate(p, &remote_host, remote_port, &label)?;
    let key = format!("{conn}|{remote_host}|{remote_port}");
    let generation = next_generation();
    {
        let mut forwards = state.forwards.lock().unwrap();
        if let Some(f) = forwards.get_mut(&key) {
            probe_process(f);
            if f.row.status == "starting" {
                return Err("This tunnel is already connecting".into());
            }
            if f.row.status == "active" {
                if local_port.unwrap_or(0) != 0 && local_port != Some(f.row.local_port) {
                    return Err(
                        "This destination already has an active tunnel on another local port"
                            .into(),
                    );
                }
                return Ok(f.row.clone());
            }
        }
        // Перевіряємо зайнятість порту до запуску SSH; SSH повторно перевірить bind.
        let listener = std::net::TcpListener::bind(("127.0.0.1", local_port.unwrap_or(0)))
            .map_err(|_| {
                "Local port is busy or unavailable; choose another port or use automatic selection"
            })?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let mut args = ssh_args(p, &remote_host, remote_port, port);
        args.splice(0..0, client_options.iter().cloned());
        let row = ForwardRow {
            key: key.clone(),
            conn: conn.into(),
            server_name: p.name.clone(),
            local_port: port,
            remote_host: remote_host.clone(),
            remote_port,
            remote: format!("{remote_host}:{remote_port}"),
            label,
            url: format!("http://127.0.0.1:{port}"),
            status: "starting".into(),
            error: String::new(),
            ssh_command: command_text(&args),
        };
        let mut cmd = Command::new("ssh");
        cmd.args(&args)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        drop(listener);
        let mut handle = ForwardHandle {
            child: None,
            row,
            generation: generation.clone(),
        };
        match cmd.spawn() {
            Ok(child) => {
                crate::procguard::guard(child.id().unwrap_or(0));
                handle.child = Some(child);
            }
            Err(e) => {
                handle.row.status = "failed".into();
                handle.row.error = format!("Cannot start SSH: {e}");
                let error = handle.row.error.clone();
                forwards.insert(key, handle);
                return Err(error);
            }
        }
        forwards.insert(key.clone(), handle);
    }
    // Процес уже в registry: зупинка/відключення можуть скасувати цей запуск.
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        {
            let mut forwards = state.forwards.lock().unwrap();
            let f = forwards
                .get_mut(&key)
                .filter(|f| f.generation == generation)
                .ok_or("Tunnel start was cancelled")?;
            probe_process(f);
            if f.row.status != "starting" {
                return Err(if f.row.error.is_empty() {
                    "Tunnel start was cancelled".into()
                } else {
                    f.row.error.clone()
                });
            }
        }
        if tokio::time::timeout(
            Duration::from_millis(200),
            tokio::net::TcpStream::connect(("127.0.0.1", current_port(state, &key, &generation)?)),
        )
        .await
        .is_ok_and(|r| r.is_ok())
        {
            let mut forwards = state.forwards.lock().unwrap();
            let f = forwards
                .get_mut(&key)
                .filter(|f| f.generation == generation)
                .ok_or("Tunnel start was cancelled")?;
            probe_process(f);
            if f.row.status == "starting" {
                f.row.status = "active".into();
                return Ok(f.row.clone());
            }
            return Err(f.row.error.clone());
        }
    }
    let error = "SSH tunnel did not open within 9 seconds. Check server access and authentication.";
    fail(state, &key, &generation, error);
    Err(error.into())
}
fn current_port(state: &AppState, key: &str, generation: &str) -> Result<u16, String> {
    state
        .forwards
        .lock()
        .unwrap()
        .get(key)
        .filter(|f| f.generation == generation && f.row.status == "starting")
        .map(|f| f.row.local_port)
        .ok_or("Tunnel start was cancelled".into())
}

#[tauri::command]
pub fn forward_stop(state: State<'_, AppState>, key: String) {
    state.forwards.lock().unwrap().remove(&key);
}
#[tauri::command]
pub fn forward_list(state: State<'_, AppState>) -> Vec<ForwardRow> {
    list(&state)
}
fn list(state: &AppState) -> Vec<ForwardRow> {
    let mut forwards = state.forwards.lock().unwrap();
    for f in forwards.values_mut() {
        probe_process(f);
    }
    let mut rows: Vec<_> = forwards.values().map(|f| f.row.clone()).collect();
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    rows
}
pub fn kill_forwards_for(state: &AppState, conn: &str) {
    for f in state
        .forwards
        .lock()
        .unwrap()
        .values_mut()
        .filter(|f| f.row.conn == conn)
    {
        if let Some(mut child) = f.child.take() {
            if let Some(pid) = child.id() {
                crate::procguard::release(pid);
            }
            let _ = child.start_kill();
        }
        f.row.status = "stopped".into();
        f.row.error = "Server disconnected; start the tunnel again when needed".into();
    }
}

#[cfg(test)]
#[path = "forward_tests.rs"]
mod tests;
