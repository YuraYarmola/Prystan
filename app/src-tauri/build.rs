use std::path::Path;

/// Файли фронтенду вшиваються в бінарник, але cargo про них не знає:
/// якщо змінити лише ui/*, збірка "успішна", а всередині лишається старий UI.
/// Тому явно повідомляємо cargo про кожен файл фронтенду.
fn watch_dir(dir: &Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            watch_dir(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn main() {
    watch_dir(Path::new("../ui"));
    tauri_build::build()
}
