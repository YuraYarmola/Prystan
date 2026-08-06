use std::pin::Pin;
use std::sync::Arc;

use base64::Engine;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecResults};
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;

use crate::AppState;

type Input = Pin<Box<dyn tokio::io::AsyncWrite + Send>>;

pub struct TermHandle {
    pub input: Arc<tokio::sync::Mutex<Input>>,
    pub exec_id: String, // порожній для хост-сесій (ssh-процес)
    pub conn: String,
    pub task: tokio::task::JoinHandle<()>,
    pub child: Option<tokio::process::Child>,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    id: String,
    shell: String,
) -> Result<String, String> {
    let docker = state.docker(&conn)?;
    let sh = if shell.is_empty() { "/bin/sh".into() } else { shell };

    let exec = docker
        .create_exec(
            &id,
            CreateExecOptions {
                cmd: Some(vec![sh]),
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(true),
                env: Some(vec!["TERM=xterm-256color".to_string()]),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    let start = docker
        .start_exec(&exec.id, None)
        .await
        .map_err(|e| e.to_string())?;

    let (mut output, input) = match start {
        StartExecResults::Attached { output, input } => (output, input),
        StartExecResults::Detached => return Err("exec запустився detached".into()),
    };

    let sid = format!("t{}", exec.id.chars().take(12).collect::<String>());
    let sid_c = sid.clone();
    let app_c = app.clone();

    let task = tokio::spawn(async move {
        while let Some(chunk) = output.next().await {
            match chunk {
                Ok(out) => {
                    let data = b64().encode(out.into_bytes());
                    let _ = app_c.emit(
                        "term-output",
                        serde_json::json!({ "sid": sid_c, "data_b64": data }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_c.emit("term-closed", serde_json::json!({ "sid": sid_c }));
    });

    state.terms.lock().unwrap().insert(
        sid.clone(),
        TermHandle {
            input: Arc::new(tokio::sync::Mutex::new(input)),
            exec_id: exec.id,
            conn,
            task,
            child: None,
        },
    );
    Ok(sid)
}

#[tauri::command]
pub async fn term_input(
    state: State<'_, AppState>,
    sid: String,
    data_b64: String,
) -> Result<(), String> {
    let input = state
        .terms
        .lock()
        .unwrap()
        .get(&sid)
        .map(|t| t.input.clone())
        .ok_or("сесію терміналу не знайдено")?;
    let bytes = b64().decode(data_b64).map_err(|e| e.to_string())?;
    let mut guard = input.lock().await;
    guard.write_all(&bytes).await.map_err(|e| e.to_string())?;
    guard.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn term_resize(
    state: State<'_, AppState>,
    sid: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (conn, exec_id) = state
        .terms
        .lock()
        .unwrap()
        .get(&sid)
        .map(|t| (t.conn.clone(), t.exec_id.clone()))
        .ok_or("сесію терміналу не знайдено")?;
    if exec_id.is_empty() {
        return Ok(()); // хост-сесія: розмір задано при відкритті
    }
    let docker = state.docker(&conn)?;
    docker
        .resize_exec(
            &exec_id,
            ResizeExecOptions {
                height: rows,
                width: cols,
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(state: State<'_, AppState>, sid: String) {
    if let Some(mut t) = state.terms.lock().unwrap().remove(&sid) {
        t.task.abort();
        if let Some(c) = t.child.as_mut() {
            let _ = c.start_kill();
        }
    }
}
