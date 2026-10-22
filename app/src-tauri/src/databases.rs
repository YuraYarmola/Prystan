//! Лише фіксовані операції читання. SQL і команди оболонки з UI не приймаємо.
use crate::AppState;
use bollard::{
    exec::{CreateExecOptions, StartExecResults},
    models::ContainerSummary,
    query_parameters::ListContainersOptionsBuilder,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DatabaseSource {
    pub id: String,
    pub engine: String,
    pub name: String,
    pub source: String,
    pub state: String,
    pub port: u16,
    pub address: String,
    pub confirmed: bool,
}

#[derive(Clone, Deserialize, Default)]
pub struct BrowseRequest {
    pub source_id: String,
    pub action: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub schema: String,
    #[serde(default)]
    pub table: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub cursor: String,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub saved_profile_id: String,
    #[serde(default)]
    pub remember: bool,
    #[serde(skip)]
    pub transport_profile: Option<crate::Profile>,
    #[serde(skip)]
    pub transport_docker: Option<bollard::Docker>,
    #[serde(default)]
    pub filter_column: String,
    #[serde(default)]
    pub filter_op: String,
    #[serde(default)]
    pub filter_value: String,
    #[serde(default)]
    pub order_column: String,
    #[serde(default)]
    pub order_desc: bool,
    #[serde(default)]
    pub page_size: u32,
}

fn image_engine(image: &str) -> Option<&'static str> {
    let image = image
        .split('@')
        .next()?
        .rsplit('/')
        .next()?
        .split(':')
        .next()?;
    match image {
        "postgres" | "postgresql" | "postgis" | "pgvector" | "timescaledb" | "timescaledb-ha" => {
            Some("postgres")
        }
        "mysql" | "mysql-server" | "mariadb" | "mariadb-server" => Some("mysql"),
        "clickhouse-server" => Some("clickhouse"),
        "redis" | "redis-stack" | "redis-stack-server" => Some("redis"),
        _ => None,
    }
}
fn default_port(engine: &str) -> u16 {
    match engine {
        "postgres" => 5432,
        "mysql" => 3306,
        "clickhouse" => 9000,
        "redis" => 6379,
        _ => 0,
    }
}
fn docker_sources(list: Vec<ContainerSummary>) -> Vec<DatabaseSource> {
    list.into_iter()
        .filter_map(|c| {
            let engine = image_engine(c.image.as_deref().unwrap_or(""))?;
            let id = c.id?;
            let name = c
                .names
                .unwrap_or_default()
                .first()
                .cloned()
                .unwrap_or_else(|| id.clone());
            let ports = c
                .ports
                .unwrap_or_default()
                .into_iter()
                .filter_map(|p| {
                    p.public_port.map(|port| {
                        format!("{}:{} → {}", p.ip.unwrap_or_default(), port, p.private_port)
                    })
                })
                .collect::<Vec<_>>()
                .join(", ");
            Some(DatabaseSource {
                id: format!("docker:{id}"),
                engine: engine.into(),
                name: name.trim_start_matches('/').into(),
                source: "docker".into(),
                state: c
                    .state
                    .map(|s| s.to_string().to_lowercase())
                    .unwrap_or_default(),
                port: default_port(engine),
                address: if ports.is_empty() {
                    "Docker network".into()
                } else {
                    ports
                },
                confirmed: true,
            })
        })
        .collect()
}
fn host_sources(text: &str) -> Vec<DatabaseSource> {
    let mut result = Vec::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        let proc_address;
        let address_field = if fields.get(3) == Some(&"0A") {
            let Some(hex) = fields.get(1).and_then(|s| s.rsplit(':').next()) else {
                continue;
            };
            let Ok(port) = u16::from_str_radix(hex, 16) else {
                continue;
            };
            proc_address = format!("127.0.0.1:{port}");
            Some(&proc_address as &str)
        } else {
            fields.get(3).copied()
        };
        let Some(address) = address_field else {
            continue;
        };
        let Some(port) = address
            .rsplit(':')
            .next()
            .and_then(|s| s.parse::<u16>().ok())
        else {
            continue;
        };
        let lower = line.to_lowercase();
        let detected = if lower.contains("postgres") {
            Some("postgres")
        } else if lower.contains("mysqld") || lower.contains("mariadbd") {
            Some("mysql")
        } else if lower.contains("redis-server") {
            Some("redis")
        } else if lower.contains("clickhouse") && port == 9000 {
            Some("clickhouse")
        } else {
            None
        };
        let inferred = match port {
            5432 => Some("postgres"),
            3306 => Some("mysql"),
            6379 => Some("redis"),
            9000 => Some("clickhouse"),
            _ => None,
        };
        let Some(engine) = detected.or(inferred) else {
            continue;
        };
        let id = format!("host:{engine}:{port}");
        if result.iter().any(|s: &DatabaseSource| s.id == id) {
            continue;
        }
        result.push(DatabaseSource {
            id,
            engine: engine.into(),
            name: format!("{engine} :{port}"),
            source: "host".into(),
            state: "running".into(),
            port,
            address: address.to_string(),
            confirmed: detected.is_some(),
        });
    }
    result
}

// Дані сеансу надсилаємо через stdin, а не аргументи ssh / журнал команд.
async fn ssh_read(state: &AppState, conn: &str, script: String) -> Result<String, String> {
    let profile = state.conns.lock().unwrap().get(conn).ok_or("Server is disconnected")?.database_profile.clone();
    if profile.kind != "ssh" {
        return Err("SSH required".into());
    }
    let mut command = crate::host::ssh_command(&profile);
    command.arg("sh -s");
    ssh_script(command, script, 20).await
}

