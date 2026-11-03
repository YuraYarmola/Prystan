//! SQL-консоль і потоковий логічний експорт; лише за явною дією користувача.
use super::*;
use std::{io::Write, path::PathBuf};

fn resolve(
    state: &AppState,
    conn: &str,
    mut r: BrowseRequest,
) -> Result<(DatabaseSource, BrowseRequest), String> {
    let (p, s, d) = {
        let conns = state.conns.lock().unwrap();
        let c = conns.get(conn).ok_or("Server is disconnected")?;
        let s = c
            .database_sources
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.id == r.source_id)
            .cloned()
            .ok_or("Rescan the selected server")?;
        (c.database_profile.clone(), s, c.docker.clone())
    };
    if s.state != "running" {
        return Err("Database is not running".into());
    }
    if !r.saved_profile_id.is_empty() {
        let (u, pw, db) =
            crate::database_profiles::credentials(state, &p, &s, &r.saved_profile_id)?;
        r.username = u;
        r.password = pw;
        if r.database.is_empty() {
            r.database = db;
        }
    }
    for v in [&r.database, &r.username, &r.password] {
        if v.contains('\0') || v.len() > 4096 {
            return Err("Invalid database parameter".into());
        }
    }
    r.transport_profile = Some(p);
    r.transport_docker = Some(d);
    Ok((s, r))
}

