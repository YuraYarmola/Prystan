//! Метадані окремо від секретів. Паролі читає лише backend; plaintext fallback немає.
use crate::{databases::DatabaseSource, AppState, Profile};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

static LOCK: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);
const SERVICE: &str = "Prystan.Database";

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    server: String,
    target: String,
    source: String,
    username: String,
    database: String,
    password_saved: bool,
}
#[derive(Clone, Serialize)]
pub struct SavedProfile {
    pub id: String,
    pub username: String,
    pub database: String,
    pub password_saved: bool,
}
impl Record {
    fn public(&self) -> SavedProfile {
        SavedProfile {
            id: self.id.clone(),
            username: self.username.clone(),
            database: self.database.clone(),
            password_saved: self.password_saved,
        }
    }
}
// Назва профілю/read-only не змінюють endpoint; хост/порт/SSH identity — змінюють.
fn target(p: &Profile) -> String {
    serde_json::to_string(&(&p.kind, &p.host, p.port, &p.user, &p.key_path)).unwrap()
}
fn source_key(s: &DatabaseSource) -> String {
    serde_json::to_string(&(
        &s.source,
        &s.engine,
        s.port,
        if s.source == "docker" {
            s.name.as_str()
        } else {
            ""
        },
    ))
    .unwrap()
}
fn matches(r: &Record, p: &Profile, s: &DatabaseSource) -> bool {
    r.server == p.id && r.target == target(p) && r.source == source_key(s)
}
fn path(state: &AppState) -> PathBuf {
    state
        .profiles_path
        .with_file_name("database-connections.json")
}
fn read(path: &Path) -> Result<Vec<Record>, String> {
    let bytes = match std::fs::read(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot read saved database profiles".into()),
    };
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Saved database profile index is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Cannot parse saved database profiles".into())
}
fn write(path: &Path, records: &[Record]) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(records).map_err(|_| "Cannot encode database profiles")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Saved database profile index is too large".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create profile directory")?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|_| "Cannot write database profile index")?;
    std::fs::rename(&tmp, path).map_err(|_| "Cannot replace database profile index".into())
}
fn entry(id: &str) -> Result<keyring::Entry, String> {
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid saved profile ID".into());
    }
    keyring::Entry::new(SERVICE, id).map_err(|_| "System credential storage is unavailable".into())
}
fn remove_secret(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Cannot delete password from system credential storage".into()),
    }
}
pub fn list(
    state: &AppState,
    p: &Profile,
    s: &DatabaseSource,
) -> Result<Vec<SavedProfile>, String> {
    let _guard = LOCK
        .lock()
        .map_err(|_| "Database profile storage is busy")?;
    let mut records = read(&path(state))?;
    records.reverse();
    Ok(records
        .iter()
        .filter(|r| matches(r, p, s))
        .map(Record::public)
        .collect())
}
pub fn credentials(
    state: &AppState,
    p: &Profile,
    s: &DatabaseSource,
    id: &str,
) -> Result<(String, String, String), String> {
    let _guard = LOCK
        .lock()
        .map_err(|_| "Database profile storage is busy")?;
    let record = read(&path(state))?
        .into_iter()
        .find(|r| r.id == id && matches(r, p, s))
        .ok_or("Saved connection does not belong to this server and database source")?;
    let password = entry(id)?
        .get_password()
        .map_err(|_| "Stored password is unavailable; enter the password again")?;
    Ok((record.username, password, record.database))
}
// Викликаємо лише після успішного database list / Redis PING.
pub fn remember(
    state: &AppState,
    p: &Profile,
    s: &DatabaseSource,
    username: &str,
    password: &str,
    database: &str,
) -> Result<SavedProfile, String> {
    let _guard = LOCK
        .lock()
        .map_err(|_| "Database profile storage is busy")?;
    let path = path(state);
    let mut records = read(&path)?;
    let old = records
        .iter()
        .find(|r| matches(r, p, s) && r.username == username && r.database == database)
        .cloned();
    if old.is_none() && records.len() >= 512 {
        return Err("Too many saved database profiles".into());
    }
    let id = old.as_ref().map(|r| r.id.clone()).unwrap_or_else(|| {
        format!(
            "db-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    });
    let vault = entry(&id)?;
    let previous = match vault.get_password() {
        Ok(p) => Some(p),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err("Cannot access system credential storage".into()),
    };
    // Навіть профілі з порожнім паролем потребують справжнього системного vault.
    vault
        .set_password(password)
        .map_err(|_| "Cannot securely save password in system credential storage")?;
    let record = Record {
        id,
        server: p.id.clone(),
        target: target(p),
        source: source_key(s),
        username: username.into(),
        database: database.into(),
        password_saved: !password.is_empty(),
    };
    records.retain(|r| r.id != record.id);
    records.push(record.clone());
    if let Err(e) = write(&path, &records) {
        let restored = if let Some(previous) = previous {
            vault
                .set_password(&previous)
                .map_err(|_| "Cannot restore previous credential")
        } else {
            remove_secret(&record.id).map_err(|_| "Cannot remove unsaved credential")
        };
        return Err(if restored.is_err() {
            "Profile index update and credential rollback failed".into()
        } else {
            e
        });
    }
    Ok(record.public())
}
pub fn forget(state: &AppState, p: &Profile, s: &DatabaseSource, id: &str) -> Result<(), String> {
    let _guard = LOCK
        .lock()
        .map_err(|_| "Database profile storage is busy")?;
    let path = path(state);
    let mut records = read(&path)?;
    let record = records
        .iter()
        .find(|r| r.id == id && matches(r, p, s))
        .ok_or("Saved connection does not belong to this server and database source")?;
    let _ = record;
    remove_secret(id)?;
    records.retain(|r| r.id != id);
    write(&path, &records)
}

pub fn forget_server(state: &AppState, server: &str) -> Result<(), String> {
    let _guard = LOCK
        .lock()
        .map_err(|_| "Database profile storage is busy")?;
    let path = path(state);
    let mut records = read(&path)?;
    if !records.iter().any(|r| r.server == server) {
        return Ok(());
    }
    for record in records.iter().filter(|r| r.server == server) {
        remove_secret(&record.id)?;
    }
    records.retain(|r| r.server != server);
    write(&path, &records)
}
#[cfg(test)]
pub struct TestStore {
    pub state: AppState,
    dir: PathBuf,
}
#[cfg(test)]
impl Drop for TestStore {
    fn drop(&mut self) {
        if let Ok(records) = read(&path(&self.state)) {
            for r in records {
                let _ = remove_secret(&r.id);
            }
        }
        let _ = std::fs::remove_file(path(&self.state));
        let _ = std::fs::remove_file(path(&self.state).with_extension("json.tmp"));
        let _ = std::fs::remove_dir(&self.dir);
    }
}
#[cfg(test)]
pub fn test_store() -> TestStore {
    let dir = std::env::temp_dir().join(format!(
        "prystan-db-store-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let state = AppState {
        started: std::time::Instant::now(),
        conns: Default::default(),
        logs_task: Default::default(),
        stats_task: Default::default(),
        terms: Default::default(),
        monitors: Default::default(),
        agents: Default::default(),
        ptys: Default::default(),
        pty_conns: Default::default(),
        forwards: Default::default(),
        multi_tasks: Default::default(),
        profiles_path: dir.join("profiles.json"),
        projects_path: dir.join("projects.json"),
    };
    TestStore { state, dir }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> DatabaseSource {
        DatabaseSource {
            id: "docker:old".into(),
            source: "docker".into(),
            engine: "postgres".into(),
            name: "db".into(),
            port: 5432,
            address: "Docker network".into(),
            state: "running".into(),
            confirmed: true,
        }
    }
    #[test]
    fn binding_follows_endpoint_and_engine_not_display_name_or_container_id() {
        let p = Profile {
            id: "a".into(),
            kind: "ssh".into(),
            host: "192.0.2.1".into(),
            port: 22,
            ..Default::default()
        };
        let s = source();
        let r = Record {
            id: "test".into(),
            server: p.id.clone(),
            target: target(&p),
            source: source_key(&s),
            username: "reader".into(),
            database: "demo".into(),
            password_saved: true,
        };
        let mut renamed = p.clone();
        renamed.name = "renamed".into();
        assert!(matches(&r, &renamed, &s));
        renamed.host = "192.0.2.2".into();
        assert!(!matches(&r, &renamed, &s));
        let mut moved = s.clone();
        moved.id = "docker:new".into();
        assert!(matches(&r, &p, &moved));
        moved.engine = "mysql".into();
        assert!(!matches(&r, &p, &moved));
        let mut other = p.clone();
        other.id = "b".into();
        assert!(!matches(&r, &other, &s));
        other = p.clone();
        other.user = "different".into();
        assert!(!matches(&r, &other, &s));
    }
    #[test]
    fn index_and_frontend_metadata_have_no_password_field() {
        let r = Record {
            id: "test".into(),
            server: "a".into(),
            target: "endpoint".into(),
            source: "db".into(),
            username: "reader".into(),
            database: "demo".into(),
            password_saved: true,
        };
        for value in [
            serde_json::to_value(&r).unwrap(),
            serde_json::to_value(r.public()).unwrap(),
        ] {
            assert!(value.get("password").is_none());
            assert!(value.get("password_saved").is_some());
        }
    }
    #[test]
    fn malformed_index_is_not_silently_overwritten() {
        let path =
            std::env::temp_dir().join(format!("prystan-db-index-{}.json", std::process::id()));
        std::fs::write(&path, b"invalid-json").unwrap();
        assert!(read(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "uses isolated temporary profile index and disposable Windows Credential Manager entries"]
    fn local_database_profile_lifecycle_and_index_failure_rollback() {
        let store = test_store();
        let state = &store.state;
        let p = Profile {
            id: "vault-test".into(),
            kind: "local".into(),
            ..Default::default()
        };
        let s = source();
        let saved = remember(state, &p, &s, "reader", "disposable-initial-secret", "demo").unwrap();
        assert_eq!(
            credentials(state, &p, &s, &saved.id).unwrap().1,
            "disposable-initial-secret"
        );
        let second =
            remember(state, &p, &s, "reader", "disposable-updated-secret", "demo").unwrap();
        assert_eq!(saved.id, second.id);
        assert_eq!(list(state, &p, &s).unwrap().len(), 1);
        assert!(!std::fs::read_to_string(path(state))
            .unwrap()
            .contains("disposable-"));
        let mut other = p.clone();
        other.host = "192.0.2.10".into();
        assert!(credentials(state, &other, &s, &saved.id).is_err());
        let tmp = path(state).with_extension("json.tmp");
        std::fs::create_dir(&tmp).unwrap();
        let failed = remember(
            state,
            &p,
            &s,
            "reader",
            "disposable-rollback-secret",
            "demo",
        );
        std::fs::remove_dir(tmp).unwrap();
        assert!(failed.is_err());
        assert_eq!(
            credentials(state, &p, &s, &saved.id).unwrap().1,
            "disposable-updated-secret"
        );
        let empty = remember(state, &p, &s, "reader", "", "demo").unwrap();
        assert!(!empty.password_saved);
        assert_eq!(credentials(state, &p, &s, &empty.id).unwrap().1, "");
        forget(state, &p, &s, &saved.id).unwrap();
        assert!(list(state, &p, &s).unwrap().is_empty());
        assert!(matches!(
            entry(&saved.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "writes and deletes one uniquely named disposable Windows Credential Manager entry"]
    fn local_database_vault_roundtrip() {
        let id = format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let e = entry(&id).unwrap();
        e.set_password("disposable-vault-test").unwrap();
        let actual = e.get_password();
        let deleted = remove_secret(&id);
        assert_eq!(actual.unwrap(), "disposable-vault-test");
        deleted.unwrap();
        assert!(matches!(e.get_password(), Err(keyring::Error::NoEntry)));
    }
}
