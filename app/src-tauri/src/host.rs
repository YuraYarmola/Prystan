use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::files::{parse_ls, FsEntry};
use crate::{AppState, Profile};

const MAX_VIEW: usize = 5 * 1024 * 1024;

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn sh_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', "'\\''"))
}

pub fn get_profile(state: &AppState, conn: &str) -> Result<Profile, String> {
    crate::load_profiles(&state.profiles_path)
        .into_iter()
        .find(|p| p.id == conn)
        .ok_or_else(|| format!("профіль '{conn}' не знайдено"))
}

fn ssh_args(p: &Profile) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-o".into(), "BatchMode=yes".into(),
        "-o".into(), "StrictHostKeyChecking=accept-new".into(),
        "-o".into(), "ConnectTimeout=10".into(),
        "-p".into(), p.port.max(22).to_string(),
    ];
    if !p.key_path.is_empty() {
        a.push("-i".into());
        a.push(p.key_path.clone());
    }
    a.push(format!("{}@{}", p.user, p.host));
    a
}

fn ssh_command(p: &Profile) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(ssh_args(p));
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/* виконати команду на хості, повернути (stdout, stderr, code) */
async fn ssh_run(
    p: &Profile,
    remote_cmd: &str,
    stdin_data: Option<Vec<u8>>,
    limit: usize,
    timeout_s: u64,
) -> Result<(Vec<u8>, String, i32), String> {
    let mut cmd = ssh_command(p);
    cmd.arg(remote_cmd)
        .stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;

    if let Some(data) = stdin_data {
        let mut si = child.stdin.take().unwrap();
        tokio::spawn(async move {
            let _ = si.write_all(&data).await;
            let _ = si.shutdown().await;
        });
    }

    let mut out = Vec::new();
    let mut err = String::new();
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();

    let fut = async {
        let mut buf = [0u8; 65536];
        loop {
            let n = so.read(&mut buf).await.unwrap_or(0);
            if n == 0 { break; }
            out.extend_from_slice(&buf[..n]);
            if out.len() > limit {
                return Err(format!("вивід завеликий (> {} МБ)", limit / 1024 / 1024));
            }
        }
        let mut ebuf = String::new();
        let _ = se.read_to_string(&mut ebuf).await;
        err = ebuf;
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(timeout_s), fut)
        .await
        .map_err(|_| format!("таймаут ssh ({timeout_s} с)"))??;

    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok((out, err, status.code().unwrap_or(-1)))
}

fn is_ssh(p: &Profile) -> bool {
    p.kind == "ssh"
}

/* ── постійний ssh-агент для файлових операцій ────────
   Один ssh-процес на підключення. Протокол:
   → stdin:  "<id> <base64(команда)>\n"
   ← stdout: "@R <id> <rc> <base64(stdout+stderr)>\n"
   Команда виконується з тимчасового файла, тому немає лімітів argv
   і проблем зі втратою хвостових переносів рядків. */

pub struct AgentHandle {
    pub stdin: Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
    pub pending: Arc<std::sync::Mutex<
        std::collections::HashMap<u64, tokio::sync::oneshot::Sender<(i32, Vec<u8>)>>,
    >>,
    pub next_id: Arc<std::sync::atomic::AtomicU64>,
    pub child: tokio::process::Child,
    pub task: tokio::task::JoinHandle<()>,
}

// Тимчасові файли тримаємо в окремій теці й прибираємо не лише по EXIT:
// при SIGKILL (аварія застосунку) trap не спрацьовує, тому кожен новий агент
// підчищає залишки попередніх запусків.
const AGENT_SCRIPT: &str = "D=/tmp/.prystan; mkdir -p $D; \
find $D -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null; \
T=$D/$$; trap 'rm -f $T.c $T.o' EXIT INT TERM HUP; \
while IFS= read -r l; do i=${l%% *}; b=${l#* }; \
printf %s \"$b\" | base64 -d > $T.c; sh $T.c > $T.o 2>&1; r=$?; \
printf '@R %s %s ' \"$i\" \"$r\"; base64 -w0 < $T.o 2>/dev/null || base64 < $T.o | tr -d '\\n'; printf '\\n'; done";

