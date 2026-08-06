//! Гарантія, що дочірні `ssh`-процеси не переживуть застосунок.
//!
//! Штатне прибирання (`WindowEvent::Destroyed` і `disconnect`) не спрацьовує,
//! якщо процес завершили примусово — через Диспетчер задач, `Stop-Process`
//! або при аварії. Тоді тунелі, файлові агенти й монітори лишаються висіти
//! й тримають зʼєднання до серверів.
//!
//! Тут два рівні захисту:
//! 1. **Windows Job Object** із `KILL_ON_JOB_CLOSE` — ядро саме прибирає всіх
//!    нащадків, щойно зникає дескриптор job, тобто при будь-якому завершенні
//!    застосунку. Це основний механізм.
//! 2. **Реєстр PID у файлі** — підстраховка для решти платформ і для випадку,
//!    коли job створити не вдалося. На старті ми підчищаємо все, що лишилось
//!    від попереднього запуску, перевіряючи, що процес справді наш.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static PIDFILE: OnceLock<PathBuf> = OnceLock::new();
static REGISTRY: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Викликається один раз на старті: задає шлях до реєстру й прибирає
/// процеси, що лишилися від попереднього (аварійного) завершення.
pub fn init(data_dir: &std::path::Path) -> usize {
    let path = data_dir.join("children.pid");
    let _ = PIDFILE.set(path.clone());
    #[cfg(windows)]
    win::ensure_job();
    sweep_stale(&path)
}

/// Взяти дочірній процес під нагляд.
pub fn guard(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    win::adopt(pid);
    REGISTRY.lock().unwrap().push(pid);
    persist();
}

/// Прибрати з реєстру процес, який ми зупинили самі.
pub fn release(pid: u32) {
    REGISTRY.lock().unwrap().retain(|p| *p != pid);
    persist();
}

fn persist() {
    let Some(path) = PIDFILE.get() else { return };
    let list = REGISTRY.lock().unwrap();
    let body = list.iter().map(|p| p.to_string()).collect::<Vec<_>>().join("\n");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, body);
}

/// Вбиває записані раніше процеси, які ще живі **і справді є нашим ssh**.
/// Перевірка обовʼязкова: PID у системі перевикористовуються, і без неї
/// можна було б випадково вбити чужий процес.
fn sweep_stale(path: &std::path::Path) -> usize {
    let Ok(text) = std::fs::read_to_string(path) else {
        return 0;
    };
    let mut killed = 0;
    for line in text.lines() {
        let Ok(pid) = line.trim().parse::<u32>() else { continue };
        if pid == 0 {
            continue;
        }
        if looks_like_our_ssh(pid) && kill_pid(pid) {
            killed += 1;
        }
    }
    let _ = std::fs::write(path, "");
    killed
}

/// Чи це справді ssh, запущений нами (за характерним набором прапорців)?
fn looks_like_our_ssh(pid: u32) -> bool {
    let cmdline = process_cmdline(pid).unwrap_or_default();
    let c = cmdline.to_lowercase();
    (c.contains("ssh") || c.contains("ssh.exe")) && c.contains("batchmode=yes")
}

#[cfg(windows)]
fn process_cmdline(pid: u32) -> Option<String> {
    // WMI — найпростіший спосіб дістати командний рядок чужого процесу
    let out = std::process::Command::new("wmic")
        .args([
            "process",
            "where",
            &format!("ProcessId={pid}"),
            "get",
            "CommandLine",
            "/value",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(target_os = "linux")]
fn process_cmdline(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(String::from_utf8_lossy(&raw).replace('\0', " "))
}

#[cfg(target_os = "macos")]
fn process_cmdline(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> bool {
    std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn kill_pid(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/* ── Windows Job Object ─────────────────────────────── */

#[cfg(windows)]
mod win {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    struct Job(HANDLE);
    // HANDLE — сирий вказівник; ділитися ним між потоками тут безпечно,
    // бо ми лише передаємо його у виклики WinAPI і ніколи не звільняємо.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    pub fn ensure_job() {
        let _ = handle();
    }

    fn handle() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            // ключова частина: коли зникне останній дескриптор job,
            // ядро прибере всі процеси всередині
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Job(job))
        })
        .as_ref()
        .map(|j| j.0)
    }

    pub fn adopt(pid: u32) {
        let Some(job) = handle() else { return };
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                return;
            }
            AssignProcessToJobObject(job, proc);
            CloseHandle(proc);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_pid_zero() {
        guard(0);
        assert!(REGISTRY.lock().unwrap().is_empty());
    }

    #[test]
    fn registry_add_and_release() {
        guard(424242);
        assert!(REGISTRY.lock().unwrap().contains(&424242));
        release(424242);
        assert!(!REGISTRY.lock().unwrap().contains(&424242));
    }

    #[test]
    fn own_process_is_not_mistaken_for_ssh() {
        // власний PID — не ssh, чіпати його не можна
        assert!(!looks_like_our_ssh(std::process::id()));
    }
}
