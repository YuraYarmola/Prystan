use super::*;
use std::process::Command;

struct DisposableContainer {
    id: String,
    token: String,
}
impl Drop for DisposableContainer {
    fn drop(&mut self) {
        let label = Command::new("docker")
            .args([
                "inspect",
                "--format",
                "{{index .Config.Labels \"prystan.database-test\"}}",
                &self.id,
            ])
            .output();
        if label.is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == self.token
        }) {
            let _ = Command::new("docker")
                .args(["rm", "-f", "-v", &self.id])
                .output();
        }
    }
}
fn disposable(engine: &str, image: &str) -> DisposableContainer {
    let token = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let mut args = vec![
        "run".into(),
        "-d".into(),
        "--network".into(),
        "none".into(),
        "--label".into(),
        format!("prystan.database-test={token}"),
    ];
    let env: Vec<&str> = match engine {
        "postgres" => vec![
            "POSTGRES_PASSWORD=prystan-disposable",
            "POSTGRES_DB=postgres",
            "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust",
        ],
        "mysql" => vec![
            "MYSQL_ROOT_PASSWORD=prystan-disposable",
            "MYSQL_DATABASE=sample",
            "MYSQL_USER=preview",
            "MYSQL_PASSWORD=prystan-disposable",
        ],
        "clickhouse" => vec![
            "CLICKHOUSE_USER=reader",
            "CLICKHOUSE_PASSWORD=prystan-disposable",
            "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
        ],
        _ => vec!["REDIS_PASSWORD=prystan-disposable"],
    };
    for e in env {
        args.extend(["-e".into(), e.into()]);
    }
    args.push(image.into());
    if engine == "redis" {
        args.extend([
            "redis-server".into(),
            "--requirepass".into(),
            "prystan-disposable".into(),
        ]);
    }
    let output = Command::new("docker").args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert_eq!(id.len(), 64);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    DisposableContainer { id, token }
}
fn seed(container: &DisposableContainer, engine: &str) -> bool {
    let setup=match engine {
        "postgres"=>"PGPASSWORD=$POSTGRES_PASSWORD psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE TABLE sample_rows (id int, name text, precise numeric(40,2)); INSERT INTO sample_rows SELECT x, CASE WHEN x=1 THEN NULL ELSE chr(60)||chr(62) END, 123456789012345678901234567890.12 FROM generate_series(1,105) x; ANALYZE sample_rows; CREATE VIEW sample_view AS SELECT id FROM sample_rows; CREATE TABLE sample_parent (id int) PARTITION BY RANGE(id); CREATE TABLE sample_child PARTITION OF sample_parent FOR VALUES FROM (0) TO (100); INSERT INTO sample_parent VALUES (1); ANALYZE sample_child;'".into(),
        "mysql"=>{let rows=(1..=105).map(|i|format!("({i},{},123456789012345678901234567890.12)",if i==1{"NULL"}else{"'NULL'"})).collect::<Vec<_>>().join(",");format!("MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -h 127.0.0.1 -uroot sample -e \"CREATE TABLE sample_rows (id int, name text, precise decimal(40,2)); INSERT INTO sample_rows VALUES {rows}; CREATE VIEW sample_view AS SELECT id FROM sample_rows;\"")},
        "clickhouse"=>format!("clickhouse-client --user reader --multiquery --query {}",sq("CREATE TABLE default.sample_rows (id UInt32, name Nullable(String), precise Decimal(38,2)) ENGINE=Memory; INSERT INTO default.sample_rows SELECT number, if(number=0,NULL,toString(number)), toDecimal128('123456789012345678901234567890.12',2) FROM numbers(105); CREATE VIEW default.sample_view AS SELECT id FROM default.sample_rows;")),
        _=>"REDISCLI_AUTH=$REDIS_PASSWORD redis-cli SET sample:key 'hello <world>' >/dev/null && REDISCLI_AUTH=$REDIS_PASSWORD redis-cli HSET sample:hash field value >/dev/null".into(),
    };
    Command::new("docker")
        .args(["exec", &container.id, "sh", "-c", &setup])
        .output()
        .is_ok_and(|o| o.status.success())
}