pub fn spawn_agent(p: &Profile) -> Result<AgentHandle, String> {
    let mut cmd = ssh_command(p);
    cmd.arg(AGENT_SCRIPT);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("ssh-агент: {e}"))?;
    crate::procguard::guard(child.id().unwrap_or(0));
    let stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();

    let pending: Arc<std::sync::Mutex<
        std::collections::HashMap<u64, tokio::sync::oneshot::Sender<(i32, Vec<u8>)>>,
    >> = Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let pending_c = pending.clone();

    let task = tokio::spawn(async move {
        let mut buf = [0u8; 65536];
        let mut acc: Vec<u8> = Vec::new();
        loop {
            let n = match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            acc.extend_from_slice(&buf[..n]);
            while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = acc.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line[..line.len() - 1]).to_string();
                if let Some(rest) = line.strip_prefix("@R ") {
                    let mut it = rest.splitn(3, ' ');
                    let id: u64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                    let rc: i32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(-1);
                    let data = it
                        .next()
                        .map(|b| b64().decode(b.trim()).unwrap_or_default())
                        .unwrap_or_default();
                    if let Some(tx) = pending_c.lock().unwrap().remove(&id) {
                        let _ = tx.send((rc, data));
                    }
                }
            }
        }
        // агент помер — усі очікувачі отримують помилку через закриття каналів
        pending_c.lock().unwrap().clear();
    });

    Ok(AgentHandle {
        stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
        pending,
        next_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        child,
        task,
    })
}

/* виконати команду через агента; (rc, stdout+stderr) */
async fn agent_exec(
    state: &AppState,
    conn: &str,
    cmd: &str,
    timeout_s: u64,
) -> Result<(i32, Vec<u8>), String> {
    let p = get_profile(state, conn)?;
    if !is_ssh(&p) {
        return Err("агент доступний лише для SSH".into());
    }

    let (stdin, pending, id) = {
        let mut agents = state.agents.lock().unwrap();
        if !agents.contains_key(conn) {
            agents.insert(conn.to_string(), spawn_agent(&p)?);
        }
        let a = agents.get(conn).unwrap();
        (
            a.stdin.clone(),
            a.pending.clone(),
            a.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        )
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    pending.lock().unwrap().insert(id, tx);

    let line = format!("{id} {}\n", b64().encode(cmd));
    {
        let mut si = stdin.lock().await;
        if si.write_all(line.as_bytes()).await.is_err() || si.flush().await.is_err() {
            pending.lock().unwrap().remove(&id);
            // агент мертвий — приберемо, наступний виклик перезапустить
            if let Some(mut a) = state.agents.lock().unwrap().remove(conn) {
                a.task.abort();
                let _ = a.child.start_kill();
            }
            return Err("ssh-агент недоступний (перепідключіться)".into());
        }
    }

    match tokio::time::timeout(Duration::from_secs(timeout_s), rx).await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(_)) => {
            if let Some(mut a) = state.agents.lock().unwrap().remove(conn) {
                a.task.abort();
                let _ = a.child.start_kill();
            }
            Err("ssh-агент розірвав з'єднання".into())
        }
        Err(_) => {
            pending.lock().unwrap().remove(&id);
            Err(format!("таймаут операції ({timeout_s} с)"))
        }
    }
}

pub fn kill_agent(state: &AppState, conn: &str) {
    if let Some(mut a) = state.agents.lock().unwrap().remove(conn) {
        a.task.abort();
        let _ = a.child.start_kill();
    }
}

/* ── керування процесами ────────────────────────────── */

#[tauri::command]
pub async fn host_kill(
    state: State<'_, AppState>,
    conn: String,
    pid: i64,
    signal: String,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    if !is_ssh(&p) {
        return Err("лише для SSH-підключень".into());
    }
    let sig = match signal.as_str() {
        "KILL" => "-9",
        _ => "-15",
    };
    let (_, err, code) = ssh_run(&p, &format!("kill {sig} {pid}"), None, 65536, 15).await?;
    if code != 0 {
        return Err(err.lines().last().unwrap_or("kill: помилка").to_string());
    }
    Ok(())
}

/* ── файли хоста (ssh) або локальні (local) ─────────── */