// Один SQL statement. Не приймаємо команди CLI (\!, source, delimiter) або executable comments.
fn statement(sql: &str, engine: &str) -> Result<String, String> {
    if sql.len() > 65536 || sql.contains('\0') {
        return Err("SQL must fit in 64 KiB".into());
    }
    let b = sql.as_bytes();
    let mut i = 0;
    let mut ended = false;
    let mut cleaned = String::new();
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            cleaned.push(b[i] as char);
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"--") || (engine == "mysql" && b[i] == b'#') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            cleaned.push(' ');
            continue;
        }
        if b[i..].starts_with(b"/*") {
            if b.get(i + 2) == Some(&b'!') || b.get(i + 2) == Some(&b'+') {
                return Err("Executable SQL comments are not supported".into());
            }
            let start = i + 2;
            i = start;
            while i + 1 < b.len() && !b[i..].starts_with(b"*/") {
                if b[i..].starts_with(b"/*") {
                    return Err("Nested SQL comments are not supported".into());
                }
                i += 1;
            }
            if i + 1 >= b.len() {
                return Err("Unclosed SQL comment".into());
            }
            i += 2;
            cleaned.push(' ');
            continue;
        }
        if ended {
            return Err("Run one SQL statement at a time".into());
        }
        if b[i] == b';' {
            ended = true;
            i += 1;
            continue;
        }
        let start = i;
        if [b'\'', b'"', b'`'].contains(&b[i]) {
            let q = b[i];
            let escaped = engine != "postgres"
                || (q == b'\'' && i > 0 && (b[i - 1] == b'E' || b[i - 1] == b'e'));
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if escaped && b[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if b[i] == q {
                    if b.get(i + 1) == Some(&q) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err("Unclosed SQL string".into());
            }
        } else if engine == "postgres" && b[i] == b'$' {
            let mut e = i + 1;
            while e < b.len() && (b[e].is_ascii_alphanumeric() || b[e] == b'_') {
                e += 1;
            }
            if b.get(e) == Some(&b'$') {
                let tag = &sql[i..=e];
                let rest = &sql[e + 1..];
                let end = rest.find(tag).ok_or("Unclosed dollar quote")?;
                i = e + 1 + end + tag.len();
            } else {
                i += 1;
            }
        } else {
            i += 1;
            while i < b.len() && !b[i].is_ascii() {
                i += 1;
            }
        }
        cleaned.push_str(&sql[start..i]);
    }
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return Err("Enter SQL first".into());
    }
    for line in cleaned.lines() {
        let l = line.trim_start().to_ascii_lowercase();
        if l.starts_with('\\')
            || ["delimiter ", "source ", "system ", "tee ", "pager "]
                .iter()
                .any(|p| l.starts_with(p))
        {
            return Err("SQL only; client commands are disabled".into());
        }
    }
    Ok(cleaned.into())
}
fn query_script(
    s: &DatabaseSource,
    r: &BrowseRequest,
    sql: &str,
    write: bool,
) -> Result<String, String> {
    let sql = statement(sql, &s.engine)?;
    let query = if write {
        sql
    } else {
        let first = sql
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if !["SELECT", "WITH"].contains(&first.as_str()) {
            return Err(
                "Read mode accepts SELECT/WITH. Enable changes for other SQL statements".into(),
            );
        }
        format!("SELECT * FROM ({sql}) AS prystan_result LIMIT 1001")
    };
    let args = match s.engine.as_str() {
        "postgres" => vec![
            "--csv".into(),
            "-q".into(),
            "-P".into(),
            "footer=off".into(),
            "-v".into(),
            "ON_ERROR_STOP=1".into(),
            "-c".into(),
            query,
        ],
        "mysql" => vec![
            "--binary-mode".into(),
            "--xml".into(),
            "--database".into(),
            r.database.clone(),
            "--execute".into(),
            if write {
                query
            } else {
                format!("SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY; {query}; ROLLBACK;")
            },
        ],
        "clickhouse" => vec![
            "--database".into(),
            r.database.clone(),
            "--output_format_json_quote_decimals=1".into(),
            "--format".into(),
            "JSON".into(),
            "--query".into(),
            query,
        ],
        _ => return Err("Redis does not support SQL".into()),
    };
    let mut script = cli_script(s, r, &args);
    script = script.replace("psql -X -A -t -w", "psql -X -w");
    if write {
        script = script
            .replace(
                "default_transaction_read_only=on",
                "default_transaction_read_only=off",
            )
            .replace("--readonly=1", "--readonly=0");
    }
    Ok(script)
}
fn query_result(engine: &str, out: &str) -> Result<Value, String> {
    let (columns, mut rows): (Vec<String>, Vec<Vec<Value>>) = match engine {
        "clickhouse" => {
            if out.trim().is_empty() {
                return Ok(json!({"columns":[],"rows":[],"more":false}));
            }
            let v: Value = serde_json::from_str(out).map_err(|_| "Invalid ClickHouse result")?;
            let names: Vec<String> = v["meta"]
                .as_array()
                .ok_or("Missing ClickHouse metadata")?
                .iter()
                .map(|m| m["name"].as_str().unwrap_or("").into())
                .collect();
            let rows = v["data"]
                .as_array()
                .ok_or("Missing ClickHouse rows")?
                .iter()
                .map(|r| names.iter().map(|n| r[n].clone()).collect())
                .collect();
            (names, rows)
        }
        "mysql" => mysql_xml(out)?,
        _ => {
            if out.trim().is_empty() {
                return Ok(json!({"columns":[],"rows":[],"more":false}));
            }
            let records = pg_csv(out)?;
            let names = records
                .first()
                .ok_or("Missing SQL headings")?
                .iter()
                .map(|v| v.as_str().unwrap_or("").into())
                .collect();
            (names, records.into_iter().skip(1).collect())
        }
    };
    let more = rows.len() > 1000;
    rows.truncate(1000);
    Ok(json!({"columns":columns,"rows":rows,"more":more}))
}
fn pg_csv(text: &str) -> Result<Vec<Vec<Value>>, String> {
    let mut chars = text.chars().peekable();
    let mut records = vec![];
    let mut row = vec![];
    let mut value = String::new();
    let mut quoted = false;
    let mut inside = false;
    while let Some(c) = chars.next() {
        if inside {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    value.push('"');
                } else {
                    inside = false;
                }
            } else {
                value.push(c);
            }
            continue;
        }
        match c {
            '"' if value.is_empty() => {
                inside = true;
                quoted = true;
            }
            ',' | '\n' => {
                row.push(if !quoted && value.is_empty() {
                    Value::Null
                } else {
                    json!(value)
                });
                value.clear();
                quoted = false;
                if c == '\n' {
                    records.push(std::mem::take(&mut row));
                }
            }
            '\r' if chars.peek() == Some(&'\n') => {}
            _ => value.push(c),
        }
    }
    if inside {
        return Err("Unclosed CSV result".into());
    }
    if quoted || !value.is_empty() || !row.is_empty() {
        row.push(if !quoted && value.is_empty() {
            Value::Null
        } else {
            json!(value)
        });
        records.push(row);
    }
    if let Some(columns) = records.first() {
        if records.iter().any(|r| r.len() != columns.len()) {
            return Err("SQL result has inconsistent columns".into());
        }
    }
    Ok(records)
}
fn mysql_xml(out: &str) -> Result<(Vec<String>, Vec<Vec<Value>>), String> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(out);
    let mut columns = vec![];
    let mut rows = vec![];
    let mut row = vec![];
    let mut name = String::new();
    let mut value = String::new();
    let mut in_field = false;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| "Invalid MySQL XML result")?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(e) if e.name().as_ref() == b"row" => row.clear(),
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"field" => {
                name.clear();
                value.clear();
                let mut null = false;
                for a in e.attributes() {
                    let a = a.map_err(|_| "Invalid XML attribute")?;
                    if a.key.as_ref() == b"name" {
                        name = a
                            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .map_err(|_| "Invalid column name")?
                            .into_owned();
                    }
                    if a.key.as_ref() == b"xsi:nil" {
                        null = a.value.as_ref() == b"true";
                    }
                }
                in_field = true;
                if null || empty {
                    if rows.is_empty() {
                        columns.push(name.clone());
                    }
                    row.push(if null { Value::Null } else { json!("") });
                    in_field = false;
                }
            }
            Event::Text(e) if in_field => value.push_str(
                &quick_xml::escape::unescape(&e.decode().map_err(|_| "Invalid text")?)
                    .map_err(|_| "Invalid XML escape")?,
            ),
            Event::GeneralRef(e) if in_field => {
                let entity = format!("&{};", e.decode().map_err(|_| "Invalid XML entity")?);
                value.push_str(
                    &quick_xml::escape::unescape(&entity).map_err(|_| "Invalid XML entity")?,
                );
            }
            Event::CData(e) if in_field => {
                value.push_str(&e.decode().map_err(|_| "Invalid CDATA")?)
            }
            Event::End(e) if e.name().as_ref() == b"field" && in_field => {
                if rows.is_empty() {
                    columns.push(name.clone());
                }
                row.push(Value::String(value.clone()));
                in_field = false;
            }
            Event::End(e) if e.name().as_ref() == b"row" => rows.push(row.clone()),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok((columns, rows))
}
async fn capture(s: &DatabaseSource, r: &BrowseRequest, script: String) -> Result<String, String> {
    let result = if s.source == "host" {
        let mut cmd = crate::host::ssh_command(r.transport_profile.as_ref().unwrap());
        cmd.arg("sh -s");
        ssh_script(cmd, script, 20).await
    } else {
        docker_read(
            r.transport_docker.as_ref().unwrap(),
            s.id.strip_prefix("docker:").ok_or("Invalid container")?,
            r,
            script,
        )
        .await
    };
    result.map_err(|e| {
        if r.password.is_empty() {
            e
        } else {
            e.replace(&r.password, "***")
        }
    })
}
#[tauri::command]
pub async fn database_query(
    state: State<'_, AppState>,
    conn: String,
    request: BrowseRequest,
    sql: String,
    allow_write: bool,
) -> Result<Value, String> {
    query(&state, &conn, request, &sql, allow_write).await
}
pub(super) async fn query(
    state: &AppState,
    conn: &str,
    request: BrowseRequest,
    sql: &str,
    allow_write: bool,
) -> Result<Value, String> {
    state.require_writable(conn)?;
    let (s, r) = resolve(state, conn, request)?;
    // Snapshot також перевіряємо: профіль міг змінитися між policy check і захопленням transport.
    if r.transport_profile.as_ref().unwrap().readonly {
        return Err("SQL console is disabled on read-only server profiles".into());
    }
    let script = query_script(&s, &r, &sql, allow_write)?;
    let started = std::time::Instant::now();
    let out = capture(&s, &r, script).await.map_err(|e| {
        format!(
            "{e}{}",
            if allow_write {
                " (Changes may already have applied; do not retry blindly.)"
            } else {
                ""
            }
        )
    })?;
    let mut result = query_result(&s.engine, &out)?;
    result["elapsed_ms"] = json!(started.elapsed().as_millis());
    Ok(result)
}

