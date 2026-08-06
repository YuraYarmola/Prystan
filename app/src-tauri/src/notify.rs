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