#[tauri::command]
pub async fn host_fs_list(
    state: State<'_, AppState>,
    conn: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let p = get_profile(&state, &conn)?;
    if p.kind == "local" {
        return local_list(&path);
    }
    let (code, out) = agent_exec(&state, &conn, &format!("LC_ALL=C ls -lA -- {}", sh_quote(&path)), 30).await?;
    let text = String::from_utf8_lossy(&out).to_string();
    if text.contains("No such file or directory") {
        return Err(format!("шлях не знайдено: {path}"));
    }
    if code != 0 && text.trim().is_empty() {
        return Err("помилка ls".into());
    }
    Ok(parse_ls(&text))
}

fn local_list(path: &str) -> Result<Vec<FsEntry>, String> {
    let mut entries = Vec::new();
    for e in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let md = e.metadata().map_err(|e| e.to_string())?;
        entries.push(FsEntry {
            name: e.file_name().to_string_lossy().to_string(),
            is_dir: md.is_dir(),
            is_link: md.file_type().is_symlink(),
            size: md.len(),
            perms: if md.permissions().readonly() { "r--".into() } else { "rw-".into() },
            owner: String::new(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn host_fs_read(
    state: State<'_, AppState>,
    conn: String,
    path: String,
) -> Result<serde_json::Value, String> {
    let p = get_profile(&state, &conn)?;
    let (data, size) = if p.kind == "local" {
        let d = std::fs::read(&path).map_err(|e| e.to_string())?;
        let s = d.len();
        (d, s)
    } else {
        // одна операція через агента: перший рядок — розмір, далі — вміст
        let q = sh_quote(&path);
        let (code, out) = agent_exec(
            &state,
            &conn,
            &format!("wc -c < {q} && head -c {MAX_VIEW} -- {q}"),
            60,
        )
        .await?;
        if code != 0 {
            let msg = String::from_utf8_lossy(&out);
            return Err(msg.lines().last().unwrap_or("read: помилка").to_string());
        }
        let nl = out.iter().position(|&b| b == b'\n').ok_or("read: несподіваний формат")?;
        let size: usize = String::from_utf8_lossy(&out[..nl]).trim().parse().unwrap_or(0);
        (out[nl + 1..].to_vec(), size)
    };
    let truncated = size > MAX_VIEW || data.len() > MAX_VIEW;
    let slice = &data[..data.len().min(MAX_VIEW)];
    let is_binary = slice.iter().take(8000).any(|&b| b == 0);
    Ok(serde_json::json!({
        "content_b64": b64().encode(slice),
        "size": size,
        "truncated": truncated,
        "binary": is_binary,
    }))
}

#[tauri::command]
pub async fn host_fs_write(
    state: State<'_, AppState>,
    conn: String,
    path: String,
    content_b64: String,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    let data = b64().decode(&content_b64).map_err(|e| e.to_string())?;
    if p.kind == "local" {
        return std::fs::write(&path, data).map_err(|e| e.to_string());
    }
    agent_write(&state, &conn, &p, &path, data).await
}

/* запис через агента (payload у тілі команди), великі файли — окремою ssh-сесією */
async fn agent_write(
    state: &AppState,
    conn: &str,
    p: &Profile,
    path: &str,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() <= 8 << 20 {
        let cmd = format!(
            "printf %s {} | base64 -d > {}",
            sh_quote(&b64().encode(&data)),
            sh_quote(path)
        );
        let (code, out) = agent_exec(state, conn, &cmd, 120).await?;
        if code != 0 {
            let msg = String::from_utf8_lossy(&out);
            return Err(msg.lines().last().unwrap_or("write: помилка").to_string());
        }
        return Ok(());
    }
    let (_, err, code) = ssh_run(p, &format!("cat > {}", sh_quote(path)), Some(data), 65536, 600).await?;
    if code != 0 {
        return Err(err.lines().last().unwrap_or("write: помилка").to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn host_fs_download(
    state: State<'_, AppState>,
    conn: String,
    path: String,
) -> Result<String, String> {
    let p = get_profile(&state, &conn)?;
    let downloads = crate::files::downloads_dir();
    let base = path
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();

    if p.kind == "local" {
        let target = crate::files::unique_path(&downloads.join(&base));
        std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
        return Ok(target.to_string_lossy().to_string());
    }

    let (t, _, _) = ssh_run(
        &p,
        &format!("[ -d {} ] && echo D || echo F", sh_quote(&path)),
        None,
        64,
        20,
    )
    .await?;
    let is_dir = String::from_utf8_lossy(&t).trim() == "D";

    if is_dir {
        let parent = path.trim_end_matches('/').rsplit_once('/').map(|x| x.0).unwrap_or("/");
        let parent = if parent.is_empty() { "/" } else { parent };
        let (out, err, code) = ssh_run(
            &p,
            &format!("tar -C {} -cf - {}", sh_quote(parent), sh_quote(&base)),
            None,
            512 << 20,
            600,
        )
        .await?;
        if code != 0 && out.is_empty() {
            return Err(err.lines().last().unwrap_or("tar: помилка").to_string());
        }
        let target = crate::files::unique_path(&downloads.join(format!("{base}.tar")));
        std::fs::write(&target, out).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().to_string())
    } else {
        let (out, err, code) = ssh_run(&p, &format!("cat -- {}", sh_quote(&path)), None, 512 << 20, 600).await?;
        if code != 0 && out.is_empty() {
            return Err(err.lines().last().unwrap_or("cat: помилка").to_string());
        }
        let target = crate::files::unique_path(&downloads.join(&base));
        std::fs::write(&target, out).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub async fn host_fs_upload(
    state: State<'_, AppState>,
    conn: String,
    dir: String,
    filename: String,
    content_b64: String,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    let data = b64().decode(&content_b64).map_err(|e| e.to_string())?;
    if p.kind == "local" {
        return std::fs::write(std::path::Path::new(&dir).join(&filename), data)
            .map_err(|e| e.to_string());
    }
    let full = format!("{}/{}", dir.trim_end_matches('/'), filename);
    agent_write(&state, &conn, &p, &full, data).await
}

#[tauri::command]
pub async fn host_fs_mkdir(
    state: State<'_, AppState>,
    conn: String,
    path: String,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    if p.kind == "local" {
        return std::fs::create_dir_all(&path).map_err(|e| e.to_string());
    }
    let (code, out) = agent_exec(&state, &conn, &format!("mkdir -p -- {}", sh_quote(&path)), 20).await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out);
        return Err(msg.lines().last().unwrap_or("mkdir: помилка").to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn host_fs_delete(
    state: State<'_, AppState>,
    conn: String,
    path: String,
) -> Result<(), String> {
    if path == "/" || path.is_empty() || path == "C:\\" {
        return Err("відмова: не можна видалити корінь".into());
    }
    let p = get_profile(&state, &conn)?;
    if p.kind == "local" {
        let md = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        return if md.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())
        };
    }
    let (code, out) = agent_exec(&state, &conn, &format!("rm -rf -- {}", sh_quote(&path)), 60).await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out);
        return Err(msg.lines().last().unwrap_or("rm: помилка").to_string());
    }
    Ok(())
}

/* Розбір одного блоку монітора у структуру. Винесено з циклу заради тестів. */
pub struct MonSample {
    pub cpu_stat: Vec<u64>,
    pub mem_total_kb: u64,
    pub mem_avail_kb: u64,
    pub load: String,
    pub uptime: f64,
    pub ncpu: u32,
    pub hostname: String,
    pub disks: Vec<(String, u64, u64)>,
    pub ps: Vec<String>,
}

pub fn parse_monitor_block(block: &str) -> Option<MonSample> {
    let b_start = block.find("==B==")? + 5;
    let d_start = block.find("==D==").unwrap_or(block.len());
    let p_start = block.find("==P==").unwrap_or(block.len());

    let head: Vec<&str> = block[b_start..d_start].trim().lines().collect();
    if head.len() < 6 {
        return None;
    }
    let cpu_stat: Vec<u64> = head[0]
        .split_whitespace()
        .skip(1)
        .filter_map(|x| x.parse().ok())
        .collect();
    let mem_total_kb = head[1].split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    let mem_avail_kb = head[2].split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    let load = head[3].split_whitespace().take(3).collect::<Vec<_>>().join(" ");
    let uptime = head[4].split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let ncpu = head[5].trim().parse().unwrap_or(1);
    let hostname = head.get(6).unwrap_or(&"").trim().to_string();

    let disks = if d_start < p_start {
        block[d_start + 5..p_start]
            .trim()
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split_whitespace().collect();
                if f.len() < 6 {
                    return None;
                }
                let size: u64 = f[1].parse().ok()?;
                let used: u64 = f[2].parse().ok()?;
                if size < 1 << 30 {
                    return None;
                }
                Some((f[5].to_string(), size, used))
            })
            .collect()
    } else {
        vec![]
    };

    let ps = if p_start < block.len() {
        block[p_start + 5..]
            .trim()
            .lines()
            .skip(1)
            .filter(|l| {
                !l.contains("ps aux --sort")
                    && !l.contains("while true; do echo")
                    && !l.contains("sleep 3")
            })
            .map(|l| l.to_string())
            .collect()
    } else {
        vec![]
    };

    Some(MonSample {
        cpu_stat,
        mem_total_kb,
        mem_avail_kb,
        load,
        uptime,
        ncpu,
        hostname,
        disks,
        ps,
    })
}

/// CPU% із двох послідовних семплів /proc/stat; -1 якщо попереднього ще немає
pub fn cpu_pct_from(prev: Option<&Vec<u64>>, cur: &[u64]) -> f64 {
    match prev {
        Some(p) if p.len() >= 5 && cur.len() >= 5 => {
            let t1: u64 = p.iter().sum();
            let t2: u64 = cur.iter().sum();
            let i1 = p[3] + p.get(4).copied().unwrap_or(0);
            let i2 = cur[3] + cur.get(4).copied().unwrap_or(0);
            let dt = t2.saturating_sub(t1) as f64;
            if dt > 0.0 {
                ((dt - (i2.saturating_sub(i1)) as f64) / dt * 100.0).clamp(0.0, 100.0)
            } else {
                -1.0
            }
        }
        _ => -1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: &str = "==B==\n\
cpu  100 0 50 800 10 0 0 0 0 0\n\
MemTotal:        8000000 kB\n\
MemAvailable:    6000000 kB\n\
0.54 0.14 0.04 1/500 12345\n\
3600.50 14000.00\n\
4\n\
srv-01\n\
==D==\n\
/dev/sda1 160000000000 24000000000 130000000000 16% /\n\
tmpfs 100000 0 100000 0% /run\n\
==P==\n\
USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\n\
root 1 0.1 0.5 1000 2048 ? Ss Jul22 1:00 /sbin/init\n\
root 99 0.0 0.0 100 100 ? R 10:00 0:00 ps aux --sort=-%cpu\n";

    #[test]
    fn parses_full_block() {
        let s = parse_monitor_block(BLOCK).expect("блок має розібратись");
        assert_eq!(s.ncpu, 4);
        assert_eq!(s.hostname, "srv-01");
        assert_eq!(s.mem_total_kb, 8_000_000);
        assert_eq!(s.load, "0.54 0.14 0.04");
        assert_eq!(s.uptime as u64, 3600);
        // tmpfs < 1 ГБ відкидається
        assert_eq!(s.disks.len(), 1);
        assert_eq!(s.disks[0].0, "/");
        // заголовок ps і власний ps-рядок відфільтровані
        assert_eq!(s.ps.len(), 1);
        assert!(s.ps[0].contains("/sbin/init"));
    }

    #[test]
    fn cpu_needs_two_samples() {
        let first = vec![100, 0, 50, 800, 10];
        assert_eq!(cpu_pct_from(None, &first), -1.0, "перший семпл — без дельти");
        // за наступний тік: +100 усього, з них +50 idle → 50%
        let second = vec![150, 0, 50, 850, 10];
        let pct = cpu_pct_from(Some(&first), &second);
        assert!((pct - 50.0).abs() < 0.01, "очікували 50%, отримали {pct}");
    }

    #[test]
    fn partial_block_is_rejected() {
        assert!(parse_monitor_block("==B==\ncpu 1 2 3\n").is_none());
    }
}

/* ── постійний монітор (одна ssh-сесія, стрім метрик) ── */

pub struct MonitorHandle {
    pub task: tokio::task::JoinHandle<()>,
    pub child: tokio::process::Child,
}

// $Z порожня — маркери в cmdline скрипта виглядають як ==B$Z== і не збігаються
// з ==B== у виводі, інакше ps-рядок самого монітора рвав би парсинг блоків
const MONITOR_SCRIPT: &str = "Z=; while true; do \
  echo ==B$Z==; head -1 /proc/stat; grep -E 'MemTotal|MemAvailable' /proc/meminfo; \
  cat /proc/loadavg; cat /proc/uptime; nproc; hostname; \
  echo ==D$Z==; df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2; \
  echo ==P$Z==; ps aux --sort=-%cpu 2>/dev/null | head -70; \
  echo ==E$Z==; sleep 3; done";

#[tauri::command]
pub async fn host_monitor_start(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
) -> Result<(), String> {
    if state.monitors.lock().unwrap().contains_key(&conn) {
        return Ok(()); // вже працює
    }
    let p = get_profile(&state, &conn)?;
    if !is_ssh(&p) {
        return Err("монітор доступний лише для SSH-підключень".into());
    }

    let mut cmd = ssh_command(&p);
    cmd.arg(MONITOR_SCRIPT);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
    crate::procguard::guard(child.id().unwrap_or(0));
    let mut stdout = child.stdout.take().unwrap();

    let conn_c = conn.clone();
    let task = tokio::spawn(async move {
        let mut buf = [0u8; 65536];
        let mut acc = String::new();
        // попередній семпл /proc/stat для обчислення CPU%
        let mut prev_stat: Option<Vec<u64>> = None;

        loop {
            let n = match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            acc.push_str(&String::from_utf8_lossy(&buf[..n]));

            while let Some(end) = acc.find("==E==") {
                let block: String = acc[..end].to_string();
                acc = acc[end + 5..].to_string();

                let s = match parse_monitor_block(&block) {
                    Some(s) => s,
                    None => continue,
                };
                let cpu_pct = cpu_pct_from(prev_stat.as_ref(), &s.cpu_stat);
                prev_stat = Some(s.cpu_stat.clone());

                let disks: Vec<serde_json::Value> = s
                    .disks
                    .iter()
                    .map(|(m, size, used)| serde_json::json!({ "mount": m, "size": size, "used": used }))
                    .collect();

                let _ = app.emit(
                    "host-monitor",
                    serde_json::json!({
                        "conn": conn_c,
                        "cpu_pct": cpu_pct,
                        "ncpu": s.ncpu,
                        "mem_total": s.mem_total_kb * 1024,
                        "mem_avail": s.mem_avail_kb * 1024,
                        "load": s.load,
                        "uptime": s.uptime,
                        "hostname": s.hostname,
                        "disks": disks,
                        "ps": s.ps,
                    }),
                );
            }
        }
        let _ = app.emit("host-monitor-closed", serde_json::json!({ "conn": conn_c }));
    });

    state
        .monitors
        .lock()
        .unwrap()
        .insert(conn, MonitorHandle { task, child });
    Ok(())
}

#[tauri::command]
pub fn host_monitor_stop(state: State<'_, AppState>, conn: String) {
    if let Some(mut m) = state.monitors.lock().unwrap().remove(&conn) {
        m.task.abort();
        let _ = m.child.start_kill();
    }
}

/* ── файли хоста: rename / chmod (B5) ───────────────── */

#[tauri::command]
pub async fn host_fs_rename(
    state: State<'_, AppState>,
    conn: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    if p.kind == "local" {
        return std::fs::rename(&from, &to).map_err(|e| e.to_string());
    }
    let (code, out) = agent_exec(
        &state,
        &conn,
        &format!("mv -- {} {}", sh_quote(&from), sh_quote(&to)),
        30,
    )
    .await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out);
        return Err(msg.lines().last().unwrap_or("mv: помилка").to_string());
    }
    Ok(())
}

/// Створити порожній файл або теку на хості.
#[tauri::command]
pub async fn host_fs_create(
    state: State<'_, AppState>,
    conn: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    if p.kind == "local" {
        return if is_dir {
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())
        } else if std::path::Path::new(&path).exists() {
            Err("файл уже існує".into())
        } else {
            std::fs::write(&path, b"").map_err(|e| e.to_string())
        };
    }
    let q = sh_quote(&path);
    let script = if is_dir {
        format!("mkdir -p -- {q}")
    } else {
        format!("if [ -e {q} ]; then echo 'файл уже існує' >&2; exit 1; fi; : > {q}")
    };
    let (code, out) = agent_exec(&state, &conn, &script, 30).await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out);
        return Err(msg.lines().last().unwrap_or("не вдалося створити").to_string());
    }
    Ok(())
}

