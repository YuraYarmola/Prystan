#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod containers;
mod files;
mod forward;
mod host;
mod journal;
mod logs;
mod notify;
mod procguard;
mod resources;
mod security;
mod term;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bollard::models::EventMessageTypeEnum;
use bollard::query_parameters::EventsOptionsBuilder;
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct ConnEntry {
    pub docker: Docker,
    pub tunnel: Option<Child>,
    pub events_task: tauri::async_runtime::JoinHandle<()>,
}

pub struct AppState {
    pub started: Instant,
    pub conns: Mutex<HashMap<String, ConnEntry>>,
    pub logs_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub stats_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub terms: Mutex<HashMap<String, term::TermHandle>>,
    pub monitors: Mutex<HashMap<String, host::MonitorHandle>>,
    pub agents: Mutex<HashMap<String, host::AgentHandle>>,
    pub ptys: Mutex<HashMap<String, host::PtyHandle>>,
    pub pty_conns: Mutex<HashMap<String, String>>,
    pub forwards: Mutex<HashMap<String, forward::ForwardHandle>>,
    pub multi_tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub profiles_path: PathBuf,
}

impl AppState {
    pub fn docker(&self, conn: &str) -> Result<Docker, String> {
        self.conns
            .lock()
            .unwrap()
            .get(conn)
            .map(|c| c.docker.clone())
            .ok_or_else(|| format!("немає активного підключення '{conn}'"))
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub kind: String, // local | tcp | ssh
    #[serde(default)]
    pub host: String, // tcp: host, ssh: host
    #[serde(default)]
    pub port: u16, // tcp: api port, ssh: ssh port
    #[serde(default)]
    pub user: String, // ssh user
    #[serde(default)]
    pub key_path: String, // ssh identity file (optional)
    #[serde(default)]
    pub readonly: bool, // C8: заборона змінюючих дій (прод)
    /// Бажаний стан: true — підключатися на старті й тримати з'єднання,
    /// false — користувач відключив вручну, не піднімати само.
    #[serde(default)]
    pub autoconnect: bool,
}

#[derive(Serialize)]
pub struct EngineInfo {
    version: String,
    api_version: String,
    os: String,
    startup_ms: u128,
}

/* ── profiles ─────────────────────────────────────────── */

pub fn load_profiles(path: &PathBuf) -> Vec<Profile> {
    let mut list: Vec<Profile> = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if !list.iter().any(|p| p.id == "local") {
        list.insert(
            0,
            Profile {
                id: "local".into(),
                name: "Локальний Docker".into(),
                kind: "local".into(),
                ..Default::default()
            },
        );
    }
    list
}

fn save_profiles_file(path: &PathBuf, list: &[Profile]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(list).unwrap());
}

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Vec<Profile> {
    load_profiles(&state.profiles_path)
}

/// Перемкнути прапорець autoconnect, не чіпаючи решту полів профілю.
#[tauri::command]
fn set_autoconnect(state: State<'_, AppState>, id: String, on: bool) -> Vec<Profile> {
    let mut list = load_profiles(&state.profiles_path);
    if let Some(p) = list.iter_mut().find(|p| p.id == id) {
        p.autoconnect = on;
    }
    save_profiles_file(&state.profiles_path, &list);
    list
}

#[tauri::command]
fn save_profile(state: State<'_, AppState>, mut profile: Profile) -> Vec<Profile> {
    let mut list = load_profiles(&state.profiles_path);
    if profile.id.is_empty() {
        profile.id = format!(
            "p{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
    }
    if let Some(ex) = list.iter_mut().find(|p| p.id == profile.id) {
        *ex = profile;
    } else {
        list.push(profile);
    }
    save_profiles_file(&state.profiles_path, &list);
    list
}

#[tauri::command]
fn delete_profile(state: State<'_, AppState>, id: String) -> Vec<Profile> {
    let mut list = load_profiles(&state.profiles_path);
    list.retain(|p| p.id != id || p.id == "local");
    save_profiles_file(&state.profiles_path, &list);
    list
}

/* ── connections ──────────────────────────────────────── */

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(23750)
}

/// Тека налаштувань за конвенцією кожної ОС.
fn app_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("Prystan")
    }
    #[cfg(target_os = "macos")]
    {
        files::home_dir()
            .join("Library")
            .join("Application Support")
            .join("Prystan")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| files::home_dir().join(".config"))
            .join("prystan")
    }
}