#[tokio::test]
#[ignore = "requires local Docker and postgres:16-alpine, mysql:8.4, clickhouse/clickhouse-server:26.8-alpine, redis:7-alpine; only labelled isolated containers are changed"]
async fn local_database_clients_read_all_four_engines_and_enforce_sql_readonly() {
    let docker = bollard::Docker::connect_with_local_defaults().unwrap();
    docker.ping().await.unwrap();
    for (engine, image) in [
        ("postgres", "postgres:16-alpine"),
        ("mysql", "mysql:8.4"),
        ("clickhouse", "clickhouse/clickhouse-server:26.8-alpine"),
        ("redis", "redis:7-alpine"),
    ] {
        let container = disposable(engine, image);
        let mut ready = false;
        for _ in 0..50 {
            if seed(&container, engine) {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        assert!(ready, "{engine} disposable service did not become ready");
        let s = DatabaseSource {
            id: format!("docker:{}", container.id),
            engine: engine.into(),
            name: "disposable".into(),
            source: "docker".into(),
            state: "running".into(),
            port: default_port(engine),
            address: "Docker network".into(),
            confirmed: true,
        };
        let mut r = BrowseRequest {
            source_id: s.id.clone(),
            action: "databases".into(),
            database: match engine {
                "mysql" => "sample",
                "clickhouse" => "default",
                "redis" => "0",
                _ => "postgres",
            }
            .into(),
            schema: match engine {
                "postgres" => "public",
                "mysql" => "sample",
                _ => "default",
            }
            .into(),
            table: "sample_rows".into(),
            ..Default::default()
        };
        let read = |r: &BrowseRequest, args: Vec<String>| {
            let script = cli_script(&s, r, &args);
            let request = r.clone();
            let docker = &docker;
            let id = container.id.clone();
            async move { docker_read(docker, &id, &request, script).await }
        };
        if engine == "redis" {
            let args = vec!["-n", "0", "SCAN", "0", "MATCH", "sample:*", "COUNT", "100"]
                .into_iter()
                .map(str::to_string)
                .collect();
            let out = read(&r, args).await.unwrap();
            let value: Value = serde_json::from_str(&out).unwrap();
            assert!(value[1].as_array().unwrap().contains(&json!("sample:key")));
            let out = read(
                &r,
                vec![
                    "GETRANGE".into(),
                    "sample:key".into(),
                    "0".into(),
                    "65535".into(),
                ],
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&out).unwrap(),
                json!("hello <world>")
            );
            let out = read(
                &r,
                vec![
                    "HSCAN".into(),
                    "sample:hash".into(),
                    "0".into(),
                    "COUNT".into(),
                    "100".into(),
                ],
            )
            .await
            .unwrap();
            assert!(out.contains("field"));
        } else {
            let mut columns = Value::Null;
            for action in ["databases", "tables", "columns"] {
                r.action = action.into();
                let out = read(&r, sql_args(engine, sql_for(engine, &r).unwrap()))
                    .await
                    .unwrap();
                let value = parse_sql(engine, &out).unwrap();
                if action == "columns" {
                    columns = value.clone();
                }
                if action == "columns" {
                    columns = value.clone();
                }
                if action == "tables" {
                    let table=value.as_array().unwrap().iter().find(|t|t["name"]=="sample_rows").expect("sample table metadata");
                    assert!(table["total_bytes"].as_str().and_then(|v|v.parse::<u64>().ok()).is_some(),"{engine} size: {table}");
                    assert!(table["rows_count"].as_str().and_then(|v|v.parse::<u64>().ok()).is_some(),"{engine} row statistics: {table}");
                    if engine=="postgres" {assert_eq!(table["rows_count"],"105");assert_eq!(table["rows_estimated"],true);}
                    let view=value.as_array().unwrap().iter().find(|t|t["name"]=="sample_view").expect("view metadata");
                    assert!(view["rows_count"].is_null(),"{engine}: view must not claim zero rows: {view}");
                    assert!(view["total_bytes"].is_null(),"{engine}: view has no own storage: {view}");
                    if engine=="postgres" {
                        let parent=value.as_array().unwrap().iter().find(|t|t["name"]=="sample_parent").unwrap();
                        assert!(parent["rows_count"].is_null()&&parent["total_bytes"].is_null(),"partition parent must not claim aggregated statistics");
                        let child=value.as_array().unwrap().iter().find(|t|t["name"]=="sample_child").unwrap();
                        assert_eq!(child["rows_count"],"1");
                    }

                    if engine=="clickhouse" {assert_eq!(table["rows_count"],"105");assert!(table["index_bytes"].is_null());}
                    if engine!="clickhouse" {assert!(table["index_bytes"].as_str().and_then(|v|v.parse::<u64>().ok()).is_some());}
                }
                assert!(!value.as_array().unwrap().is_empty(), "{engine}: {action}");
            }
            r.action = "rows".into();
            let sql = if engine == "clickhouse" {
                clickhouse_rows_sql(columns.as_array().unwrap(), &r)
                    .unwrap()
                    .0
            } else if engine == "mysql" {
                mysql_rows_sql(columns.as_array().unwrap(), &r).unwrap()
            } else {
                sql_for(engine, &r).unwrap()
            };
            let out = read(&r, sql_args(engine, sql)).await.unwrap();
            let value = parse_sql(engine, &out).unwrap();
            assert_eq!(value.as_array().unwrap().len(), 101, "{engine} first page");
            let precise = if engine == "mysql" || engine == "clickhouse" {
                &value[0][2]
            } else {
                &value[0]["precise"]
            };
            assert_eq!(
                precise.as_str(),
                Some("123456789012345678901234567890.12"),
                "{engine} lost decimal precision"
            );
            r.offset = 100;
            let sql = if engine == "clickhouse" {
                clickhouse_rows_sql(columns.as_array().unwrap(), &r)
                    .unwrap()
                    .0
            } else if engine == "mysql" {
                mysql_rows_sql(columns.as_array().unwrap(), &r).unwrap()
            } else {
                sql_for(engine, &r).unwrap()
            };
            let out = read(&r, sql_args(engine, sql)).await.unwrap();
            assert_eq!(
                parse_sql(engine, &out).unwrap().as_array().unwrap().len(),
                5,
                "{engine} second page"
            );
            r.offset = 0;
            r.page_size = 25;
            r.order_column = "id".into();
            r.order_desc = true;
            let query = |r: &BrowseRequest| match engine {
                "mysql" => mysql_rows_sql(columns.as_array().unwrap(), r).unwrap(),
                "clickhouse" => {
                    clickhouse_rows_sql(columns.as_array().unwrap(), r)
                        .unwrap()
                        .0
                }
                _ => sql_for(engine, r).unwrap(),
            };
            let out = read(&r, sql_args(engine, query(&r))).await.unwrap();
            let sorted = parse_sql(engine, &out).unwrap();
            assert_eq!(
                sorted.as_array().unwrap().len(),
                26,
                "{engine} requested page"
            );
            let id = if engine == "postgres" {
                &sorted[0]["id"]
            } else {
                &sorted[0][0]
            };
            assert_eq!(
                id.as_str(),
                Some(if engine == "clickhouse" { "104" } else { "105" }),
                "{engine} descending sort"
            );
            for (op, expected) in [
                ("eq", 1),
                ("contains", 25),
                ("is_null", 1),
                ("not_null", 26),
            ] {
                r.filter_column = if op == "eq" || op == "contains" {
                    "id"
                } else {
                    "name"
                }
                .into();
                r.filter_op = op.into();
                r.filter_value = "1".into();
                let out = read(&r, sql_args(engine, query(&r))).await.unwrap();
                let rows = parse_sql(engine, &out).unwrap();
                let expected = if op == "contains" && engine == "clickhouse" {
                    24
                } else {
                    expected
                };
                // Набори 0..104 та 1..105 містять відповідно 24 і 25 чисел із цифрою 1.
                assert_eq!(rows.as_array().unwrap().len(), expected, "{engine}: {op}");
            }
            r.filter_op = "eq".into();
            r.filter_column = "name".into();
            r.filter_value = "x'\\%_; DROP TABLE sample_rows;--".into();
            let out = read(&r, sql_args(engine, query(&r))).await.unwrap();
            assert!(
                parse_sql(engine, &out)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "{engine} literal filter"
            );
            // Навіть помилка у майбутньому шаблоні SQL не повинна дозволити запис.
            let sql = match engine {
                "postgres" => "CREATE TABLE public.should_not_exist (id int)",
                "mysql" => "CREATE TABLE sample.should_not_exist (id int)",
                _ => "CREATE TABLE default.should_not_exist (id UInt32) ENGINE=Memory",
            };
            assert!(
                read(&r, sql_args(engine, sql.into())).await.is_err(),
                "{engine} allowed DDL in readonly session"
            );
        }
        #[cfg(windows)]
        {
            let store=crate::database_profiles::test_store();let state=&store.state;
            let profile=crate::Profile{id:"vault-fixture".into(),kind:"local".into(),..Default::default()};
            state.conns.lock().unwrap().insert(profile.id.clone(),crate::ConnEntry{database_profile:profile.clone(),database_sources:std::sync::Arc::new(std::sync::Mutex::new(vec![s.clone()])),docker:docker.clone(),tunnel:None,events_task:None,docker_ok:true});
            let login=BrowseRequest{source_id:s.id.clone(),action:"databases".into(),database:r.database.clone(),password:"prystan-disposable".into(),remember:true,..Default::default()};
            let response=browse_with_profiles(state,&profile.id,login.clone()).await.unwrap();
            assert!(response["save_error"].is_null(),"{engine}: secure save failed");
            let id=response["saved_profile"]["id"].as_str().unwrap().to_string();assert!(!response.to_string().contains("prystan-disposable"));
            let restored=BrowseRequest{password:String::new(),saved_profile_id:id.clone(),remember:false,..login.clone()};
            assert!(browse_with_profiles(state,&profile.id,restored).await.is_ok(),"{engine}: restored vault login");
            let failed=BrowseRequest{password:"wrong-disposable".into(),..login.clone()};
            assert!(browse_with_profiles(state,&profile.id,failed).await.is_err(),"{engine}: failed credentials must not be saved");
            assert_eq!(crate::database_profiles::credentials(state,&profile,&s,&id).unwrap().1,"prystan-disposable","{engine}: failed login overwrote vault");
            let mut changed=profile.clone();changed.host="192.0.2.200".into();state.conns.lock().unwrap().get_mut(&profile.id).unwrap().database_profile=changed;
            assert!(browse_with_profiles(state,&profile.id,BrowseRequest{saved_profile_id:id.clone(),password:String::new(),remember:false,..login}).await.is_err(),"{engine}: cross-endpoint credential reuse");
            crate::database_profiles::forget(state,&profile,&s,&id).unwrap();
        }
        // Неправильний пароль має повертати помилку, а не порожній успішний результат.
        r.password = "incorrect-disposable-password".into();
        let args = if engine == "redis" {
            vec!["PING".into()]
        } else {
            sql_args(
                engine,
                sql_for(
                    engine,
                    &BrowseRequest {
                        action: "databases".into(),
                        ..Default::default()
                    },
                )
                .unwrap(),
            )
        };
        let out = read(&r, args).await;
        if let Ok(text) = out {
            assert!(
                serde_json::from_str::<Value>(&text).is_err(),
                "{engine} accepted wrong password"
            );
        }
        println!(
            "{engine}: discovery metadata, data preview, paging, credentials and readonly verified"
        );
    }
    // Не чіпаємо профілі власника або інші контейнери: Drop видаляє лише власні ID з точним label.
}

#[tokio::test]
#[ignore = "requires local Docker and clickhouse/clickhouse-server:26.8-alpine; creates a labelled isolated container"]
async fn clickhouse_large_text_preview_reproduces_overflow_and_reads_bounded_pages() {
    let docker = bollard::Docker::connect_with_local_defaults().unwrap();
    let container = disposable("clickhouse", "clickhouse/clickhouse-server:26.8-alpine");
    let mut ready = false;
    for _ in 0..50 {
        if seed(&container, "clickhouse") {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    assert!(ready, "Disposable ClickHouse did not become ready");
    let extra = (0..20)
        .map(|i| format!("payload_{i} String"))
        .collect::<Vec<_>>()
        .join(",");
    let values = (0..20)
        .map(|_| "repeat(concat('🙂', char(1), '<html>'),1024)")
        .collect::<Vec<_>>()
        .join(",");
    let setup=format!("CREATE TABLE default.large_rows (id UInt64, precise Decimal(38,2), nullable Nullable(String), {extra}) ENGINE=Memory; INSERT INTO default.large_rows SELECT number, toDecimal128('123456789012345678901234567890.12',2), NULL, {values} FROM numbers(105);");
    let out = Command::new("docker")
        .args([
            "exec",
            &container.id,
            "clickhouse-client",
            "--user",
            "reader",
            "--multiquery",
            "--query",
            &setup,
        ])
        .output()
        .unwrap();
    assert!(out.status.success(), "Disposable fixture failed");
    let source = DatabaseSource {
        id: format!("docker:{}", container.id),
        engine: "clickhouse".into(),
        name: "large-fixture".into(),
        source: "docker".into(),
        state: "running".into(),
        port: 9000,
        address: "Docker network".into(),
        confirmed: true,
    };
    let mut r = BrowseRequest {
        schema: "default".into(),
        database: "default".into(),
        table: "large_rows".into(),
        action: "columns".into(),
        ..Default::default()
    };
    let read = |r: BrowseRequest, sql: String| {
        let script = cli_script(&source, &r, &sql_args("clickhouse", sql));
        let docker = &docker;
        let id = container.id.clone();
        async move { docker_read(docker, &id, &r, script).await }
    };
    // Старий SELECT * перевищує ліміт навіть без UI; новий шлях скорочує на сервері.
    let original = read(
        r.clone(),
        "SELECT * FROM default.large_rows LIMIT 101 FORMAT JSONStrings".into(),
    )
    .await
    .unwrap_err();
    assert!(original.contains("exceeds 1 MiB"));
    let columns = parse_sql(
        "clickhouse",
        &read(r.clone(), sql_for("clickhouse", &r).unwrap())
            .await
            .unwrap(),
    )
    .unwrap();
    let items = columns.as_array().unwrap();
    let (sql, chars, page) = clickhouse_rows_sql(items, &r).unwrap();
    assert!(page < 100);
    let out = read(r.clone(), sql).await.unwrap();
    assert!(out.len() < MAX_OUTPUT);
    let preview =
        clickhouse_preview(items, parse_sql("clickhouse", &out).unwrap(), chars, page).unwrap();
    assert_eq!(preview["rows"].as_array().unwrap().len(), page);
    assert_eq!(preview["more"], true);
    assert_eq!(preview["rows"][0][1], "123456789012345678901234567890.12");
    assert!(preview["rows"][0][2].is_null());
    assert_eq!(
        preview["rows"][0][3].as_str().unwrap().chars().count(),
        chars
    );
    assert!(!preview["truncated"].as_array().unwrap().is_empty());
    for offset in [page as u32, 100] {
        r.offset = offset;
        let (sql, chars, page) = clickhouse_rows_sql(items, &r).unwrap();
        let preview = clickhouse_preview(
            items,
            parse_sql("clickhouse", &read(r.clone(), sql).await.unwrap()).unwrap(),
            chars,
            page,
        )
        .unwrap();
        assert_eq!(preview["rows"][0][0], offset.to_string());
        if offset == 100 {
            assert_eq!(preview["rows"].as_array().unwrap().len(), 5);
            assert_eq!(preview["more"], false);
        }
    }
}
