//! Перевірка, чи вийшла новіша версія.
//!
//! Застосунок роздається портативним архівом: людина, яка завантажила його
//! колись, інакше ніколи не дізнається про нову версію. Одне звернення до
//! GitHub Releases на старті — і в шапці зʼявляється підказка.
//! Нічого не завантажується й не запускається: лише порівняння номерів.

const REPO: &str = "YuraYarmola/Prystan";

/// "v1.2.3" → (1, 2, 3); усе, що не розібралось, стає нулем.
fn parse_version(s: &str) -> (u32, u32, u32) {
    let mut it = s.trim().trim_start_matches(['v', 'V']).split(['.', '-', '+']);
    let mut next = || it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (next(), next(), next())
}

#[tauri::command]
pub async fn check_update() -> Result<serde_json::Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let body = tokio::task::spawn_blocking(|| {
        ureq::get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))
            // GitHub відмовляє запитам без User-Agent
            .set("User-Agent", "Prystan")
            .set("Accept", "application/vnd.github+json")
            .timeout(std::time::Duration::from_secs(12))
            .call()
            .map_err(|e| format!("оновлення: {e}"))?
            .into_string()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let latest = v["tag_name"].as_str().unwrap_or("").to_string();
    if latest.is_empty() {
        return Err("не вдалося прочитати номер останнього релізу".into());
    }
    Ok(serde_json::json!({
        "current": current,
        "latest": latest.trim_start_matches('v'),
        "newer": parse_version(&latest) > parse_version(&current),
        "url": v["html_url"].as_str().unwrap_or(""),
        "notes": v["body"].as_str().unwrap_or("").chars().take(600).collect::<String>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn compares_versions_numerically() {
        // 10 більше за 9, хоча як рядок — менше
        assert!(parse_version("v0.10.0") > parse_version("v0.9.9"));
        assert!(parse_version("1.0.0") > parse_version("0.99.99"));
        assert_eq!(parse_version("v0.1.0"), parse_version("0.1.0"));
        assert!(parse_version("0.2.0-beta") > parse_version("0.1.9"));
        // сміття не має виглядати новішим за будь-що
        assert_eq!(parse_version("невідомо"), (0, 0, 0));
    }
}