fn spawn_ssh_tunnel(p: &Profile, local_port: u16) -> Result<Child, String> {
    let mut cmd = std::process::Command::new("ssh");
    cmd.args([
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15",
        "-N",
        "-L", &format!("127.0.0.1:{local_port}:/var/run/docker.sock"),
        "-p", &p.port.max(22).to_string(),
    ]);
    if !p.key_path.is_empty() {
        cmd.args(["-i", &p.key_path]);
    }
    cmd.arg(format!("{}@{}", p.user, p.host));
    // на Windows ховаємо консольне вікно дочірнього ssh
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.stderr(std::process::Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("не вдалося запустити ssh: {e}"))?;
    procguard::guard(child.id());
    Ok(child)
}

async fn wait_port(port: u16, mut tunnel: Option<&mut Child>) -> Result<(), String> {
    for _ in 0..40 {
        if let Some(t) = tunnel.as_deref_mut() {
            if let Ok(Some(status)) = t.try_wait() {
                let mut err = String::new();
                if let Some(mut se) = t.stderr.take() {
                    use std::io::Read;
                    let _ = se.read_to_string(&mut err);
                }
                return Err(format!(
                    "ssh-тунель завершився ({status}): {}",
                    err.lines().last().unwrap_or("невідома помилка")
                ));
            }
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("тунель не відкрив порт за 10 с".into())
}

#[tauri::command]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<EngineInfo, String> {
    let profile = load_profiles(&state.profiles_path)
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or("профіль не знайдено")?;

    disconnect_inner(&state, &profile_id);

    let (docker, tunnel) = match profile.kind.as_str() {
        "local" => (
            Docker::connect_with_local_defaults().map_err(|e| e.to_string())?,
            None,
        ),
        "tcp" => {
            let url = format!("tcp://{}:{}", profile.host, profile.port);
            (
                Docker::connect_with_http(&url, 3600 * 24, API_DEFAULT_VERSION)
                    .map_err(|e| e.to_string())?,
                None,
            )
        }
        "ssh" => {
            let port = free_port();
            let mut child = spawn_ssh_tunnel(&profile, port)?;
            wait_port(port, Some(&mut child)).await.map_err(|e| {
                let _ = child.kill();
                e
            })?;
            let url = format!("tcp://127.0.0.1:{port}");
            (
                Docker::connect_with_http(&url, 3600 * 24, API_DEFAULT_VERSION)
                    .map_err(|e| e.to_string())?,
                Some(child),
            )
        }
        k => return Err(format!("невідомий тип підключення: {k}")),
    };

    let v = tokio::time::timeout(Duration::from_secs(15), docker.version())
        .await
        .map_err(|_| "демон не відповів за 15 с".to_string())?
        .map_err(|e| format!("Docker не відповідає: {e}"))?;

    let events_task = spawn_events_stream(app, docker.clone(), profile_id.clone());
    // прогріваємо файловий ssh-агент одразу, щоб перша операція була миттєвою
    if profile.kind == "ssh" {
        if let Ok(a) = host::spawn_agent(&profile) {
            state.agents.lock().unwrap().insert(profile_id.clone(), a);
        }
    }
    state.conns.lock().unwrap().insert(
        profile_id,
        ConnEntry {
            docker,
            tunnel,
            events_task,
        },
    );

    Ok(EngineInfo {
        version: v.version.unwrap_or_default(),
        api_version: v.api_version.unwrap_or_default(),
        os: format!(
            "{} {}",
            v.os.unwrap_or_default(),
            v.arch.unwrap_or_default()
        ),
        startup_ms: state.started.elapsed().as_millis(),
    })
}

fn disconnect_inner(state: &AppState, id: &str) {
    if let Some(mut e) = state.conns.lock().unwrap().remove(id) {
        e.events_task.abort();
        if let Some(t) = e.tunnel.as_mut() {
            procguard::release(t.id());
            let _ = t.kill();
        }
    }
    if let Some(mut m) = state.monitors.lock().unwrap().remove(id) {
        m.task.abort();
        let _ = m.child.start_kill();
    }
    host::kill_agent(state, id);
    forward::kill_forwards_for(state, id);
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>, id: String) {
    disconnect_inner(&state, &id);
}

/// Відкрити URL у системному браузері (без зовнішніх плагінів).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("дозволені лише http(s) посилання".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| format!("не вдалося відкрити браузер: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("не вдалося відкрити браузер: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("не вдалося відкрити браузер: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn active_connections(state: State<'_, AppState>) -> Vec<String> {
    state.conns.lock().unwrap().keys().cloned().collect()
}