/// Копіювання на хості (файл або тека).
#[tauri::command]
pub async fn host_fs_copy(
    state: State<'_, AppState>,
    conn: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    if p.kind == "local" {
        let src = std::path::Path::new(&from);
        return if src.is_dir() {
            Err("копіювання тек доступне лише для SSH-підключень".into())
        } else {
            std::fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
        };
    }
    let (code, out) = agent_exec(
        &state,
        &conn,
        &format!("cp -a -- {} {}", sh_quote(&from), sh_quote(&to)),
        120,
    )
    .await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out);
        return Err(msg.lines().last().unwrap_or("помилка cp").to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn host_fs_chmod(
    state: State<'_, AppState>,
    conn: String,
    path: String,
    mode: String,
) -> Result<(), String> {
    if !mode.chars().all(|c| c.is_ascii_digit()) || mode.len() < 3 || mode.len() > 4 {
        return Err("режим має бути вісімковим, напр. 644".into());
    }
    let p = get_profile(&state, &conn)?;
    if p.kind == "local" {
        return Err("chmod недоступний для локальної Windows-ФС".into());
    }
    let (code, out) = agent_exec(&state, &conn, &format!("chmod {mode} -- {}", sh_quote(&path)), 30).await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out);
        return Err(msg.lines().last().unwrap_or("chmod: помилка").to_string());
    }
    Ok(())
}

