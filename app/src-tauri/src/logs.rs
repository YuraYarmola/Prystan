use bollard::query_parameters::LogsOptionsBuilder;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

#[derive(Serialize)]
pub struct SearchHit {
    line: String,
    index: usize,
}

#[derive(Serialize)]
pub struct SearchResult {
    hits: Vec<SearchHit>,
    scanned: usize,
    truncated: bool,
    took_ms: u128,
}

/// A1 — пошук по всій історії логів контейнера (не по буферу UI).
/// Тягне логи без follow і фільтрує на боці застосунку (Rust), тому
/// працює однаково для локального й віддаленого демона.
#[tauri::command]
pub async fn logs_search(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    since: Option<i64>,
    limit: Option<usize>,
) -> Result<SearchResult, String> {
    let t0 = std::time::Instant::now();
    let docker = state.docker(&conn)?;
    let limit = limit.unwrap_or(2000);

    let re = if regex {
        let mut b = regex::RegexBuilder::new(&query);
        b.case_insensitive(!case_sensitive);
        Some(b.build().map_err(|e| format!("некоректний regex: {e}"))?)
    } else {
        None
    };
    let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };

    let mut opts = LogsOptionsBuilder::new()
        .follow(false)
        .stdout(true)
        .stderr(true)
        .timestamps(true)
        .tail("all");
    if let Some(s) = since {
        opts = opts.since(s as i32);
    }
    let mut stream = docker.logs(&id, Some(opts.build()));

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    let mut carry = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        carry.push_str(&String::from_utf8_lossy(&chunk.into_bytes()));
        while let Some(i) = carry.find('\n') {
            let line: String = carry[..i].trim_end_matches('\r').to_string();
            carry = carry[i + 1..].to_string();
            scanned += 1;
            let matched = match &re {
                Some(r) => r.is_match(&line),
                None => {
                    if case_sensitive {
                        line.contains(&needle)
                    } else {
                        line.to_lowercase().contains(&needle)
                    }
                }
            };
            if matched {
                hits.push(SearchHit { line, index: scanned });
                if hits.len() >= limit {
                    truncated = true;
                    break;
                }
            }
        }
        if truncated {
            break;
        }
    }
    if !truncated && !carry.trim().is_empty() {
        scanned += 1;
        let matched = match &re {
            Some(r) => r.is_match(&carry),
            None => {
                if case_sensitive {
                    carry.contains(&needle)
                } else {
                    carry.to_lowercase().contains(&needle)
                }
            }
        };
        if matched {
            hits.push(SearchHit { line: carry.clone(), index: scanned });
        }
    }

    Ok(SearchResult {
        hits,
        scanned,
        truncated,
        took_ms: t0.elapsed().as_millis(),
    })
}

/// A2 — агреговані логи compose-стека: кілька контейнерів в один потік.
#[tauri::command]
pub async fn logs_multi_start(
    app: AppHandle,
    state: State<'_, AppState>,
    conn: String,
    targets: Vec<(String, String)>, // (id, підпис сервісу)
    tail: Option<String>,
) -> Result<(), String> {
    for t in state.multi_tasks.lock().unwrap().drain(..) {
        t.abort();
    }
    let docker = state.docker(&conn)?;
    let tail = tail.unwrap_or_else(|| "200".into());

    let mut handles = Vec::new();
    for (idx, (id, label)) in targets.into_iter().enumerate() {
        let docker = docker.clone();
        let app = app.clone();
        let conn = conn.clone();
        let tail = tail.clone();
        handles.push(tokio::spawn(async move {
            let opts = LogsOptionsBuilder::new()
                .follow(true)
                .stdout(true)
                .stderr(true)
                .tail(&tail)
                .build();
            let mut stream = docker.logs(&id, Some(opts));
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(out) => {
                        let text = String::from_utf8_lossy(&out.into_bytes()).to_string();
                        let _ = app.emit(
                            "docker-log-multi",
                            serde_json::json!({
                                "conn": conn, "cid": id, "label": label,
                                "color": idx % 8, "line": text,
                            }),
                        );
                    }
                    Err(_) => break,
                }
            }
        }));
    }
    *state.multi_tasks.lock().unwrap() = handles;
    Ok(())
}

#[tauri::command]
pub fn logs_multi_stop(state: State<'_, AppState>) {
    for t in state.multi_tasks.lock().unwrap().drain(..) {
        t.abort();
    }
}
