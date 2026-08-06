use base64::Engine;
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::query_parameters::{
    DownloadFromContainerOptionsBuilder, UploadToContainerOptionsBuilder,
};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::State;

use crate::AppState;

const MAX_VIEW: usize = 5 * 1024 * 1024; // 5 MB для перегляду/редагування
const MAX_FETCH: usize = 512 * 1024 * 1024; // 512 MB для download

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    pub perms: String,
    pub owner: String,
}

/* парсер виводу `ls -lA` — спільний для контейнерів і хоста */
pub fn parse_ls(out: &str) -> Vec<FsEntry> {
    let mut entries: Vec<FsEntry> = Vec::new();
    for line in out.lines() {
        let l = line.trim_end();
        if l.is_empty() || l.starts_with("total ") {
            continue;
        }
        let full: Vec<&str> = l.split_whitespace().collect();
        if full.len() < 9 || full[0].len() < 10 {
            continue;
        }
        let perms = full[0].to_string();
        let kind = perms.chars().next().unwrap_or('-');
        let size: u64 = full.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
        let owner = full.get(2).unwrap_or(&"?").to_string();
        let mut idx = 0usize;
        let mut fields = 0;
        let bytes = l.as_bytes();
        let mut in_field = false;
        for (i, b) in bytes.iter().enumerate() {
            let ws = b.is_ascii_whitespace();
            if !ws && !in_field {
                fields += 1;
                in_field = true;
                if fields == 9 {
                    idx = i;
                    break;
                }
            } else if ws {
                in_field = false;
            }
        }
        if fields < 9 {
            continue;
        }
        let mut name = l[idx..].to_string();
        let is_link = kind == 'l';
        if is_link {
            if let Some(p) = name.find(" -> ") {
                name.truncate(p);
            }
        }
        if name == "." || name == ".." {
            continue;
        }
        entries.push(FsEntry {
            name,
            is_dir: kind == 'd',
            is_link,
            size,
            perms,
            owner,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

fn sh_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', "'\\''"))
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/* виконати команду в контейнері та зібрати stdout+stderr */
pub async fn exec_capture(docker: &Docker, cid: &str, cmd: Vec<String>) -> Result<String, String> {
    let exec = docker
        .create_exec(
            cid,
            CreateExecOptions {
                cmd: Some(cmd),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let start = docker
        .start_exec(&exec.id, None)
        .await
        .map_err(|e| e.to_string())?;
    let mut out = String::new();
    if let StartExecResults::Attached { mut output, .. } = start {
        while let Some(Ok(chunk)) = output.next().await {
            out.push_str(&String::from_utf8_lossy(&chunk.into_bytes()));
            if out.len() > 2 * 1024 * 1024 {
                break;
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn fs_list(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let docker = state.docker(&conn)?;
    let cmd = vec![
        "/bin/sh".to_string(),
        "-c".to_string(),
        format!("LC_ALL=C ls -lA -- {} 2>&1", sh_quote(&path)),
    ];
    let out = exec_capture(&docker, &id, cmd).await?;

    if out.contains("No such file or directory") {
        return Err(format!("шлях не знайдено: {path}"));
    }
    if out.contains("OCI runtime exec failed") || out.contains("executable file not found") {
        return Err("у контейнері немає /bin/sh — перегляд каталогів недоступний".into());
    }

    Ok(parse_ls(&out))
}

/* забрати tar-архів шляху з контейнера (працює і для зупинених) */
async fn fetch_archive(docker: &Docker, id: &str, path: &str, limit: usize) -> Result<Vec<u8>, String> {
    let opts = DownloadFromContainerOptionsBuilder::new().path(path).build();
    let mut stream = docker.download_from_container(id, Some(opts));
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
        if buf.len() > limit {
            return Err(format!("файл завеликий (> {} МБ)", limit / 1024 / 1024));
        }
    }
    Ok(buf)
}

fn extract_single(tar_bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let mut ar = tar::Archive::new(tar_bytes);
    for entry in ar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if entry.header().entry_type().is_file() {
            let name = entry
                .path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut data).map_err(|e| e.to_string())?;
            return Ok((name, data));
        }
    }
    Err("у архіві немає файлу (можливо, це каталог)".into())
}

#[tauri::command]
pub async fn fs_read(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    let docker = state.docker(&conn)?;
    let tar_bytes = fetch_archive(&docker, &id, &path, MAX_VIEW * 2).await?;
    let (_, data) = extract_single(&tar_bytes)?;
    let truncated = data.len() > MAX_VIEW;
    let slice = &data[..data.len().min(MAX_VIEW)];
    let is_binary = slice.iter().take(8000).any(|&b| b == 0);
    Ok(serde_json::json!({
        "content_b64": b64().encode(slice),
        "size": data.len(),
        "truncated": truncated,
        "binary": is_binary,
    }))
}

#[tauri::command]
pub async fn fs_write(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    path: String,
    content_b64: String,
    backup: Option<bool>,
) -> Result<(), String> {
    let docker = state.docker(&conn)?;
    let data = b64().decode(content_b64).map_err(|e| e.to_string())?;

    // B6 — бекап попередньої версії поруч (best-effort)
    if backup.unwrap_or(false) {
        let _ = exec_capture(
            &docker,
            &id,
            vec![
                "/bin/sh".into(),
                "-c".into(),
                format!("cp -p -- {q} {q}.bak 2>/dev/null", q = sh_quote(&path)),
            ],
        )
        .await;
    }
    let (dir, fname) = split_path(&path)?;

    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, fname, data.as_slice())
        .map_err(|e| e.to_string())?;
    let tar_bytes = builder.into_inner().map_err(|e| e.to_string())?;

    let opts = UploadToContainerOptionsBuilder::new().path(dir).build();
    docker
        .upload_to_container(&id, Some(opts), bollard::body_full(tar_bytes.into()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_download(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    path: String,
) -> Result<String, String> {
    let docker = state.docker(&conn)?;
    let tar_bytes = fetch_archive(&docker, &id, &path, MAX_FETCH).await?;
    let downloads = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
        .join("Downloads");
    let base = path.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("download");

    // якщо в архіві один файл — зберігаємо файл, інакше tar цілком
    match extract_single(&tar_bytes) {
        Ok((_, data)) if count_entries(&tar_bytes) == 1 => {
            let target = unique_path(&downloads.join(base));
            std::fs::write(&target, data).map_err(|e| e.to_string())?;
            Ok(target.to_string_lossy().to_string())
        }
        _ => {
            let target = unique_path(&downloads.join(format!("{base}.tar")));
            std::fs::write(&target, &tar_bytes).map_err(|e| e.to_string())?;
            Ok(target.to_string_lossy().to_string())
        }
    }
}

fn count_entries(tar_bytes: &[u8]) -> usize {
    let mut ar = tar::Archive::new(tar_bytes);
    ar.entries().map(|e| e.count()).unwrap_or(0)
}

pub fn unique_path(p: &std::path::Path) -> std::path::PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000 {
        let c = p.with_file_name(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    p.to_path_buf()
}

#[tauri::command]
pub async fn fs_upload(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    dir: String,
    filename: String,
    content_b64: String,
) -> Result<(), String> {
    let docker = state.docker(&conn)?;
    let data = b64().decode(content_b64).map_err(|e| e.to_string())?;

    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, &filename, data.as_slice())
        .map_err(|e| e.to_string())?;
    let tar_bytes = builder.into_inner().map_err(|e| e.to_string())?;

    let opts = UploadToContainerOptionsBuilder::new().path(&dir).build();
    docker
        .upload_to_container(&id, Some(opts), bollard::body_full(tar_bytes.into()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_mkdir(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    path: String,
) -> Result<(), String> {
    let docker = state.docker(&conn)?;
    let out = exec_capture(
        &docker,
        &id,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("mkdir -p -- {} 2>&1 && echo __OK__", sh_quote(&path)),
        ],
    )
    .await?;
    if out.contains("__OK__") {
        Ok(())
    } else {
        Err(out.lines().next().unwrap_or("помилка mkdir").to_string())
    }
}

#[tauri::command]
pub async fn fs_delete(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    path: String,
) -> Result<(), String> {
    if path == "/" || path.is_empty() {
        return Err("відмова: не можна видалити корінь".into());
    }
    let docker = state.docker(&conn)?;
    let out = exec_capture(
        &docker,
        &id,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("rm -rf -- {} 2>&1 && echo __OK__", sh_quote(&path)),
        ],
    )
    .await?;
    if out.contains("__OK__") {
        Ok(())
    } else {
        Err(out.lines().next().unwrap_or("помилка rm").to_string())
    }
}

/// B5 — перейменування/переміщення у контейнері
#[tauri::command]
pub async fn fs_rename(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let docker = state.docker(&conn)?;
    let out = exec_capture(
        &docker,
        &id,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("mv -- {} {} 2>&1 && echo __OK__", sh_quote(&from), sh_quote(&to)),
        ],
    )
    .await?;
    if out.contains("__OK__") {
        Ok(())
    } else {
        Err(out.lines().next().unwrap_or("помилка mv").to_string())
    }
}

/// B5 — зміна прав у контейнері
#[tauri::command]
pub async fn fs_chmod(
    state: State<'_, AppState>,
    conn: String,
    id: String,
    path: String,
    mode: String,
) -> Result<(), String> {
    if !mode.chars().all(|c| c.is_ascii_digit()) || mode.len() < 3 || mode.len() > 4 {
        return Err("режим має бути вісімковим, напр. 644".into());
    }
    let docker = state.docker(&conn)?;
    let out = exec_capture(
        &docker,
        &id,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("chmod {} -- {} 2>&1 && echo __OK__", mode, sh_quote(&path)),
        ],
    )
    .await?;
    if out.contains("__OK__") {
        Ok(())
    } else {
        Err(out.lines().next().unwrap_or("помилка chmod").to_string())
    }
}

fn split_path(path: &str) -> Result<(&str, &str), String> {
    let path = path.trim_end_matches('/');
    match path.rfind('/') {
        Some(0) => Ok(("/", &path[1..])),
        Some(i) => Ok((&path[..i], &path[i + 1..])),
        None => Err("очікується абсолютний шлях".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LS: &str = "total 52\n\
-rwxr-xr-x   1 root  root     0 Jun 18 17:26 .dockerenv\n\
lrwxrwxrwx   1 root  root     7 May 18 00:00 bin -> usr/bin\n\
drwxr-xr-x   2 redis redis 4096 Aug  5 14:27 data\n\
-rw-r--r--   1 root  root  1234 Jan  1 12:00 file with spaces.txt\n";

    #[test]
    fn parses_types_sizes_and_names() {
        let e = parse_ls(LS);
        assert_eq!(e.len(), 4, "має бути 4 записи, total/порожні — пропущені");
        // каталоги першими, далі за абеткою
        assert_eq!(e[0].name, "data");
        assert!(e[0].is_dir);
        let link = e.iter().find(|x| x.name == "bin").unwrap();
        assert!(link.is_link, "symlink розпізнається");
        assert!(!link.name.contains("->"), "ціль symlink обрізається з імені");
        let spaced = e.iter().find(|x| x.name == "file with spaces.txt").unwrap();
        assert_eq!(spaced.size, 1234);
        assert_eq!(spaced.owner, "root");
    }

    #[test]
    fn double_spaces_do_not_break_columns() {
        // регресія: вирівняні пробілами колонки раніше давали 0 записів
        let e = parse_ls("drwxr-xr-x   2 root  root  4096 Aug  5 14:27 etc\n");
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].name, "etc");
        assert_eq!(e[0].perms, "drwxr-xr-x");
    }

    #[test]
    fn skips_dot_entries_and_garbage() {
        let e = parse_ls("drwxr-xr-x 2 root root 4096 Aug 5 14:27 .\nsome noise\n");
        assert!(e.is_empty());
    }

    #[test]
    fn splits_paths() {
        assert_eq!(split_path("/etc/nginx.conf").unwrap(), ("/etc", "nginx.conf"));
        assert_eq!(split_path("/root").unwrap(), ("/", "root"));
        assert!(split_path("relative").is_err());
    }
}