const DUMP_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
struct Partial {
    path: PathBuf,
}
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
fn append(file: &mut std::fs::File, bytes: &[u8], total: &mut u64) -> Result<(), String> {
    *total += bytes.len() as u64;
    if *total > DUMP_LIMIT {
        return Err("Dump exceeds 2 GiB local safety limit".into());
    }
    file.write_all(bytes)
        .map_err(|_| "Cannot write local dump".into())
}
async fn stream_dump(
    s: &DatabaseSource,
    r: &BrowseRequest,
    script: String,
    file: &mut std::fs::File,
) -> Result<u64, String> {
    let mut total = 0u64;
    let work = async {
        if s.source == "host" {
            let mut cmd = crate::host::ssh_command(r.transport_profile.as_ref().unwrap());
            cmd.arg("sh -s");
            let mut child = cmd
                .kill_on_drop(true)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            let mut input = child.stdin.take().unwrap();
            let mut output = child.stdout.take().unwrap();
            let error = child.stderr.take().unwrap();
            let send = async {
                input
                    .write_all(script.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                input.shutdown().await.map_err(|e| e.to_string())?;
                drop(input);
                Ok::<_, String>(())
            };
            let read = async {
                let mut buf = [0u8; 65536];
                loop {
                    let n = output.read(&mut buf).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    append(file, &buf[..n], &mut total)?;
                }
                Ok::<_, String>(())
            };
            let err = async {
                let mut bytes = vec![];
                error
                    .take(65536)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok::<_, String>(bytes)
            };
            let (_, _, err) = tokio::try_join!(send, read, err)?;
            if !child.wait().await.map_err(|e| e.to_string())?.success() {
                return Err(String::from_utf8_lossy(&err).chars().take(600).collect());
            }
        } else {
            let docker = r.transport_docker.as_ref().unwrap();
            let cid = s.id.strip_prefix("docker:").ok_or("Invalid container")?;
            let (_, script) = script.split_once('\n').ok_or("Invalid dump script")?;
            let env = vec![
                format!("PRYSTAN_DB_USER={}", r.username),
                format!("PRYSTAN_DB_PASSWORD={}", r.password),
                format!("PGDATABASE={}", r.database),
            ];
            let exec = docker
                .create_exec(
                    cid,
                    CreateExecOptions {
                        cmd: Some(vec!["sh".into(), "-c".into(), script.into()]),
                        env: Some(env),
                        attach_stdout: Some(true),
                        attach_stderr: Some(true),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
            let mut err = vec![];
            if let StartExecResults::Attached { mut output, .. } = docker
                .start_exec(&exec.id, None)
                .await
                .map_err(|e| e.to_string())?
            {
                while let Some(chunk) = output.next().await {
                    let chunk = chunk.map_err(|e| e.to_string())?;
                    if matches!(&chunk, bollard::container::LogOutput::StdErr { .. }) {
                        let b = chunk.into_bytes();
                        if err.len() < 65536 {
                            err.extend_from_slice(&b[..b.len().min(65536 - err.len())]);
                        }
                    } else {
                        append(file, &chunk.into_bytes(), &mut total)?;
                    }
                }
            } else {
                return Err("Dump did not attach".into());
            }
            if docker
                .inspect_exec(&exec.id)
                .await
                .map_err(|e| e.to_string())?
                .exit_code
                != Some(0)
            {
                return Err(String::from_utf8_lossy(&err).chars().take(600).collect());
            }
        }
        Ok(total)
    };
    tokio::time::timeout(Duration::from_secs(620), work)
        .await
        .map_err(|_| "Dump timed out (10 minutes)".to_string())?
}
fn native_dump(s: &DatabaseSource, r: &BrowseRequest) -> Result<String, String> {
    let args = vec![format!("--port={}", s.port)];
    let base = cli_script(s, r, &args);
    match s.engine.as_str(){
        "postgres"=>Ok(base.replace("psql -X -A -t -w","pg_dump -w --format=custom --no-owner --no-acl --lock-wait-timeout=2000").replace("-c statement_timeout=5000","-c statement_timeout=600000").replace("timeout 12 ","timeout 600 ")),
        "mysql"=>Ok(base.replace("DB_CLIENT=mysql; command -v mysql >/dev/null 2>&1 || DB_CLIENT=mariadb;","DB_CLIENT=mysqldump; command -v mysqldump >/dev/null 2>&1 || DB_CLIENT=mariadb-dump;").replace("--batch --raw --skip-column-names --default-character-set=utf8mb4","--single-transaction --quick --skip-lock-tables --skip-add-locks --skip-add-drop-table --no-tablespaces --hex-blob --default-character-set=utf8mb4").replace("timeout 12 ","timeout 600 ").replace("--connect-timeout=5","").replace("exec timeout 600 \"$DB_CLIENT\" --no-defaults", "DUMP_GTID=; \"$DB_CLIENT\" --version | grep -qi mariadb || DUMP_GTID=--set-gtid-purged=OFF; exec timeout 600 \"$DB_CLIENT\" --no-defaults $DUMP_GTID")),
        _=>Err("Unsupported native dump".into())
    }.map(|mut script|{if s.engine=="mysql"{script=script.trim_end().to_string()+" --databases "+&sq(&r.database)+"\n";}script})
}
const REDIS_EXPORT: &str = r#"local function hex(s) return (s:gsub('.',function(c)return string.format('%02x',string.byte(c))end))end
local scan=redis.call('SCAN',ARGV[1],'COUNT',50);local items={};local bytes=0;local now=redis.call('TIME');local ms=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)
for _,k in ipairs(scan[2]) do local d=redis.call('DUMP',k);if d then if #d>131072 then return redis.error_reply('Key exceeds 128 KiB safe export limit') end;local ttl=redis.call('PTTL',k);local item={key_hex=hex(k),dump_hex=hex(d),expire_at_ms=ttl>=0 and ms+ttl or -1};bytes=bytes+#d*2+#k*2;if bytes>500000 then return redis.error_reply('Batch exceeds safe export limit') end;table.insert(items,item)end end
return {scan[1],cjson.encode(items)}"#;
#[tauri::command]
pub async fn database_dump(
    state: State<'_, AppState>,
    conn: String,
    request: BrowseRequest,
) -> Result<Value, String> {
    dump_to(&state, &conn, request, &crate::files::downloads_dir()).await
}
pub(super) async fn dump_to(
    state: &AppState,
    conn: &str,
    request: BrowseRequest,
    dir: &std::path::Path,
) -> Result<Value, String> {
    let (s, r) = resolve(state, conn, request)?;
    if r.database.is_empty() {
        return Err("Select a database first".into());
    }
    let extension = match s.engine.as_str() {
        "postgres" => "dump",
        "redis" => "redis.jsonl",
        _ => "sql",
    };
    let safe: String = r
        .database
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let target = dir.join(format!("Prystan-{}-{safe}-{stamp}.{extension}", s.engine));
    let partial = Partial {
        path: target.with_extension("partial"),
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&partial.path)
        .map_err(|_| "Cannot create local dump")?;
    let work = async {
        if s.engine == "redis" {
            let mut cursor = "0".to_string();
            let mut total = 0;
            append(
                &mut file,
                b"{\"format\":\"prystan-redis-logical-v1\",\"consistent_snapshot\":false}\n",
                &mut total,
            )?;
            let mut n = 0;
            loop {
                let value = redis_read(
                    &state,
                    &conn,
                    &s,
                    &r,
                    vec![
                        "EVAL_RO".into(),
                        REDIS_EXPORT.into(),
                        "0".into(),
                        cursor.clone(),
                    ],
                )
                .await?;
                cursor = value[0]
                    .as_str()
                    .ok_or("Invalid Redis export cursor")?
                    .into();
                let items: Value =
                    serde_json::from_str(value[1].as_str().ok_or("Invalid Redis export batch")?)
                        .map_err(|_| "Invalid Redis export records")?;
                if let Some(items) = items.as_array() {
                    for item in items {
                        append(&mut file, format!("{item}\n").as_bytes(), &mut total)?;
                        n += 1;
                        if n > 1_000_000 {
                            return Err("Redis export exceeds 1 million key limit".into());
                        }
                    }
                }
                if cursor == "0" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Ok(total)
        } else if s.engine == "clickhouse" {
            let sql=format!("SELECT name,engine FROM system.tables WHERE database={} ORDER BY endsWith(engine,'View'),name LIMIT 2001 FORMAT JSON",lit(&r.database).replace('\\',"\\\\"));
            let items = sql_read(&state, &conn, &s, &r, sql).await?;
            let items = items.as_array().ok_or("Invalid table metadata")?;
            if items.len() > 2000 {
                return Err("ClickHouse dump is limited to 2000 tables".into());
            }
            let mut script = cli_script(&s, &r, &[]);
            script = script.split_once('\n').unwrap().0.to_string()
                + "\nset -e\nprintf '%s\\n' "
                + &sq(&format!(
                    "CREATE DATABASE IF NOT EXISTS {};",
                    ident(&r.database, false).replace('\\', "\\\\")
                ))
                + "\n";
            for table in items {
                let name = table["name"].as_str().ok_or("Invalid table name")?;
                let engine = table["engine"].as_str().unwrap_or("");
                if engine.starts_with("Materialized")
                    || engine == "Distributed"
                    || name.starts_with(".inner")
                {
                    return Err("This database has materialized/distributed/internal tables; use a dedicated backup strategy".into());
                }
                let relation = format!(
                    "{}.{}",
                    ident(&r.database, false).replace('\\', "\\\\"),
                    ident(name, false).replace('\\', "\\\\")
                );
                for query in [
                    format!("SHOW CREATE TABLE {relation} FORMAT TabSeparatedRaw"),
                    if engine.ends_with("View") {
                        String::new()
                    } else {
                        format!("SELECT * FROM {relation} FORMAT SQLInsert")
                    },
                ] {
                    if query.is_empty() {
                        continue;
                    }
                    let args = vec![
                        "--database".into(),
                        r.database.clone(),
                        "--output_format_sql_insert_table_name".into(),
                        relation.clone(),
                        "--query".into(),
                        query,
                    ];
                    let single = cli_script(&s, &r, &args);
                    let cmd=single.split_once('\n').unwrap().1.replace("exec timeout 12","timeout 600").replace("--max_execution_time=5 --max_result_rows=2001 --result_overflow_mode=throw","--max_execution_time=600 --max_threads=1 --max_memory_usage=268435456");
                    script.push_str(&cmd);
                    script.push_str("printf ';\\n'\n");
                }
            }
            // Обмежуємо час усієї послідовності таблиць також на сервері,
            // навіть якщо локальний транспорт уже закрився.
            let (env, body) = script.split_once('\n').ok_or("Invalid dump script")?;
            let script = format!("{env}\nexec timeout 600 sh -c {}\n", sq(body));
            stream_dump(&s, &r, script, &mut file).await
        } else {
            stream_dump(&s, &r, native_dump(&s, &r)?, &mut file).await
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(620), work)
        .await
        .map_err(|_| "Dump timed out (10 minutes)".to_string())?;
    let bytes = result.map_err(|e| {
        if r.password.is_empty() {
            e
        } else {
            e.replace(&r.password, "***")
        }
    })?;
    file.flush().map_err(|_| "Cannot flush dump")?;
    file.sync_all().map_err(|_| "Cannot finalize dump")?;
    drop(file);
    if target.exists() {
        return Err("Dump destination already exists".into());
    }
    std::fs::rename(&partial.path, &target).map_err(|_| "Cannot finalize local dump")?;
    Ok(json!({"path":target.to_string_lossy(),"bytes":bytes,"engine":s.engine}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sql_is_single_and_cli_commands_are_rejected() {
        for sql in [
            "select 1; drop table t",
            "\\! touch /tmp/pwn",
            "SELECT 1; /*! DROP TABLE t */",
            "SELECT 1 /* unterminated",
        ] {
            assert!(statement(sql, "postgres").is_err(), "{sql}");
        }
        assert_eq!(
            statement("select ';' as value; -- trailing", "postgres").unwrap(),
            "select ';' as value"
        );
        assert!(statement("SELECT $$a;b$$;", "postgres").is_ok());
    }
    #[test]
    fn csv_preserves_null_empty_quotes_and_multiline() {
        let rows = pg_csv("a,b,c\r\n,\"\",\"line1\nline2 \"\"quoted\"\"\"\r\n").unwrap();
        assert_eq!(
            rows[1],
            vec![Value::Null, json!(""), json!("line1\nline2 \"quoted\"")]
        );
        assert!(pg_csv("a,b\n1\n").is_err());
        assert!(pg_csv("a\n\"unfinished").is_err());
    }
    #[test]
    fn failed_partial_exports_are_removed_and_size_is_bounded() {
        let path =
            std::env::temp_dir().join(format!("prystan-partial-test-{}", std::process::id()));
        let partial = Partial { path: path.clone() };
        let mut file = std::fs::File::create(&path).unwrap();
        let mut total = DUMP_LIMIT;
        assert!(append(&mut file, b"x", &mut total).is_err());
        assert_eq!(file.metadata().unwrap().len(), 0);
        drop(file);
        drop(partial);
        assert!(!path.exists());
    }
    #[test]
    fn xml_preserves_null_and_escaped_text() {
        let(c,r)=mysql_xml(r#"<?xml version="1.0"?><resultset><row><field name="a">a&amp;b</field><field name="b" xsi:nil="true" /></row><row><field name="a">x</field><field name="b">NULL</field></row></resultset>"#).unwrap();
        assert_eq!(c, vec!["a", "b"]);
        assert_eq!(r[0], vec![json!("a&b"), Value::Null]);
        assert_eq!(r[1][1], json!("NULL"));
    }
}