/* ── docker events push ───────────────────────────────── */

fn spawn_events_stream(
    app: AppHandle,
    docker: Docker,
    conn: String,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            let opts = EventsOptionsBuilder::new().build();
            let mut stream = docker.events(Some(opts));
            while let Some(ev) = stream.next().await {
                match ev {
                    Ok(msg) => {
                        if matches!(msg.typ, Some(EventMessageTypeEnum::CONTAINER)) {
                            let _ = app.emit(
                                "docker-event",
                                serde_json::json!({
                                    "conn": conn,
                                    "action": msg.action,
                                    "id": msg.actor.and_then(|a| a.id),
                                }),
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit(
                "conn-state",
                serde_json::json!({ "conn": conn, "up": false }),
            );
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    })
}

fn main() {
    let started = Instant::now();
    let data_dir = app_data_dir();
    // одноразова міграція налаштувань зі старої назви — щоб не втратити профілі
    #[cfg(windows)]
    {
        let legacy = PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("DockerAdmin");
        if !data_dir.exists() && legacy.exists() {
            let _ = std::fs::rename(&legacy, &data_dir);
        }
    }
    let profiles_path = data_dir.join("profiles.json");

    // прибираємо ssh-процеси, що лишились від аварійного завершення,
    // і беремо всі майбутні під нагляд ОС
    let swept = procguard::init(&data_dir);
    if swept > 0 {
        eprintln!("prystan: прибрано осиротілих ssh-процесів: {swept}");
    }

    tauri::Builder::default()
        .manage(AppState {
            started,
            conns: Mutex::new(HashMap::new()),
            logs_task: Mutex::new(None),
            stats_task: Mutex::new(None),
            terms: Mutex::new(HashMap::new()),
            monitors: Mutex::new(HashMap::new()),
            agents: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
            pty_conns: Mutex::new(HashMap::new()),
            forwards: Mutex::new(HashMap::new()),
            multi_tasks: Mutex::new(Vec::new()),
            profiles_path,
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            save_profile,
            set_autoconnect,
            delete_profile,
            connect,
            disconnect,
            active_connections,
            open_url,
            containers::list_containers,
            containers::container_action,
            containers::inspect_container,
            containers::start_logs,
            containers::stop_logs,
            containers::start_stats,
            resources::list_images,
            resources::remove_image,
            resources::pull_image,
            resources::list_volumes,
            resources::remove_volume,
            resources::list_networks,
            resources::remove_network,
            resources::prune,
            files::fs_list,
            files::fs_read,
            files::fs_write,
            files::fs_download,
            files::fs_upload,
            files::fs_mkdir,
            files::fs_delete,
            term::term_open,
            term::term_input,
            term::term_resize,
            term::term_close,
            host::host_kill,
            host::host_fs_list,
            host::host_fs_read,
            host::host_fs_write,
            host::host_fs_download,
            host::host_fs_upload,
            host::host_fs_mkdir,
            host::host_fs_delete,
            host::host_fs_rename,
            host::host_fs_chmod,
            host::host_term_open,
            host::host_term_input,
            host::host_term_resize,
            host::host_term_close,
            host::host_monitor_start,
            host::host_monitor_stop,
            host::compose_cmd,
            files::fs_rename,
            files::fs_chmod,
            files::fs_create,
            files::fs_copy,
            host::host_fs_create,
            host::host_fs_copy,
            logs::logs_search,
            logs::logs_multi_start,
            logs::logs_multi_stop,
            forward::forward_start,
            forward::forward_stop,
            forward::forward_list,
            resources::system_df,
            resources::create_container,
            resources::recreate_with_env,
            resources::build_image,
            resources::import_contexts,
            resources::image_history,
            resources::container_diff,
            resources::update_resources,
            resources::registry_save,
            resources::registry_list,
            resources::registry_delete,
            resources::push_image,
            security::scan_image,
            journal::journal_list,
            journal::journal_clear,
            journal::journal_add,
            notify::tg_save,
            notify::tg_status,
            notify::tg_forget,
            notify::tg_send,
        ])
        .setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            let _ = win.set_focus();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state: State<AppState> = window.state();
                let ids: Vec<String> = state.conns.lock().unwrap().keys().cloned().collect();
                for id in ids {
                    disconnect_inner(&state, &id);
                }
                for (_, mut t) in state.terms.lock().unwrap().drain() {
                    t.task.abort();
                    if let Some(c) = t.child.as_mut() {
                        let _ = c.start_kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