/* ── термінал хоста через ConPTY (C7: справжній ресайз) ─
   Локальний ConPTY дає ssh справжній термінал, тому SIGWINCH
   доходить до віддаленого shell, а пароль/passphrase можна
   ввести прямо у вікні терміналу. */

pub struct PtyHandle {
    pub writer: Box<dyn std::io::Write + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
}

#[tauri::command]
pub async fn host_term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let p = get_profile(&state, &conn)?;
    if !is_ssh(&p) {
        return Err("термінал хоста доступний лише для SSH-підключень".into());
    }

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: rows.max(4),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty: {e}"))?;

    let mut cmd = portable_pty::CommandBuilder::new("ssh");
    // -tt: примусовий PTY на віддаленій стороні
    cmd.arg("-tt");
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-p");
    cmd.arg(p.port.max(22).to_string());
    if !p.key_path.is_empty() {
        cmd.arg("-i");
        cmd.arg(&p.key_path);
    }
    cmd.arg(format!("{}@{}", p.user, p.host));
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("ssh: {e}"))?;
    crate::procguard::guard(child.process_id().unwrap_or(0));
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let sid = format!("h{}", child.process_id().unwrap_or(0));
    let sid_c = sid.clone();
    let app_c = app.clone();

    // читання PTY блокуюче — окремий потік
    std::thread::spawn(move || {
        let mut buf = [0u8; 32768];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app_c.emit(
                        "term-output",
                        serde_json::json!({ "sid": sid_c, "data_b64": b64().encode(&buf[..n]) }),
                    );
                }
            }
        }
        let _ = child.wait();
        let _ = app_c.emit("term-closed", serde_json::json!({ "sid": sid_c }));
    });

    state.ptys.lock().unwrap().insert(
        sid.clone(),
        PtyHandle {
            writer,
            master: pair.master,
        },
    );
    // для сумісності з фронтендом реєструємо conn
    state.pty_conns.lock().unwrap().insert(sid.clone(), conn);
    Ok(sid)
}

