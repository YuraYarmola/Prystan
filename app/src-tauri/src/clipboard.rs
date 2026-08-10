//! Читання системного буфера обміну.
//!
//! У вебвʼю `navigator.clipboard.readText()` не годиться: він вимагає дозволу
//! `clipboard-read`, а WebView2 на цей запит показує підтвердження й до
//! відповіді промис просто висить. Копіювання так робити можна (запис
//! дозволений сфокусованому вікну), а от читання беремо з боку системи.
//!
//! Вставку клавішею це не зачіпає — там працює власна вставка браузера,
//! яка дозволів не потребує. Ця команда потрібна пункту меню «Вставити».

/// Текст із буфера обміну; порожній рядок, якщо там не текст.
#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    read_os()
}

#[cfg(windows)]
fn read_os() -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("буфер обміну зайнятий іншою програмою".into());
        }
        let handle = GetClipboardData(CF_UNICODETEXT);
        if handle.is_null() {
            CloseClipboard();
            return Ok(String::new()); // у буфері не текст — це не помилка
        }
        let ptr = GlobalLock(handle) as *const u16;
        if ptr.is_null() {
            CloseClipboard();
            return Err("не вдалося прочитати буфер обміну".into());
        }
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        GlobalUnlock(handle);
        CloseClipboard();
        Ok(text)
    }
}

/// Перша утиліта, яка знайшлась і відпрацювала без помилки.
#[cfg(not(windows))]
fn first_of(candidates: &[(&str, &[&str])]) -> Result<String, String> {
    let mut last = String::from("немає утиліти для читання буфера обміну");
    for (bin, args) in candidates {
        match std::process::Command::new(bin).args(*args).output() {
            Ok(out) if out.status.success() => {
                return Ok(String::from_utf8_lossy(&out.stdout).to_string());
            }
            Ok(out) => {
                last = String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .last()
                    .unwrap_or("помилка читання буфера")
                    .to_string();
            }
            Err(_) => continue, // немає такої програми — пробуємо наступну
        }
    }
    Err(last)
}

#[cfg(target_os = "macos")]
fn read_os() -> Result<String, String> {
    first_of(&[("pbpaste", &[])])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_os() -> Result<String, String> {
    first_of(&[
        ("wl-paste", &["--no-newline"]),
        ("xclip", &["-selection", "clipboard", "-o"]),
        ("xsel", &["--clipboard", "--output"]),
    ])
}
