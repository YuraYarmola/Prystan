use std::io::Write;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    pub ts: i64,
    pub conn: String,
    pub action: String,
    pub target: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub ok: bool,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Запис у журнал власних дій. Пишемо синхронно рядком JSON —
/// файл лишається читабельним і не псується при аварійному завершенні.
pub fn log(state: &AppState, conn: &str, action: &str, target: &str, detail: &str, ok: bool) {
    let e = Entry {
        ts: now(),
        conn: conn.to_string(),
        action: action.to_string(),
        target: target.to_string(),
        detail: detail.chars().take(400).collect(),
        ok,
    };
    let path = state.profiles_path.with_file_name("journal.jsonl");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        if let Ok(line) = serde_json::to_string(&e) {
            let _ = writeln!(f, "{line}");
        }
    }
}

#[tauri::command]
pub fn journal_list(state: State<'_, AppState>, limit: Option<usize>) -> Vec<Entry> {
    let path = state.profiles_path.with_file_name("journal.jsonl");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    let limit = limit.unwrap_or(500);
    let mut out: Vec<Entry> = text
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Entry>(l).ok())
        .take(limit)
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

#[tauri::command]
pub fn journal_clear(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.profiles_path.with_file_name("journal.jsonl");
    std::fs::write(&path, "").map_err(|e| e.to_string())
}

/// Записати дію з фронтенду (для того, що робиться повністю в UI).
#[tauri::command]
pub fn journal_add(
    state: State<'_, AppState>,
    conn: String,
    action: String,
    target: String,
    detail: Option<String>,
    ok: Option<bool>,
) {
    log(
        &state,
        &conn,
        &action,
        &target,
        &detail.unwrap_or_default(),
        ok.unwrap_or(true),
    );
}