#[tauri::command]
pub fn host_term_input(state: State<'_, AppState>, sid: String, data_b64: String) -> Result<(), String> {
    use std::io::Write;
    let bytes = b64().decode(data_b64).map_err(|e| e.to_string())?;
    let mut map = state.ptys.lock().unwrap();
    let h = map.get_mut(&sid).ok_or("сесію не знайдено")?;
    h.writer.write_all(&bytes).map_err(|e| e.to_string())?;
    h.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn host_term_resize(
    state: State<'_, AppState>,
    sid: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.ptys.lock().unwrap();
    let h = map.get(&sid).ok_or("сесію не знайдено")?;
    h.master
        .resize(portable_pty::PtySize {
            rows: rows.max(4),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn host_term_close(state: State<'_, AppState>, sid: String) {
    state.ptys.lock().unwrap().remove(&sid);
    state.pty_conns.lock().unwrap().remove(&sid);
}

/* ── docker compose ─────────────────────────────────── */

#[derive(Clone, Serialize)]
struct ComposeOut {
    conn: String,
    project: String,
    line: String,
    done: bool,
}

#[tauri::command]
pub async fn compose_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    project: String,
    workdir: String,
    action: String,
) -> Result<(), String> {
    let p = get_profile(&state, &conn)?;
    if !matches!(action.as_str(), "up" | "down" | "restart" | "pull") {
        return Err(format!("невідома compose-дія: {action}"));
    }

    let emit = {
        let app = app.clone();
        let conn = conn.clone();
        let project = project.clone();
        move |line: String, done: bool| {
            let _ = app.emit(
                "compose-output",
                ComposeOut {
                    conn: conn.clone(),
                    project: project.clone(),
                    line,
                    done,
                },
            );
        }
    };

    // стадії: pull складається з двох послідовних команд
    let stages: Vec<Vec<String>> = match action.as_str() {
        "pull" => vec![
            vec!["compose".into(), "pull".into()],
            vec!["compose".into(), "up".into(), "-d".into()],
        ],
        "up" => vec![vec!["compose".into(), "up".into(), "-d".into(), "--remove-orphans".into()]],
        "down" => vec![vec!["compose".into(), "down".into()]],
        _ => vec![vec!["compose".into(), "restart".into()]],
    };

    if p.kind != "ssh" && p.kind != "local" {
        return Err("compose-дії доступні для local і ssh підключень".into());
    }

    tokio::spawn(async move {
        for stage in stages {
            let child = if p.kind == "ssh" {
                let remote = format!(
                    "cd {} && docker {} 2>&1",
                    sh_quote(&workdir),
                    stage.join(" ")
                );
                let mut cmd = ssh_command(&p);
                cmd.arg(remote);
                cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
                cmd.spawn()
            } else {
                let mut cmd = tokio::process::Command::new("docker");
                cmd.args(&stage).current_dir(&workdir);
                #[cfg(windows)]
                cmd.creation_flags(0x0800_0000);
                cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
                cmd.spawn()
            };
            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    emit(format!("✗ не вдалося запустити: {e}"), true);
                    return;
                }
            };

            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            emit(format!("$ docker {}", stage.join(" ")), false);

            let mut buf = [0u8; 16384];
            let mut ebuf = [0u8; 16384];
            let mut acc = String::new();
            let mut eacc = String::new();
            let mut out_done = false;
            let mut err_done = false;
            while !(out_done && err_done) {
                tokio::select! {
                    r = stdout.read(&mut buf), if !out_done => match r {
                        Ok(0) | Err(_) => out_done = true,
                        Ok(n) => {
                            acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                            while let Some(i) = acc.find('\n') {
                                emit(acc[..i].trim_end_matches('\r').to_string(), false);
                                acc = acc[i + 1..].to_string();
                            }
                        }
                    },
                    r = stderr.read(&mut ebuf), if !err_done => match r {
                        Ok(0) | Err(_) => err_done = true,
                        Ok(n) => {
                            eacc.push_str(&String::from_utf8_lossy(&ebuf[..n]));
                            while let Some(i) = eacc.find('\n') {
                                emit(eacc[..i].trim_end_matches('\r').to_string(), false);
                                eacc = eacc[i + 1..].to_string();
                            }
                        }
                    },
                }
            }
            for l in [acc, eacc] {
                if !l.trim().is_empty() {
                    emit(l.trim().to_string(), false);
                }
            }
            let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
            if code != 0 {
                emit(format!("✗ Завершено з кодом {code}"), true);
                return;
            }
        }
        emit("✓ Готово".into(), true);
    });

    Ok(())
}
