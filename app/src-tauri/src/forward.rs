use std::process::Stdio;

use serde::Serialize;
use tauri::State;

use crate::AppState;

pub struct ForwardHandle {
    pub child: Option<tokio::process::Child>,
    pub local_port: u16,
    pub remote: String,
    pub label: String,
}

#[derive(Serialize)]
pub struct ForwardRow {
    key: String,
    local_port: u16,
    remote: String,
    label: String,
    url: String,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// A5 — прокинути порт віддаленого контейнера на localhost.
/// Для SSH — `ssh -L`. Для локального демона порт уже доступний,
/// тому просто повертаємо наявну адресу без тунелю.
#[tauri::command]
pub async fn forward_start(
    state: State<'_, AppState>,
    conn: String,
    remote_host: String, // зазвичай 127.0.0.1 на сервері
    remote_port: u16,
    label: String,
) -> Result<ForwardRow, String> {
    let p = crate::host::get_profile(&state, &conn)?;
    let key = format!("{conn}:{remote_host}:{remote_port}");

    if let Some(f) = state.forwards.lock().unwrap().get(&key) {
        return Ok(ForwardRow {
            key: key.clone(),
            local_port: f.local_port,
            remote: f.remote.clone(),
            label: f.label.clone(),
            url: format!("http://127.0.0.1:{}", f.local_port),
        });
    }

    let (child, local_port) = if p.kind == "ssh" {
        let local_port = free_port();
        if local_port == 0 {
            return Err("не вдалося зайняти локальний порт".into());
        }
        let mut cmd = tokio::process::Command::new("ssh");
        cmd.args([
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=20",
            "-N",
            "-L", &format!("127.0.0.1:{local_port}:{remote_host}:{remote_port}"),
            "-p", &p.port.max(22).to_string(),
        ]);
        if !p.key_path.is_empty() {
            cmd.args(["-i", &p.key_path]);
        }
        cmd.arg(format!("{}@{}", p.user, p.host));
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("ssh -L: {e}"))?;
        crate::procguard::guard(child.id().unwrap_or(0));

        // чекаємо, поки порт відкриється
        let mut ok = false;
        for _ in 0..40 {
            if tokio::net::TcpStream::connect(("127.0.0.1", local_port)).await.is_ok() {
                ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        if !ok {
            let mut c = child;
            let _ = c.start_kill();
            return Err("тунель не піднявся за 6 с".into());
        }
        (Some(child), local_port)
    } else {
        // локальний демон: порт уже опублікований на хості
        (None, remote_port)
    };

    let row = ForwardRow {
        key: key.clone(),
        local_port,
        remote: format!("{remote_host}:{remote_port}"),
        label: label.clone(),
        url: format!("http://127.0.0.1:{local_port}"),
    };
    state.forwards.lock().unwrap().insert(
        key,
        ForwardHandle {
            child,
            local_port,
            remote: row.remote.clone(),
            label,
        },
    );
    Ok(row)
}

#[tauri::command]
pub fn forward_stop(state: State<'_, AppState>, key: String) {
    if let Some(mut f) = state.forwards.lock().unwrap().remove(&key) {
        if let Some(c) = f.child.as_mut() {
            let _ = c.start_kill();
        }
    }
}

#[tauri::command]
pub fn forward_list(state: State<'_, AppState>) -> Vec<ForwardRow> {
    state
        .forwards
        .lock()
        .unwrap()
        .iter()
        .map(|(k, f)| ForwardRow {
            key: k.clone(),
            local_port: f.local_port,
            remote: f.remote.clone(),
            label: f.label.clone(),
            url: format!("http://127.0.0.1:{}", f.local_port),
        })
        .collect()
}

pub fn kill_forwards_for(state: &AppState, conn: &str) {
    let mut fw = state.forwards.lock().unwrap();
    let keys: Vec<String> = fw
        .keys()
        .filter(|k| k.starts_with(&format!("{conn}:")))
        .cloned()
        .collect();
    for k in keys {
        if let Some(mut f) = fw.remove(&k) {
            if let Some(c) = f.child.as_mut() {
                let _ = c.start_kill();
            }
        }
    }
}