async fn ssh_script(
    mut command: tokio::process::Command,
    script: String,
    seconds: u64,
) -> Result<String, String> {
    let mut child = command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut input = child.stdin.take().ok_or("SSH stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("SSH stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("SSH stderr unavailable")?;
    let work = async {
        let send = async {
            input
                .write_all(script.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            input.shutdown().await.map_err(|e| e.to_string())?;
            // shutdown() не закриває Windows pipe; sh -s чекає EOF.
            drop(input);
            Ok::<_, String>(())
        };
        let read = |stream: tokio::process::ChildStdout| async move {
            let mut bytes = Vec::new();
            stream
                .take((MAX_OUTPUT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(bytes)
        };
        let err = async {
            let mut bytes = Vec::new();
            stderr
                .take((MAX_OUTPUT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(bytes)
        };
        let (_, out, err) = tokio::try_join!(send, read(stdout), err)?;
        if out.len() > MAX_OUTPUT || err.len() > MAX_OUTPUT {
            return Err("Result exceeds 1 MiB; choose a smaller table or value".into());
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(String::from_utf8_lossy(&err).chars().take(600).collect());
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(Duration::from_secs(seconds), work)
        .await
        .map_err(|_| format!("Database operation timed out ({seconds} s)"))?
}

// Один короткий запит лише до вибраного SSH-хоста; без пошуку мережі/файлів.
const HOST_DISCOVERY: &str =
    "if command -v ss >/dev/null 2>&1; then ss -H -lntp 2>/dev/null && exit 0; fi
for f in /proc/net/tcp /proc/net/tcp6; do if [ -r \"$f\" ]; then cat \"$f\"; fi; done
";

async fn discover(state: &AppState, conn: &str) -> Result<Value, String> {
    let cache = state
        .conns
        .lock()
        .unwrap()
        .get(conn)
        .ok_or("Server is disconnected")?
        .database_sources
        .clone();
    let profile = state.conns.lock().unwrap().get(conn).ok_or("Server is disconnected")?.database_profile.clone();
    let docker = state.docker(conn).ok();
    let docker_scan = async {
        if let Some(docker) = docker {
            match tokio::time::timeout(
                Duration::from_secs(5),
                docker.list_containers(Some(ListContainersOptionsBuilder::new().all(true).build())),
            )
            .await
            {
                Ok(Ok(list)) => (docker_sources(list), None),
                Ok(Err(_)) => (
                    vec![],
                    Some("Docker unavailable; host discovery is independent".to_string()),
                ),
                Err(_) => (vec![], Some("Docker discovery timed out (5 s)".to_string())),
            }
        } else {
            (vec![], None)
        }
    };
    let host_scan = async {
        if profile.kind != "ssh" {
            return (vec![], None);
        }
        match tokio::time::timeout(
            Duration::from_secs(6),
            ssh_read(state, conn, HOST_DISCOVERY.into()),
        )
        .await
        {
            Ok(Ok(out)) => (host_sources(&out), None),
            Ok(Err(e)) => (vec![], Some(format!("Host: {e}"))),
            Err(_) => (
                vec![],
                Some("Host discovery timed out (6 s); retry the selected server".to_string()),
            ),
        }
    };
    let ((mut sources, docker_warning), (host, host_warning)) =
        tokio::join!(docker_scan, host_scan);
    sources.extend(host);
    sources.sort_by(|a, b| (&a.source, &a.engine, &a.name).cmp(&(&b.source, &b.engine, &b.name)));
    *cache.lock().unwrap() = sources.clone();
    let warnings: Vec<_> = [docker_warning, host_warning]
        .into_iter()
        .flatten()
        .collect();
    Ok(json!({"sources":sources,"warnings":warnings}))
}
#[tauri::command]
pub async fn database_discover(state: State<'_, AppState>, conn: String) -> Result<Value, String> {
    discover(&state, &conn).await
}

fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn ident(s: &str, mysql: bool) -> String {
    let c = if mysql { '`' } else { '"' };
    format!("{c}{}{c}", s.replace(c, &format!("{c}{c}")))
}
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn mysql_lit(s: &str) -> String {
    format!(
        "CONVERT(X'{}' USING utf8mb4)",
        s.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

fn requested_page_size(r: &BrowseRequest) -> Result<usize, String> {
    match r.page_size {
        0 => Ok(100),
        1..=100 => Ok(r.page_size as usize),
        _ => Err("Page size must be between 1 and 100".into()),
    }
}
// Імена завжди цитуються як один ідентифікатор, значення — лише SQL literals.
fn browse_clauses(engine: &str, r: &BrowseRequest) -> Result<String, String> {
    let quote = |s: &str| {
        let q = ident(s, engine == "mysql");
        if engine == "clickhouse" {
            q.replace('\\', "\\\\")
        } else {
            q
        }
    };
    let literal = |s: &str| {
        if engine == "mysql" {
            mysql_lit(s)
        } else if engine == "clickhouse" {
            lit(s).replace('\\', "\\\\")
        } else {
            lit(s)
        }
    };
    let mut result = String::new();
    if !r.filter_column.is_empty() {
        let col = quote(&r.filter_column);
        let text = match engine {
            "postgres" => format!("CAST({col} AS TEXT)"),
            "mysql" => format!("CAST({col} AS CHAR CHARACTER SET utf8mb4)"),
            _ => format!("toString({col})"),
        };
        let value = literal(&r.filter_value);
        let condition = match r.filter_op.as_str() {
            "eq" => format!("{text} = {value}"),
            "contains" => match engine {
                "postgres" => format!("strpos({text},{value}) > 0"),
                "mysql" => format!("LOCATE({value},{text}) > 0"),
                _ => format!("positionUTF8({text},{value}) > 0"),
            },
            "is_null" => format!("{col} IS NULL"),
            "not_null" => format!("{col} IS NOT NULL"),
            _ => return Err("Unsupported filter operator".into()),
        };
        result.push_str(&format!(" WHERE {condition}"));
    }
    if !r.order_column.is_empty() {
        result.push_str(&format!(
            " ORDER BY {} {}",
            quote(&r.order_column),
            if r.order_desc { "DESC" } else { "ASC" }
        ));
    }
    Ok(result)
}

fn sql_for(engine: &str, r: &BrowseRequest) -> Result<String, String> {
    let quote = |s: &str| {
        let v = ident(s, engine == "mysql");
        if engine == "clickhouse" {
            v.replace('\\', "\\\\")
        } else {
            v
        }
    };
    let relation = format!("{}.{}", quote(&r.schema), quote(&r.table));
    if r.offset > 100_000 {
        return Err("Preview is limited to the first 100,000 rows".into());
    }
    let clauses = if r.action == "rows" {
        browse_clauses(engine, r)?
    } else {
        String::new()
    };
    let limit = requested_page_size(r)? + 1;
    match (engine,r.action.as_str()) {
        ("postgres","databases")=>Ok("SELECT coalesce(json_agg(datname ORDER BY datname),'[]'::json) FROM pg_database WHERE datallowconn AND has_database_privilege(datname,'CONNECT')".into()),
        ("postgres","tables")=>Ok("SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT it.table_schema AS schema,it.table_name AS name,it.table_type AS kind,CASE WHEN c.relkind IN ('r','m') AND c.reltuples >= 0 THEN c.reltuples::bigint::text END AS rows_count,true AS rows_estimated,CASE WHEN c.relkind IN ('r','m') THEN pg_table_size(c.oid)::text END AS data_bytes,CASE WHEN c.relkind IN ('r','m') THEN pg_indexes_size(c.oid)::text END AS index_bytes,CASE WHEN c.relkind IN ('r','m') THEN pg_total_relation_size(c.oid)::text END AS total_bytes,left(obj_description(c.oid,'pg_class'),256) AS comment FROM information_schema.tables it JOIN pg_namespace n ON n.nspname=it.table_schema JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=it.table_name WHERE it.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY it.table_schema,it.table_name LIMIT 2000) t".into()),
        ("postgres","columns")=>Ok(format!("SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT column_name AS name,data_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema={} AND table_name={} ORDER BY ordinal_position) t",lit(&r.schema),lit(&r.table))),
        ("postgres","rows")=>Ok(format!("SELECT coalesce(json_agg((SELECT json_object_agg(key,value) FROM jsonb_each_text(to_jsonb(t)))),'[]'::json) FROM (SELECT * FROM {relation}{clauses} LIMIT {limit} OFFSET {}) t",r.offset)),
        ("mysql","databases")=>Ok("SELECT JSON_OBJECT('name',SCHEMA_NAME) FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME".into()),
        ("mysql","tables")=>Ok(format!("SELECT JSON_OBJECT('schema',TABLE_SCHEMA,'name',TABLE_NAME,'kind',COALESCE(ENGINE,TABLE_TYPE),'rows_count',CAST(TABLE_ROWS AS CHAR),'rows_estimated',true,'data_bytes',CAST(DATA_LENGTH AS CHAR),'index_bytes',CAST(INDEX_LENGTH AS CHAR),'total_bytes',CAST(DATA_LENGTH+INDEX_LENGTH AS CHAR),'comment',LEFT(TABLE_COMMENT,256)) FROM information_schema.TABLES WHERE TABLE_SCHEMA={} ORDER BY TABLE_NAME LIMIT 2000",mysql_lit(&r.database))),
        ("mysql","columns")=>Ok(format!("SELECT JSON_OBJECT('name',COLUMN_NAME,'type',COLUMN_TYPE,'nullable',IS_NULLABLE,'data_type',DATA_TYPE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA={} AND TABLE_NAME={} ORDER BY ORDINAL_POSITION",mysql_lit(&r.schema),mysql_lit(&r.table))),
        ("clickhouse","databases")=>Ok("SHOW DATABASES FORMAT JSON".into()),
        ("clickhouse","tables")=>Ok(format!("SELECT database AS schema,name,engine AS kind,toString(total_rows) AS rows_count,false AS rows_estimated,CAST(NULL AS Nullable(String)) AS data_bytes,CAST(NULL AS Nullable(String)) AS index_bytes,toString(total_bytes) AS total_bytes,substringUTF8(comment,1,256) AS comment FROM system.tables WHERE database={} ORDER BY name LIMIT 2000 FORMAT JSON",lit(&r.database).replace('\\',"\\\\"))),
        ("clickhouse","columns")=>Ok(format!("DESCRIBE TABLE {relation} FORMAT JSON")),
        ("clickhouse","rows")=>Err("ClickHouse row preview requires column metadata".into()),
        _=>Err("Unsupported read operation".into()),
    }
}

fn cli_script(source: &DatabaseSource, r: &BrowseRequest, args: &[String]) -> String {
    let base = match source.engine.as_str() {
        "postgres"=>"export PGUSER=\"${PRYSTAN_DB_USER:-${POSTGRES_USER:-postgres}}\" PGPASSWORD=\"${PRYSTAN_DB_PASSWORD:-${POSTGRES_PASSWORD:-}}\" PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c standard_conforming_strings=on' PGCONNECT_TIMEOUT=5; exec timeout 12 psql -X -A -t -w",
        "mysql"=>"DB_USER=\"${PRYSTAN_DB_USER:-${MYSQL_USER:-${MARIADB_USER:-root}}}\"; if [ \"$DB_USER\" = root ]; then DB_PASS=\"${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}\"; else DB_PASS=\"${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}\"; fi; export MYSQL_PWD=\"${PRYSTAN_DB_PASSWORD:-$DB_PASS}\"; DB_CLIENT=mysql; command -v mysql >/dev/null 2>&1 || DB_CLIENT=mariadb; exec timeout 12 \"$DB_CLIENT\" --no-defaults --batch --raw --skip-column-names --default-character-set=utf8mb4 --connect-timeout=5 --user=\"$DB_USER\"",
        "clickhouse"=>"export CLICKHOUSE_USER=\"${PRYSTAN_DB_USER:-${CLICKHOUSE_USER:-default}}\" CLICKHOUSE_PASSWORD=\"${PRYSTAN_DB_PASSWORD:-${CLICKHOUSE_PASSWORD:-}}\"; exec timeout 12 clickhouse-client --user=\"$CLICKHOUSE_USER\" --readonly=1 --max_execution_time=5 --max_result_rows=2001 --result_overflow_mode=throw",
        _=>"export REDISCLI_AUTH=\"${PRYSTAN_DB_PASSWORD:-${REDIS_PASSWORD:-}}\"; [ -n \"$REDISCLI_AUTH\" ] || unset REDISCLI_AUTH; exec timeout 12 redis-cli --json --no-auth-warning",
    };
    let mut vars = format!(
        "export PRYSTAN_DB_USER={} PRYSTAN_DB_PASSWORD={} PGDATABASE={};\n",
        sq(&r.username),
        sq(&r.password),
        sq(if r.database.is_empty() {
            "postgres"
        } else {
            &r.database
        })
    );
    vars.push_str(base);
    vars.push_str(" --host=127.0.0.1");
    if source.engine == "postgres" {
        vars.push_str(&format!(" --port={}", source.port));
    } else if source.engine == "redis" {
        vars = vars.replace(
            " --host=127.0.0.1",
            &format!(" -h 127.0.0.1 -p {}", source.port),
        );
    } else {
        vars.push_str(&format!(" --port={}", source.port));
    }
    for arg in args {
        vars.push(' ');
        vars.push_str(&sq(arg));
    }
    vars.push('\n');
    vars
}

async fn docker_read(
    docker: &bollard::Docker,
    cid: &str,
    r: &BrowseRequest,
    script: String,
) -> Result<String, String> {
    let work = async {
        let script = script
            .split_once('\n')
            .ok_or("Invalid client script")?
            .1
            .to_string();
        let env = vec![
            format!("PRYSTAN_DB_USER={}", r.username),
            format!("PRYSTAN_DB_PASSWORD={}", r.password),
            format!(
                "PGDATABASE={}",
                if r.database.is_empty() {
                    "postgres"
                } else {
                    &r.database
                }
            ),
        ];
        let exec = docker
            .create_exec(
                cid,
                CreateExecOptions {
                    cmd: Some(vec!["sh".into(), "-c".into(), script]),
                    env: Some(env),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let mut err = Vec::new();
        match docker
            .start_exec(&exec.id, None)
            .await
            .map_err(|e| e.to_string())?
        {
            StartExecResults::Attached { mut output, .. } => {
                while let Some(chunk) = output.next().await {
                    let chunk = chunk.map_err(|e| e.to_string())?;
                    let is_err = matches!(&chunk, bollard::container::LogOutput::StdErr { .. });
                    let bytes = chunk.into_bytes();
                    if is_err {
                        err.extend_from_slice(&bytes);
                    } else {
                        out.extend_from_slice(&bytes);
                    }
                    if out.len() + err.len() > MAX_OUTPUT {
                        return Err("Result exceeds 1 MiB; choose a smaller table or value".into());
                    }
                }
            }
            _ => return Err("Database client did not attach".into()),
        }
        let status = docker
            .inspect_exec(&exec.id)
            .await
            .map_err(|e| e.to_string())?;
        if status.exit_code != Some(0) {
            return Err(String::from_utf8_lossy(&err).chars().take(600).collect());
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| "Database operation timed out (20 s)".to_string())?
}
async fn run(
    _state: &AppState,
    _conn: &str,
    source: &DatabaseSource,
    r: &BrowseRequest,
    args: Vec<String>,
) -> Result<String, String> {
    let script = cli_script(source, r, &args);
    let result = if source.source == "host" {
        let profile=r.transport_profile.as_ref().ok_or("Database transport expired")?;
        if profile.kind!="ssh" {return Err("SSH required".into());}
        let mut command=crate::host::ssh_command(profile);command.arg("sh -s");
        ssh_script(command,script,20).await
    } else {
        let docker = r.transport_docker.clone().ok_or("Database transport expired")?;
        docker_read(
            &docker,
            source.id.strip_prefix("docker:").ok_or("Invalid source")?,
            r,
            script,
        )
        .await
    };
    result.map_err(|mut e| {
        if !r.password.is_empty() {
            e = e.replace(&r.password, "***");
        }
        e
    })
}
fn parse_sql(engine: &str, out: &str) -> Result<Value, String> {
    match engine {
        "mysql" => out
            .lines()
            .filter(|s| !s.trim().is_empty())
            .map(|s| serde_json::from_str::<Value>(s).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        "clickhouse" if out.trim_start().starts_with('[') || out.trim().is_empty() => out
            .lines()
            .filter(|s| !s.trim().is_empty())
            .map(|s| serde_json::from_str::<Value>(s).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        "clickhouse" => serde_json::from_str::<Value>(out)
            .map(|v| v["data"].clone())
            .map_err(|e| e.to_string()),
        _ => serde_json::from_str(out).map_err(|e| e.to_string()),
    }
    .map_err(|_| {
        "Database client returned an unexpected format; check its version and connection settings"
            .into()
    })
}
fn sql_args(engine: &str, sql: String) -> Vec<String> {
    if engine == "postgres" {
        vec!["-c".into(), sql]
    } else if engine == "mysql" {
        vec![
            "--execute".into(),
            format!(
                "SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY; {sql}; ROLLBACK;"
            ),
        ]
    } else {
        vec!["--query".into(), sql]
    }
}
fn mysql_rows_sql(items: &[Value], r: &BrowseRequest) -> Result<String, String> {
    if items.is_empty() {
        return Err("Table has no accessible columns".into());
    }
    let fields = items
        .iter()
        .map(|c| {
            let name = ident(c["name"].as_str().unwrap_or(""), true);
            if [
                "blob",
                "tinyblob",
                "mediumblob",
                "longblob",
                "binary",
                "varbinary",
                "bit",
            ]
            .contains(&c["data_type"].as_str().unwrap_or(""))
            {
                format!("HEX({name})")
            } else {
                format!("CAST({name} AS CHAR CHARACTER SET utf8mb4)")
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let clauses = browse_clauses("mysql", r)?;
    let limit = requested_page_size(r)? + 1;
    let sql=format!("SELECT /*+ MAX_EXECUTION_TIME(5000) */ JSON_ARRAY({fields}) FROM {}.{}{clauses} LIMIT {limit} OFFSET {}",ident(&r.schema,true),ident(&r.table,true),r.offset);
    if r.offset > 100_000 {
        return Err("Preview is limited to the first 100,000 rows".into());
    }

    Ok(sql)
}

// Бюджет рахуємо для найгіршого JSON escaping (6 байтів на символ).
// Залишаємо запас для роздільників і транспорту; повні blobs не передаємо.
fn clickhouse_preview_plan(columns: usize) -> Result<(usize, usize), String> {
    if columns == 0 || columns > 2048 {
        return Err("Preview requires between 1 and 2048 accessible columns".into());
    }
    let budget = MAX_OUTPUT * 3 / 4;
    let chars = 256.min((budget / (2 * columns)).saturating_sub(4) / 6 - 1);
    let fetched = 101.min(budget / (columns * (6 * (chars + 1) + 4)));
    Ok((chars, fetched - 1))
}
fn clickhouse_rows_sql(
    items: &[Value],
    r: &BrowseRequest,
) -> Result<(String, usize, usize), String> {
    if r.offset > 100_000 {
        return Err("Preview is limited to the first 100,000 rows".into());
    }
    let (chars, capacity) = clickhouse_preview_plan(items.len())?;
    let page_size = capacity.min(requested_page_size(r)?);
    let clauses = browse_clauses("clickhouse", r)?;
    let quote = |s: &str| ident(s, false).replace('\\', "\\\\");
    let fields = items
        .iter()
        .map(|c| {
            let name = c["name"].as_str().ok_or("Invalid column metadata")?;
            Ok(format!(
                "substringUTF8(toValidUTF8(toString({})),1,{})",
                quote(name),
                chars + 1
            ))
        })
        .collect::<Result<Vec<_>, &str>>()?
        .join(",");
    Ok((
        format!(
            "SELECT {fields} FROM {}.{}{clauses} LIMIT {} OFFSET {} FORMAT JSONCompactEachRow",
            quote(&r.schema),
            quote(&r.table),
            page_size + 1,
            r.offset
        ),
        chars,
        page_size,
    ))
}
fn clickhouse_preview(
    items: &[Value],
    mut value: Value,
    chars: usize,
    page_size: usize,
) -> Result<Value, String> {
    let rows = value.as_array_mut().ok_or("Rows unavailable")?;
    let more = rows.len() > page_size;
    rows.truncate(page_size);
    let mut truncated = Vec::new();
    for (ri, row) in rows.iter_mut().enumerate() {
        let cells = row.as_array_mut().ok_or("Invalid preview row")?;
        if cells.len() != items.len() {
            return Err("Table structure changed; refresh the table".into());
        }
        for (ci, cell) in cells.iter_mut().enumerate() {
            if let Some(text) = cell.as_str() {
                if text.chars().count() > chars {
                    *cell = json!(text.chars().take(chars).collect::<String>());
                    truncated.push(json!([ri, ci]));
                }
            }
        }
    }
    Ok(
        json!({"columns":items.iter().map(|c|c["name"].clone()).collect::<Vec<_>>(),"rows":rows,"more":more,"page_size":page_size,"cell_limit":chars,"truncated":truncated}),
    )
}

async fn sql_read(
    state: &AppState,
    conn: &str,
    s: &DatabaseSource,
    r: &BrowseRequest,
    sql: String,
) -> Result<Value, String> {
    let args = sql_args(&s.engine, sql);
    parse_sql(&s.engine, &run(state, conn, s, r, args).await?)
}
async fn redis_read(
    state: &AppState,
    conn: &str,
    s: &DatabaseSource,
    r: &BrowseRequest,
    cmd: Vec<String>,
) -> Result<Value, String> {
    let db = r
        .database
        .parse::<u32>()
        .map_err(|_| "Redis database must be a nonnegative integer")?;
    let mut args = vec!["-n".into(), db.to_string()];
    if !r.username.is_empty() {
        args.extend(["--user".into(), r.username.clone()]);
    }
    args.extend(cmd);
    let out = run(state, conn, s, r, args).await?;
    serde_json::from_str(&out)
        .map_err(|_| "Redis returned an error or requires redis-cli with --json support".into())
}
fn saved_source(state:&AppState,conn:&str,source_id:&str)->Result<(crate::Profile,DatabaseSource),String> {
    let conns=state.conns.lock().unwrap();let connection=conns.get(conn).ok_or("Server is disconnected")?;
    let source=connection.database_sources.lock().unwrap().iter().find(|s|s.id==source_id).cloned().ok_or("Rescan the selected server")?;
    Ok((connection.database_profile.clone(),source))
}
#[tauri::command]
pub fn database_saved_profiles(state:State<'_,AppState>,conn:String,source_id:String)->Result<Vec<crate::database_profiles::SavedProfile>,String> {
    let (profile,source)=saved_source(&state,&conn,&source_id)?;
    crate::database_profiles::list(&state,&profile,&source)
}
#[tauri::command]
pub fn database_forget_profile(state:State<'_,AppState>,conn:String,source_id:String,id:String)->Result<(),String> {
    let (profile,source)=saved_source(&state,&conn,&source_id)?;
    crate::database_profiles::forget(&state,&profile,&source,&id)
}
#[tauri::command]
pub async fn database_browse(state:State<'_,AppState>,conn:String,request:BrowseRequest)->Result<Value,String> {
    browse_with_profiles(&state,&conn,request).await
}
async fn browse_with_profiles(state:&AppState,conn:&str,mut request:BrowseRequest)->Result<Value,String> {
    let (profile,source,cache,docker)={
        let conns=state.conns.lock().unwrap();let c=conns.get(conn).ok_or("Server is disconnected")?;
        let source=c.database_sources.lock().unwrap().iter().find(|s|s.id==request.source_id).cloned().ok_or("Rescan the selected server")?;
        (c.database_profile.clone(),source,c.database_sources.clone(),c.docker.clone())
    };
    request.transport_profile=Some(profile.clone());request.transport_docker=Some(docker);
    if !request.saved_profile_id.is_empty() {
        let (username,password,database)=crate::database_profiles::credentials(&state,&profile,&source,&request.saved_profile_id)?;
        request.username=username;request.password=password;if request.database.is_empty(){request.database=database;}
    }
    let value=browse(&state,&conn,&source,&request).await?;
    if request.action!="databases" {return Ok(value);}
    // Пароль запам'ятовуємо лише після справжньої auth-перевірки і лише для живого transport.
    let current=state.conns.lock().unwrap().get(conn).is_some_and(|c|std::sync::Arc::ptr_eq(&c.database_sources,&cache));
    let mut saved=None;let mut save_error=None;
    if request.remember && current {
        match crate::database_profiles::remember(&state,&profile,&source,&request.username,&request.password,&request.database) {
            Ok(record)=>saved=Some(record),Err(e)=>save_error=Some(e)
        }
    }
    Ok(json!({"databases":value,"saved_profile":saved,"save_error":save_error}))
}
async fn browse(state:&AppState,conn:&str,s:&DatabaseSource,request:&BrowseRequest)->Result<Value,String> {
    let r = request;
    for value in [
        &r.database,
        &r.schema,
        &r.table,
        &r.key,
        &r.pattern,
        &r.username,
        &r.password,
        &r.filter_column,
        &r.filter_op,
        &r.filter_value,
        &r.order_column,
    ] {
        if value.contains('\0') || value.len() > 4096 {
            return Err("Invalid database parameter".into());
        }
    }
    if !["databases", "tables", "columns", "rows", "keys", "value"].contains(&r.action.as_str()) {
        return Err("Unsupported read operation".into());
    }
    if s.state != "running" {
        return Err("Database container is not running".into());
    }
    if s.engine == "redis" {
        if r.action == "databases" {
            let mut ping=r.clone();if ping.database.is_empty(){ping.database="0".into();}
            let pong=redis_read(state,conn,s,&ping,vec!["PING".into()]).await?;
            if pong!=json!("PONG") {return Err("Redis authentication failed".into());}
            return Ok(json!(["0"]));
        }
        if r.action == "keys" {
            let cursor = if r.cursor.is_empty() { "0" } else { &r.cursor };
            cursor.parse::<u64>().map_err(|_| "Invalid Redis cursor")?;
            let value = redis_read(
                &state,
                &conn,
                &s,
                r,
                vec![
                    "SCAN".into(),
                    cursor.into(),
                    "MATCH".into(),
                    if r.pattern.is_empty() {
                        "*".into()
                    } else {
                        r.pattern.clone()
                    },
                    "COUNT".into(),
                    "100".into(),
                ],
            )
            .await?;
            if !value.is_array() {
                return Err("Unexpected Redis SCAN response".into());
            }
            return Ok(
                json!({"cursor":value[0].as_str().map(str::to_string).unwrap_or_else(||value[0].to_string()),"keys":value[1]}),
            );
        }
        if r.action == "value" {
            let kind = redis_read(&state, &conn, &s, r, vec!["TYPE".into(), r.key.clone()]).await?;
            let cmd = match kind.as_str().unwrap_or("") {
                "string" => vec!["GETRANGE", &r.key, "0", "65535"],
                "list" => vec!["LRANGE", &r.key, "0", "99"],
                "hash" => vec!["HSCAN", &r.key, "0", "COUNT", "100"],
                "set" => vec!["SSCAN", &r.key, "0", "COUNT", "100"],
                "zset" => vec!["ZSCAN", &r.key, "0", "COUNT", "100"],
                "stream" => vec!["XRANGE", &r.key, "-", "+", "COUNT", "100"],
                "none" => return Err("Key expired or was removed; refresh the key list".into()),
                _ => return Err("Unsupported Redis value type".into()),
            };
            return Ok(
                json!({"type":kind,"value":redis_read(&state,&conn,&s,r,cmd.into_iter().map(str::to_string).collect()).await?}),
            );
        }
        return Err("Unsupported Redis read operation".into());
    }
    if r.action == "rows" && s.engine == "clickhouse" {
        let columns_request = BrowseRequest {
            action: "columns".into(),
            ..r.clone()
        };
        let columns = sql_read(
            &state,
            &conn,
            &s,
            r,
            sql_for("clickhouse", &columns_request)?,
        )
        .await?;
        let items = columns.as_array().ok_or("Columns unavailable")?;
        let (sql, chars, page_size) = clickhouse_rows_sql(items, r)?;
        let rows = sql_read(&state, &conn, &s, r, sql).await?;
        return clickhouse_preview(items, rows, chars, page_size);
    }
    if r.action == "rows" && s.engine == "mysql" {
        let columns_r = BrowseRequest {
            action: "columns".into(),
            ..BrowseRequest::default()
        };
        let cols = sql_read(
            &state,
            &conn,
            &s,
            r,
            sql_for(
                "mysql",
                &BrowseRequest {
                    schema: r.schema.clone(),
                    table: r.table.clone(),
                    ..columns_r
                },
            )?,
        )
        .await?;
        let items = cols.as_array().ok_or("Columns unavailable")?;
        let sql = mysql_rows_sql(items, r)?;
        let mut rows = sql_read(&state, &conn, &s, r, sql).await?;
        let rows = rows.as_array_mut().ok_or("Rows unavailable")?;
        let page_size = requested_page_size(r)?;
        let more = rows.len() > page_size;
        rows.truncate(page_size);
        return Ok(
            json!({"columns":items.iter().map(|c|c["name"].clone()).collect::<Vec<_>>(),"rows":rows,"more":more,"page_size":page_size}),
        );
    }
    let mut value = sql_read(&state, &conn, &s, r, sql_for(&s.engine, r)?).await?;
    if r.action == "columns" && s.engine == "clickhouse" {
        for column in value.as_array_mut().ok_or("Columns unavailable")? {
            let kind = column["type"].as_str().unwrap_or("");
            column["nullable"] = json!(if kind.starts_with("Nullable(")
                || kind.starts_with("LowCardinality(Nullable(")
            {
                "YES"
            } else {
                "NO"
            });
        }
    }
    if r.action == "databases" && s.engine != "postgres" {
        return Ok(json!(value
            .as_array()
            .ok_or("Database list unavailable")?
            .iter()
            .map(|v| v["name"].clone())
            .collect::<Vec<_>>()));
    }
    if r.action == "rows" {
        let rows = value.as_array_mut().ok_or("Rows unavailable")?;
        let page_size = requested_page_size(r)?;
        let more = rows.len() > page_size;
        rows.truncate(page_size);
        return Ok(json!({"rows":rows,"more":more,"page_size":page_size}));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "database_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_engines_without_matching_exporters_or_clients() {
        for (image, engine) in [
            ("postgres:16", "postgres"),
            ("bitnami/postgresql:17", "postgres"),
            ("mysql/mysql-server:8", "mysql"),
            ("mariadb:11", "mysql"),
            ("clickhouse/clickhouse-server:24.8", "clickhouse"),
            ("redis/redis-stack-server:latest", "redis"),
        ] {
            assert_eq!(image_engine(image), Some(engine));
        }
        for image in [
            "prometheus/postgres-exporter:latest",
            "redisinsight:latest",
            "clickhouse-client:24",
            "my-api:5432",
        ] {
            assert_eq!(image_engine(image), None);
        }
    }
    #[test]
    fn host_discovery_deduplicates_ipv4_ipv6_and_marks_port_hints() {
        let out="LISTEN 0 511 127.0.0.1:15432 *:* users:((\"postgres\",pid=1,fd=2))\nLISTEN 0 511 [::1]:15432 *:* users:((\"postgres\",pid=1,fd=2))\nLISTEN 0 511 0.0.0.0:6379 *:*\nLISTEN 0 511 *:8123 *:* users:((\"clickhouse\",pid=3,fd=2))";
        let rows = host_sources(out);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].confirmed);
        assert!(!rows[1].confirmed);
    }
    #[test]
    fn proc_fallback_finds_clickhouse_without_ss_or_process_permissions() {
        let rows=host_sources("0: 0100007F:2328 00000000:0000 0A 0 0\n1: 00000000:1FBB 00000000:0000 0A 0 0\n2: 0100007F:2328 00000000:0000 01 0 0");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].engine, "clickhouse");
        assert_eq!(rows[0].port, 9000);
        assert!(!rows[0].confirmed);
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn holding_stdin_after_shutdown_reproduces_the_previous_eof_wait() {
        #[cfg(windows)]
        let mut command = {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/D", "/C", "more"]);
            c
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", "cat"]);
            c
        };
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        input.write_all(b"previous-eof-wait\n").await.unwrap();
        input.shutdown().await.unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut bytes = Vec::new();
        // До виправлення pipe лишався відкритим у try_join!, навіть після shutdown.
        let held =
            tokio::time::timeout(Duration::from_millis(150), output.read_to_end(&mut bytes)).await;
        assert!(
            held.is_err(),
            "This platform closes stdin during shutdown; no EOF wait to reproduce"
        );
        drop(input);
        tokio::time::timeout(Duration::from_secs(2), output.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert!(child.wait().await.unwrap().success());
    }
    #[tokio::test]
    async fn ssh_stdin_closes_before_waiting_for_shell_eof() {
        #[cfg(windows)]
        let command = {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/D", "/C", "more"]);
            c
        };
        #[cfg(not(windows))]
        let command = {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", "cat"]);
            c
        };
        let result = ssh_script(command, "eof-regression\n".into(), 2)
            .await
            .unwrap();
        assert!(result.contains("eof-regression"));
    }
    #[test]
    fn clickhouse_preview_budgets_wide_rows_and_preserves_null_and_unicode() {
        for n in [1, 3, 20, 100, 512, 2048] {
            let (chars, page) = clickhouse_preview_plan(n).unwrap();
            assert!((1..=100).contains(&page));
            let worst = json!(vec![vec!["\u{0001}".repeat(chars + 1); n]; page + 1]);
            assert!(
                serde_json::to_vec(&worst).unwrap().len() < MAX_OUTPUT,
                "{n} columns exceed budget"
            );
        }
        let items = vec![
            json!({"name":"html"}),
            json!({"name":"nullable"}),
            json!({"name":"literal"}),
        ];
        let preview = clickhouse_preview(
            &items,
            json!([["🙂🙂🙂🙂", null, "NULL"], ["abc", null, "NULL"]]),
            3,
            1,
        )
        .unwrap();
        assert_eq!(preview["rows"][0][0], "🙂🙂🙂");
        assert!(preview["rows"][0][1].is_null());
        assert_eq!(preview["rows"][0][2], "NUL");
        assert_eq!(preview["truncated"], json!([[0, 0], [0, 2]]));
        assert_eq!(preview["more"], true);
        assert!(clickhouse_preview_plan(0).is_err());
        assert!(clickhouse_preview_plan(2049).is_err());
    }
    #[test]
    fn clickhouse_bounded_sql_quotes_columns_and_compact_json_preserves_strings() {
        let r = BrowseRequest {
            schema: "s\"x".into(),
            table: "t".into(),
            offset: 100,
            ..Default::default()
        };
        let (sql, _, _) = clickhouse_rows_sql(&[json!({"name":"c\"x"})], &r).unwrap();
        assert!(sql.contains("toString(\"c\"\"x\")"));
        assert!(sql.contains("OFFSET 100 FORMAT JSONCompactEachRow"));
        assert_eq!(
            parse_sql(
                "clickhouse",
                "[\"123456789012345678901234567890.12\",null]\n"
            )
            .unwrap(),
            json!([["123456789012345678901234567890.12", null]])
        );
        assert_eq!(parse_sql("clickhouse", "").unwrap(), json!([]));
    }
    #[test]
    fn queries_quote_identifiers_and_reject_unknown_operations() {
        let r = BrowseRequest {
            action: "rows".into(),
            schema: "public".into(),
            table: "a\"; DROP TABLE x;--".into(),
            ..Default::default()
        };
        assert!(sql_for("postgres", &r)
            .unwrap()
            .contains("\"a\"\"; DROP TABLE x;--\""));
        for engine in ["postgres", "mysql", "clickhouse"] {
            assert!(sql_for(
                engine,
                &BrowseRequest {
                    action: "DELETE".into(),
                    ..Default::default()
                }
            )
            .is_err());
        }
        assert!(sql_for(
            "postgres",
            &BrowseRequest {
                offset: 100001,
                ..r
            }
        )
        .is_err());
    }
    #[test]
    fn browse_options_bound_pages_and_quote_filter_and_sort_inputs() {
        for engine in ["postgres", "mysql", "clickhouse"] {
            let r = BrowseRequest {
                action: "rows".into(),
                schema: "s".into(),
                table: "t".into(),
                filter_column: "x\"`".into(),
                filter_op: "contains".into(),
                filter_value: "a'\\%_; DROP TABLE t;--".into(),
                order_column: "id\"`".into(),
                order_desc: true,
                page_size: 25,
                ..Default::default()
            };
            let clauses = browse_clauses(engine, &r).unwrap();
            assert!(
                clauses.contains(" WHERE ")
                    && clauses.contains(" ORDER BY ")
                    && clauses.ends_with(" DESC")
            );
            assert!(!clauses.contains(" LIKE "));
            assert!(browse_clauses(
                engine,
                &BrowseRequest {
                    filter_op: "= 1; DELETE".into(),
                    ..r.clone()
                }
            )
            .is_err());
            let sql = match engine {
                "mysql" => mysql_rows_sql(&[json!({"name":"id"})], &r).unwrap(),
                "clickhouse" => clickhouse_rows_sql(&[json!({"name":"id"})], &r).unwrap().0,
                _ => sql_for(engine, &r).unwrap(),
            };
            assert!(sql.contains("LIMIT 26 OFFSET 0"), "{sql}");
            for op in ["eq", "is_null", "not_null"] {
                assert!(browse_clauses(
                    engine,
                    &BrowseRequest {
                        filter_op: op.into(),
                        ..r.clone()
                    }
                )
                .is_ok());
            }
        }
        assert_eq!(requested_page_size(&BrowseRequest::default()).unwrap(), 100);
        assert!(requested_page_size(&BrowseRequest {
            page_size: 101,
            ..Default::default()
        })
        .is_err());
        let (_, _, page) = clickhouse_rows_sql(
            &vec![json!({"name":"c"}); 100],
            &BrowseRequest {
                page_size: 100,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(page < 100);
    }
    #[test]
    fn shell_values_and_mysql_literals_cannot_escape() {
        assert_eq!(sq("a'b"), "'a'\\''b'");
        assert_eq!(mysql_lit("'"), "CONVERT(X'27' USING utf8mb4)");
    }
    #[test]
    fn mysql_json_lines_preserve_nulls_tabs_and_literal_null() {
        assert_eq!(
            parse_sql("mysql", "[null,\"NULL\",\"a\\tb\"]\n").unwrap(),
            json!([[null, "NULL", "a\tb"]])
        );
    }
}
