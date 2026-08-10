use serde::Serialize;
use tauri::State;

use crate::AppState;

const SERVICE: &str = "Prystan";
const TG_KEY: &str = "telegram";

#[derive(Serialize)]
pub struct TgStatus {
    configured: bool,
    chat_id: String,
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("keychain: {e}"))
}

/// Зберігаємо токен у системному сховищі (Windows Credential Manager),
/// а не у файлі — токен бота дає повний доступ до нього.
#[tauri::command]
pub fn tg_save(token: String, chat_id: String) -> Result<(), String> {
    let payload = format!("{token}\n{chat_id}");
    entry(TG_KEY)?
        .set_password(&payload)
        .map_err(|e| format!("keychain: {e}"))
}

#[tauri::command]
pub fn tg_status() -> TgStatus {
    match entry(TG_KEY).and_then(|e| e.get_password().map_err(|e| e.to_string())) {
        Ok(v) => {
            let mut it = v.splitn(2, '\n');
            let _token = it.next().unwrap_or("");
            TgStatus {
                configured: true,
                chat_id: it.next().unwrap_or("").to_string(),
            }
        }
        Err(_) => TgStatus {
            configured: false,
            chat_id: String::new(),
        },
    }
}

#[tauri::command]
pub fn tg_forget() -> Result<(), String> {
    let e = entry(TG_KEY)?;
    e.delete_credential().map_err(|e| format!("keychain: {e}"))
}

/// Дізнатися chat_id, не змушуючи користувача шукати його руками:
/// він пише боту будь-що, ми забираємо це коротким опитуванням getUpdates.
#[tauri::command]
pub async fn tg_detect_chat(token: String) -> Result<serde_json::Value, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("спершу вкажіть токен бота".into());
    }
    tokio::task::spawn_blocking(move || {
        let base = format!("https://api.telegram.org/bot{token}");
        // три кола довгого опитування ≈ хвилина — вистачає, щоб встигнути написати
        for _ in 0..3 {
            let url = format!("{base}/getUpdates?timeout=20&limit=30");
            let resp = ureq::get(&url)
                .timeout(std::time::Duration::from_secs(35))
                .call()
                .map_err(|e| match e {
                    ureq::Error::Status(409, _) => {
                        "у бота увімкнено webhook — приберіть його або введіть chat_id вручну".to_string()
                    }
                    ureq::Error::Status(401, _) => "невірний токен бота".to_string(),
                    ureq::Error::Status(code, r) => {
                        let msg = r.into_string().unwrap_or_default();
                        format!("Telegram {code}: {}", msg.chars().take(200).collect::<String>())
                    }
                    other => format!("мережа: {other}"),
                })?;
            let body = resp.into_string().map_err(|e| e.to_string())?;
            let v: serde_json::Value =
                serde_json::from_str(&body).map_err(|e| format!("відповідь Telegram: {e}"))?;
            if v["ok"] != true {
                return Err("Telegram відхилив запит".to_string());
            }
            let chat = v["result"]
                .as_array()
                .and_then(|arr| {
                    arr.iter().rev().find_map(|u| {
                        u.get("message")
                            .or_else(|| u.get("channel_post"))
                            .and_then(|m| m.get("chat"))
                            .cloned()
                    })
                });
            if let Some(c) = chat {
                let id = c["id"].as_i64().unwrap_or(0);
                if id == 0 {
                    continue;
                }
                let title = c["title"]
                    .as_str()
                    .or_else(|| c["username"].as_str())
                    .or_else(|| c["first_name"].as_str())
                    .unwrap_or("")
                    .to_string();
                return Ok(serde_json::json!({ "chat_id": id.to_string(), "title": title }));
            }
        }
        Err("повідомлень не надійшло — напишіть боту /start і спробуйте ще раз".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Надіслати повідомлення. Викликається і вручну («тест»), і з алертів UI.
#[tauri::command]
pub async fn tg_send(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let creds = entry(TG_KEY)?
        .get_password()
        .map_err(|_| "Telegram не налаштовано".to_string())?;
    let mut it = creds.splitn(2, '\n');
    let token = it.next().unwrap_or("").to_string();
    let chat = it.next().unwrap_or("").to_string();
    if token.is_empty() || chat.is_empty() {
        return Err("порожній токен або chat_id".into());
    }

    let body = text.chars().take(3500).collect::<String>();
    let res = tokio::task::spawn_blocking(move || {
        let url = format!("https://api.telegram.org/bot{token}/sendMessage");
        ureq::post(&url)
            .timeout(std::time::Duration::from_secs(15))
            .send_form(&[
                ("chat_id", chat.as_str()),
                ("text", body.as_str()),
                ("parse_mode", "HTML"),
                ("disable_web_page_preview", "true"),
            ])
            .map(|_| ())
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => {
                    let msg = r.into_string().unwrap_or_default();
                    format!("Telegram {code}: {}", msg.chars().take(200).collect::<String>())
                }
                other => format!("мережа: {other}"),
            })
    })
    .await
    .map_err(|e| e.to_string())?;

    match &res {
        Ok(_) => crate::journal::log(&state, "", "telegram", "notify", &text, true),
        Err(e) => crate::journal::log(&state, "", "telegram", "notify", e, false),
    }
    res
}
