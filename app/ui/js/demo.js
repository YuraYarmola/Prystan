"use strict";
/* Демо-режим: застосунок працює на вигаданих даних.
 *
 * Потрібен для двох речей. По-перше, знімки екрана для README не повинні
 * світити чужі адреси й назви проєктів — тут усі сервери вигадані, а IP взяті
 * з діапазонів, зарезервованих під документацію (RFC 5737). По-друге, будь-хто
 * може подивитись, як усе влаштовано, не маючи ні Docker, ні сервера.
 *
 * Технічно це підміна транспорту: замість справжніх викликів у Rust
 * підставляємо власний маршрутизатор і подієву шину. Решта коду застосунку
 * про це не знає й працює без змін.
 */

const DEMO = localStorage.getItem("prystan-demo") === "1";

// Зсуви тут не годяться: `8 << 30` виходить за межі 32-бітного цілого
// й перетворюється на нуль або відʼємне число.
const MB = 1024 ** 2;
const GB = 1024 ** 3;

/* ── вигадані сервери ───────────────────────────────── */
const D_PROFILES = [
  { id: "local", name: "Docker · localhost", kind: "local", host: "", port: 0, user: "", key_path: "", readonly: false, autoconnect: true },
  { id: "web", name: "Web · Frankfurt", kind: "ssh", host: "203.0.113.17", port: 22, user: "deploy", key_path: "", readonly: false, autoconnect: true },
  { id: "data", name: "Data · Amsterdam", kind: "ssh", host: "198.51.100.42", port: 22, user: "deploy", key_path: "", readonly: true, autoconnect: true },
  { id: "edge", name: "Edge · Warsaw", kind: "ssh", host: "192.0.2.88", port: 2222, user: "root", key_path: "", readonly: false, autoconnect: false },
];

const ctr = (id, name, image, state, status, project, service, ports = "") => ({
  id, name, image, state, status, project, service, ports,
  workdir: project ? `/srv/${project}` : "",
  config_file: project ? `/srv/${project}/docker-compose.yml` : "",
});

const D_CONTAINERS = {
  web: [
    ctr("c1a2b3c4d5e6", "shopfront-web-1", "nginx:1.27-alpine", "running", "Up 6 days (healthy)", "shopfront", "web", "8080:80, 8443:443"),
    ctr("c2b3c4d5e6f7", "shopfront-api-1", "ghcr.io/example/shopfront-api:1.8.2", "running", "Up 6 days (healthy)", "shopfront", "api", "3000:3000"),
    ctr("c3c4d5e6f7a8", "shopfront-worker-1", "ghcr.io/example/shopfront-api:1.8.2", "running", "Up 6 days", "shopfront", "worker"),
    ctr("c4d5e6f7a8b9", "shopfront-postgres-1", "postgres:16-alpine", "running", "Up 6 days (healthy)", "shopfront", "postgres", "5432:5432"),
    ctr("c5e6f7a8b9c1", "shopfront-redis-1", "redis:7-alpine", "running", "Up 6 days (healthy)", "shopfront", "redis"),
    ctr("d1a2b3c4d5e6", "analytics-grafana-1", "grafana/grafana:11.2.0", "running", "Up 3 days", "analytics", "grafana", "3001:3000"),
    ctr("d2b3c4d5e6f7", "analytics-clickhouse-1", "clickhouse/clickhouse-server:24.8", "running", "Up 3 days (unhealthy)", "analytics", "clickhouse", "8123:8123"),
    ctr("e1a2b3c4d5e6", "mailer", "axllent/mailpit:v1.20", "running", "Up 12 days", "", "", "8025:8025"),
    ctr("e2b3c4d5e6f7", "backup-cron", "alpine:3.20", "exited", "Exited (0) 4 hours ago", "", ""),
    ctr("e3c4d5e6f7a8", "legacy-import", "python:3.12-slim", "exited", "Exited (137) 2 days ago", "", ""),
  ],
  data: [
    ctr("f1a2b3c4d5e6", "warehouse-clickhouse-1", "clickhouse/clickhouse-server:24.8", "running", "Up 21 days (healthy)", "warehouse", "clickhouse", "9000:9000"),
    ctr("f2b3c4d5e6f7", "warehouse-metabase-1", "metabase/metabase:v0.50", "running", "Up 21 days (healthy)", "warehouse", "metabase", "3002:3000"),
    ctr("f3c4d5e6f7a8", "warehouse-minio-1", "minio/minio:RELEASE.2024-08-17", "running", "Up 21 days", "warehouse", "minio", "9001:9001"),
  ],
  local: [
    ctr("a1a2b3c4d5e6", "shopfront-api-dev", "shopfront-api:dev", "running", "Up 40 minutes", "", "", "3000:3000"),
    ctr("a2b3c4d5e6f7", "postgres-dev", "postgres:16-alpine", "running", "Up 40 minutes (healthy)", "", "", "55432:5432"),
    ctr("a3c4d5e6f7a8", "mailpit-dev", "axllent/mailpit:v1.20", "exited", "Exited (0) 2 days ago", "", ""),
  ],
  // якщо на Edge «поставити Docker» (dm.dockerDown.delete("edge")), знайдеться це
  edge: [
    ctr("z1a2b3c4d5e6", "edge-proxy-1", "caddy:2.8-alpine", "running", "Up 2 hours (healthy)", "edge", "proxy", "443:443"),
    ctr("z2b3c4d5e6f7", "edge-agent-1", "ghcr.io/example/agent:0.9", "running", "Up 2 hours", "edge", "agent"),
  ],
};

const D_IMAGES = {
  web: [
    { id: "sha256:9f1c2d3e4a5b", tags: ["ghcr.io/example/shopfront-api:1.8.2"], size: 284_000_000, created: 1786000000 },
    { id: "sha256:8e2b3c4d5f6a", tags: ["nginx:1.27-alpine"], size: 48_300_000, created: 1785600000 },
    { id: "sha256:7d3c4b5a6e9f", tags: ["postgres:16-alpine"], size: 391_000_000, created: 1785000000 },
    { id: "sha256:6c4d5e6f7a8b", tags: ["redis:7-alpine"], size: 41_200_000, created: 1784400000 },
    { id: "sha256:5b5e6f7a8b9c", tags: ["grafana/grafana:11.2.0"], size: 612_000_000, created: 1783800000 },
    { id: "sha256:4a6f7a8b9c1d", tags: [], size: 178_000_000, created: 1783200000 },
  ],
  data: [
    { id: "sha256:3b7a8b9c1d2e", tags: ["clickhouse/clickhouse-server:24.8"], size: 1_020_000_000, created: 1784000000 },
    { id: "sha256:2c8b9c1d2e3f", tags: ["metabase/metabase:v0.50"], size: 743_000_000, created: 1783000000 },
  ],
  local: [
    { id: "sha256:1d9c1d2e3f4a", tags: ["shopfront-api:dev"], size: 296_000_000, created: 1786100000 },
    { id: "sha256:0e1d2e3f4a5b", tags: ["postgres:16-alpine"], size: 391_000_000, created: 1785000000 },
  ],
};

const D_VOLUMES = {
  web: [
    { name: "shopfront_pgdata", driver: "local", mountpoint: "/var/lib/docker/volumes/shopfront_pgdata/_data" },
    { name: "shopfront_uploads", driver: "local", mountpoint: "/var/lib/docker/volumes/shopfront_uploads/_data" },
    { name: "analytics_grafana", driver: "local", mountpoint: "/var/lib/docker/volumes/analytics_grafana/_data" },
  ],
  data: [{ name: "warehouse_ch", driver: "local", mountpoint: "/var/lib/docker/volumes/warehouse_ch/_data" }],
  local: [{ name: "pgdata-dev", driver: "local", mountpoint: "/var/lib/docker/volumes/pgdata-dev/_data" }],
};

const D_NETWORKS = {
  web: [
    { id: "n1", name: "bridge", driver: "bridge", scope: "local" },
    { id: "n2", name: "shopfront_default", driver: "bridge", scope: "local" },
    { id: "n3", name: "analytics_default", driver: "bridge", scope: "local" },
  ],
  data: [{ id: "n1", name: "bridge", driver: "bridge", scope: "local" }, { id: "n4", name: "warehouse_default", driver: "bridge", scope: "local" }],
  local: [{ id: "n1", name: "bridge", driver: "bridge", scope: "local" }],
};

const D_HOSTS = {
  web: { hostname: "web-01", ncpu: 4, mem_total: 8 * GB, disks: [{ mount: "/", size: 160 * GB, used: 63 * GB }] },
  data: { hostname: "data-01", ncpu: 8, mem_total: 32 * GB, disks: [{ mount: "/", size: 200 * GB, used: 88 * GB }, { mount: "/mnt/warehouse", size: 2000 * GB, used: 1460 * GB }] },
  edge: { hostname: "edge-01", ncpu: 2, mem_total: 4 * GB, disks: [{ mount: "/", size: 80 * GB, used: 22 * GB }] },
};

const D_PS = [
  "root         1  0.0  0.1  22536  4212 ?        Ss   Jul22   0:11 /sbin/init",
  "root       412  0.3  1.9 1284500 158220 ?      Ssl  Jul22  42:17 /usr/bin/dockerd -H fd://",
  "postgres  1841  1.2  6.4 1420880 528440 ?      Ss   Aug04  18:52 postgres: checkpointer",
  "app       2204  4.7  9.1 2841200 748920 ?      Sl   Aug04  91:04 gunicorn: master [shopfront.wsgi]",
  "app       2211  2.1  7.8 2610440 641180 ?      Sl   Aug04  40:12 gunicorn: worker [shopfront.wsgi]",
  "app       2450  0.8  3.2  984120 264400 ?      Ssl  Aug04  12:41 celery worker -Q default",
  "www-data  2610  0.1  0.4  142300  36980 ?      S    Aug04   2:03 nginx: worker process",
  "redis     2733  0.4  0.6  198440  52120 ?      Ssl  Aug04   6:55 redis-server *:6379",
];

/* ── файлова система ────────────────────────────────── */
const f = (name, is_dir, size, perms, owner) => ({ name, is_dir, is_link: false, size, perms, owner });
const D_FS = {
  "/": [f("srv", true, 4096, "drwxr-xr-x", "root"), f("etc", true, 4096, "drwxr-xr-x", "root"),
        f("var", true, 4096, "drwxr-xr-x", "root"), f("home", true, 4096, "drwxr-xr-x", "root"),
        f("opt", true, 4096, "drwxr-xr-x", "root"), f("usr", true, 4096, "drwxr-xr-x", "root")],
  "/srv": [f("shopfront", true, 4096, "drwxr-xr-x", "deploy"), f("analytics", true, 4096, "drwxr-xr-x", "deploy")],
  "/srv/shopfront": [
    f("app", true, 4096, "drwxr-xr-x", "deploy"),
    f("nginx", true, 4096, "drwxr-xr-x", "deploy"),
    f("uploads", true, 4096, "drwxr-xr-x", "deploy"),
    f(".env", false, 812, "-rw-------", "deploy"),
    f("docker-compose.yml", false, 2140, "-rw-r--r--", "deploy"),
    f("docker-compose.override.yml", false, 486, "-rw-r--r--", "deploy"),
    f("Dockerfile", false, 1204, "-rw-r--r--", "deploy"),
    f("deploy.sh", false, 640, "-rwxr-xr-x", "deploy"),
    f("README.md", false, 3180, "-rw-r--r--", "deploy"),
  ],
  "/srv/analytics": [
    f("dashboards", true, 4096, "drwxr-xr-x", "deploy"),
    f("docker-compose.yml", false, 1620, "-rw-r--r--", "deploy"),
    f(".env", false, 340, "-rw-------", "deploy"),
  ],
};

const D_FILES = {
  "/srv/shopfront/docker-compose.yml": `services:
  web:
    image: nginx:1.27-alpine
    ports: ["8080:80", "8443:443"]
    depends_on: [api]
    volumes:
      - ./nginx/site.conf:/etc/nginx/conf.d/default.conf:ro

  api:
    image: ghcr.io/example/shopfront-api:1.8.2
    env_file: .env
    ports: ["3000:3000"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/healthz"]
      interval: 30s
    depends_on: [postgres, redis]

  worker:
    image: ghcr.io/example/shopfront-api:1.8.2
    command: celery -A shopfront worker -Q default
    env_file: .env

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: shopfront
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine

volumes:
  pgdata:
  uploads:
`,
  "/srv/shopfront/.env": `APP_ENV=production
APP_URL=https://shop.example.com
POSTGRES_DB=shopfront
POSTGRES_USER=shopfront
POSTGRES_PASSWORD=change-me-in-production
REDIS_URL=redis://redis:6379/0
SMTP_HOST=mailer
SMTP_PORT=1025
SENTRY_DSN=https://public@sentry.example.com/42
`,
};

const D_DU = {
  "/": { total: 63 * GB, entries: [
    { name: "var", path: "/var", size: 41 * GB, is_dir: true },
    { name: "srv", path: "/srv", size: 14 * GB, is_dir: true },
    { name: "usr", path: "/usr", size: 6 * GB, is_dir: true },
    { name: "opt", path: "/opt", size: 1.4 * GB, is_dir: true },
    { name: "home", path: "/home", size: 420 * MB, is_dir: true },
    { name: "etc", path: "/etc", size: 12 * MB, is_dir: true },
  ] },
  "/var": { total: 41 * GB, entries: [
    { name: "lib", path: "/var/lib", size: 36 * GB, is_dir: true },
    { name: "log", path: "/var/log", size: 4.2 * GB, is_dir: true },
    { name: "cache", path: "/var/cache", size: 780 * MB, is_dir: true },
    { name: "backups", path: "/var/backups", size: 92 * MB, is_dir: true },
  ] },
};

/* ── логи ───────────────────────────────────────────── */
const D_LOG_HISTORY = [
  "2026-08-10 09:14:02,118 INFO  [shopfront.api] worker booted, pid=1 concurrency=4",
  "2026-08-10 09:14:02,240 INFO  [shopfront.db] connected to postgres://postgres:5432/shopfront",
  "2026-08-10 09:14:02,244 INFO  [shopfront.cache] redis pool ready (10 connections)",
  '2026-08-10 09:14:03,010 INFO  [access] 200 GET /healthz 1.2ms',
  '2026-08-10 09:15:41,880 INFO  [access] 200 POST /api/v1/cart 34.7ms',
  '2026-08-10 09:16:02,455 WARNING [shopfront.payments] gateway latency 1840ms, retrying (1/3)',
  '2026-08-10 09:16:04,301 INFO  [access] 201 POST /api/v1/orders 2210.4ms',
  "2026-08-10 09:18:22,704 ERROR [shopfront.tasks] Traceback (most recent call last):",
  '  File "/app/shopfront/tasks.py", line 88, in send_receipt',
  "    invoice = build_invoice(order_id)",
  '  File "/app/shopfront/billing.py", line 31, in build_invoice',
  "    return Invoice(order=Order.objects.get(pk=order_id))",
  '  File "/usr/local/lib/python3.12/site-packages/django/db/models/query.py", line 637, in get',
  "    raise self.model.DoesNotExist(",
  "shopfront.models.Order.DoesNotExist: Order matching query does not exist.",
  "2026-08-10 09:18:22,706 INFO  [shopfront.tasks] task send_receipt[4f2a] retried in 30s",
  '2026-08-10 09:19:15,002 INFO  [access] 200 GET /api/v1/products?page=2 18.9ms',
  '2026-08-10 09:20:00,114 INFO  [shopfront.cron] nightly reindex finished in 4.2s',
];

const D_LOG_TICK = [
  '{now} INFO  [access] 200 GET /api/v1/products 12.4ms',
  '{now} INFO  [access] 200 GET /healthz 0.9ms',
  '{now} INFO  [shopfront.cache] hit ratio 0.94 over last 1000 requests',
  '{now} INFO  [access] 201 POST /api/v1/cart 41.2ms',
  '{now} WARNING [shopfront.payments] gateway latency 1210ms',
];

/* ── шина подій замість справжньої ──────────────────── */
const bus = {};
function emit(event, payload) {
  (bus[event] ?? []).forEach(cb => {
    try { cb({ payload }); } catch (e) { console.error(e); }
  });
}
function fakeListen(event, cb) {
  (bus[event] ??= []).push(cb);
  return Promise.resolve(() => {
    bus[event] = bus[event].filter(x => x !== cb);
  });
}

/* ── стан демо ──────────────────────────────────────── */
const dm = {
  profiles: D_PROFILES.map(p => ({ ...p })),
  projects: [],
  up: new Set(),
  monitors: new Map(),   // conn -> timer
  logTimer: null,
  statsTimer: null,
  logCid: null,
  terms: new Map(),      // sid -> { cwd, buf }
  cpuPhase: 0,
  // сервери, на яких «немає Docker» — щоб показати цей стан і його відновлення;
  // приберіть звідси id, і наступна перевірка знайде демон
  dockerDown: new Set(["edge"]),
};

/** Відповідь про демон: «Edge» навмисно без Docker, щоб показати цей стан. */
function engineInfo(conn, startup_ms) {
  if (dm.dockerDown.has(conn)) {
    return {
      version: "", api_version: "", os: "", startup_ms,
      docker_ok: false,
      docker_error: "демон не відповідає на сокеті — схоже, Docker не встановлено або не запущено",
    };
  }
  return {
    version: "27.1.2", api_version: "1.46", os: "linux x86_64",
    startup_ms, docker_ok: true, docker_error: "",
  };
}

const clone = v => JSON.parse(JSON.stringify(v));
const pick = (map, conn) => clone(map[conn] ?? []);
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 23).replace(".", ",");

/** Плавно «дихаючі» метрики: рівний графік виглядав би мертвим. */
function monSample(conn) {
  const h = D_HOSTS[conn] ?? D_HOSTS.web;
  const t = (dm.cpuPhase += 0.7);
  const base = conn === "data" ? 46 : conn === "edge" ? 8 : 23;
  const cpu = Math.max(2, Math.min(99, base + Math.sin(t) * 11 + Math.sin(t * 2.3) * 5));
  const usedFrac = conn === "data" ? 0.71 : 0.44;
  const mem_avail = Math.round(h.mem_total * (1 - usedFrac + Math.sin(t * 0.6) * 0.03));
  return {
    conn, cpu_pct: cpu, ncpu: h.ncpu,
    mem_total: h.mem_total, mem_avail,
    load: `${(cpu / 25).toFixed(2)} ${(cpu / 28).toFixed(2)} ${(cpu / 31).toFixed(2)}`,
    uptime: 3_942_000 + Date.now() / 1000 % 1000,
    hostname: h.hostname,
    disks: h.disks,
    ps: D_PS,
  };
}

/* ── вигаданий shell ────────────────────────────────── */
const SHELL_REPLIES = {
  "ls": "app  nginx  uploads  docker-compose.yml  .env  deploy.sh  README.md",
  "ls -la": "total 40\r\ndrwxr-xr-x  5 deploy deploy 4096 Aug 10 09:02 .\r\ndrwxr-xr-x  4 root   root   4096 Jul 22 11:40 ..\r\n-rw-------  1 deploy deploy  812 Aug 08 18:21 .env\r\n-rw-r--r--  1 deploy deploy 2140 Aug 08 18:20 docker-compose.yml",
  "pwd": "/srv/shopfront",
  "whoami": "deploy",
  "uptime": " 09:21:14 up 45 days,  6:33,  1 user,  load average: 0.92 0.81 0.74",
  "df -h": "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1       160G   63G   90G  42% /",
  "free -m": "               total        used        free      shared  buff/cache   available\r\nMem:            8192        3584         912         104        3696        4508",
  "docker ps": "CONTAINER ID   IMAGE                                  STATUS                 NAMES\r\nc1a2b3c4d5e6   nginx:1.27-alpine                      Up 6 days (healthy)    shopfront-web-1\r\nc2b3c4d5e6f7   ghcr.io/example/shopfront-api:1.8.2    Up 6 days (healthy)    shopfront-api-1\r\nc4d5e6f7a8b9   postgres:16-alpine                     Up 6 days (healthy)    shopfront-postgres-1",
};

function shellPrompt(sid) {
  const s = dm.terms.get(sid);
  return `\x1b[32mdeploy@web-01\x1b[0m:\x1b[34m${s.cwd}\x1b[0m$ `;
}

function shellRun(sid, line) {
  const cmd = line.trim();
  if (!cmd) return "";
  if (SHELL_REPLIES[cmd]) return SHELL_REPLIES[cmd] + "\r\n";
  if (cmd.startsWith("echo ")) return cmd.slice(5) + "\r\n";
  if (cmd.startsWith("cat ")) {
    const p = cmd.slice(4).trim();
    const key = p.startsWith("/") ? p : "/srv/shopfront/" + p;
    const body = D_FILES[key];
    return body ? body.replace(/\n/g, "\r\n") : `cat: ${p}: No such file or directory\r\n`;
  }
  if (cmd === "clear") return "\x1b[2J\x1b[H";
  return `${cmd.split(" ")[0]}: command not found\r\n`;
}

/* ── маршрутизатор викликів ─────────────────────────── */
async function route(cmd, a = {}) {
  const conn = a.conn ?? a.profileId ?? a.id;

  switch (cmd) {
    /* профілі та підключення */
    case "list_profiles": return clone(dm.profiles);
    case "list_projects": return clone(dm.projects);
    case "set_autoconnect": {
      const p = dm.profiles.find(x => x.id === a.id);
      if (p) p.autoconnect = a.on;
      return clone(dm.profiles);
    }
    case "save_profile": {
      const p = { ...a.profile, id: a.profile.id || "p" + Date.now(), autoconnect: false };
      const i = dm.profiles.findIndex(x => x.id === p.id);
      if (i >= 0) dm.profiles[i] = p; else dm.profiles.push(p);
      return clone(dm.profiles);
    }
    case "delete_profile":
      dm.profiles = dm.profiles.filter(x => x.id !== a.id || x.id === "local");
      return clone(dm.profiles);
    case "save_project": {
      const p = { ...a.project, id: a.project.id || "j" + Date.now() };
      p.name = p.name || p.path.split("/").pop();
      const i = dm.projects.findIndex(x => x.id === p.id);
      if (i >= 0) dm.projects[i] = p; else dm.projects.push(p);
      return clone(dm.projects);
    }
    case "delete_project":
      dm.projects = dm.projects.filter(x => x.id !== a.id);
      return clone(dm.projects);
    case "project_probe": return { exists: true, compose: "docker-compose.yml", dockerfile: true, git: true };

    case "connect":
      dm.up.add(a.profileId);
      return engineInfo(a.profileId, 380);
    case "docker_probe":
      return engineInfo(conn, 0);
    case "disconnect":
      dm.up.delete(a.id);
      stopMonitor(a.id);
      return null;
    case "active_connections": return [...dm.up];

    /* контейнери */
    case "list_containers": return pick(D_CONTAINERS, conn);
    case "container_action": {
      const list = D_CONTAINERS[conn] ?? [];
      const c = list.find(x => x.id === a.id);
      if (c) {
        if (a.action === "start" || a.action === "unpause") { c.state = "running"; c.status = "Up 1 second"; }
        if (a.action === "stop") { c.state = "exited"; c.status = "Exited (0) 1 second ago"; }
        if (a.action === "restart") { c.state = "running"; c.status = "Up 1 second"; }
        if (a.action === "pause") { c.state = "paused"; c.status = "Up 6 days (Paused)"; }
        if (a.action === "rm") D_CONTAINERS[conn] = list.filter(x => x.id !== a.id);
        setTimeout(() => emit("docker-event", { conn, action: a.action === "rm" ? "destroy" : a.action, id: a.id, name: c.name, image: c.image, exit_code: "0" }), 120);
      }
      return null;
    }
    case "containers_stats_snapshot":
      return (D_CONTAINERS[conn] ?? []).filter(c => c.state === "running").map((c, i) => ({
        id: c.id, name: c.name,
        cpu_pct: [4.8, 12.3, 1.1, 0.6, 0.3, 2.7, 18.4, 0.2][i % 8],
        mem_usage: [96, 512, 288, 402, 34, 208, 1340, 28][i % 8] * MB,
        mem_limit: 8 * GB,
        net_rx: [12, 480, 96, 210, 8, 64, 1820, 3][i % 8] * MB,
        net_tx: [30, 260, 44, 180, 6, 88, 940, 2][i % 8] * MB,
        pids: [9, 41, 12, 18, 5, 22, 64, 3][i % 8],
      }));
    case "inspect_container": {
      const c = (D_CONTAINERS[conn] ?? []).find(x => x.id === a.id) ?? {};
      return {
        Id: a.id, Created: "2026-08-04T09:14:01.882Z",
        State: { Status: c.state, StartedAt: "2026-08-04T09:14:02.104Z", Health: { Status: "healthy" } },
        Config: {
          Image: c.image, WorkingDir: "/app",
          Cmd: ["gunicorn", "shopfront.wsgi", "-b", "0.0.0.0:3000"],
          Env: [
            "APP_ENV=production", "APP_URL=https://shop.example.com",
            "POSTGRES_HOST=postgres", "POSTGRES_DB=shopfront", "POSTGRES_USER=shopfront",
            "POSTGRES_PASSWORD=s3cret-not-real", "REDIS_URL=redis://redis:6379/0",
            "SMTP_HOST=mailer", "SMTP_PORT=1025", "WEB_CONCURRENCY=4",
            "SENTRY_DSN=https://public@sentry.example.com/42", "LOG_LEVEL=INFO",
          ],
        },
        HostConfig: { RestartPolicy: { Name: "unless-stopped" }, Memory: 2 * GB, NanoCpus: 1_500_000_000 },
        NetworkSettings: { Ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] }, Networks: { shopfront_default: {} } },
        Mounts: [{ Source: "shopfront_uploads", Destination: "/app/uploads", Type: "volume", RW: true }],
      };
    }
    case "container_diff": return [
      { kind: "modified", path: "/app/shopfront/settings.py" },
      { kind: "added", path: "/app/uploads/2026-08-10" },
      { kind: "added", path: "/tmp/celerybeat-schedule" },
      { kind: "deleted", path: "/app/static/.cache" },
    ];
    case "update_resources": return null;
    case "recreate_with_env": return a.id;

    /* ресурси */
    case "list_images": return pick(D_IMAGES, conn);
    case "list_volumes": return pick(D_VOLUMES, conn);
    case "list_networks": return pick(D_NETWORKS, conn);
    case "remove_image": case "remove_volume": case "remove_network": return null;
    case "prune": return "Звільнено 1.8 ГБ";
    case "system_df": return {
      images_total: 1_654_000_000, images_count: 6, images_unused: 178_000_000,
      containers_total: 412_000_000, containers_count: 10,
      volumes_total: 3_120_000_000, volumes_count: 3, volumes_unused: 640_000_000,
      build_cache: 890_000_000,
    };
    case "image_history": return [
      { size: 0, created: 1786000000, created_by: "/bin/sh -c #(nop)  CMD [\"gunicorn\" \"shopfront.wsgi\"]" },
      { size: 12_400_000, created: 1786000000, created_by: "/bin/sh -c python -m compileall -q /app" },
      { size: 96_800_000, created: 1786000000, created_by: "/bin/sh -c pip install --no-cache-dir -r requirements.txt" },
      { size: 4_200_000, created: 1785999000, created_by: "/bin/sh -c #(nop) COPY dir:a1b2c3 in /app" },
      { size: 128_000_000, created: 1785900000, created_by: "/bin/sh -c apt-get update && apt-get install -y libpq5" },
      { size: 42_600_000, created: 1785800000, created_by: "/bin/sh -c #(nop) ADD file:python3.12-slim in /" },
    ];
    case "scan_image": return {
      total: 14, critical: 1, high: 3, medium: 6, low: 4, fixable: 9,
      vulns: [
        { id: "CVE-2026-10121", severity: "CRITICAL", pkg: "libssl3", installed: "3.0.13-1", fixed: "3.0.14-1", title: "Use-after-free in TLS session handling", url: "https://example.com/cve/2026-10121" },
        { id: "CVE-2026-10488", severity: "HIGH", pkg: "libpq5", installed: "16.3-1", fixed: "16.4-1", title: "Improper certificate validation", url: "" },
        { id: "CVE-2026-10502", severity: "HIGH", pkg: "zlib1g", installed: "1:1.3-1", fixed: "1:1.3.1-1", title: "Heap overflow in inflate()", url: "" },
        { id: "CVE-2026-10744", severity: "HIGH", pkg: "python3.12", installed: "3.12.4-1", fixed: "", title: "Denial of service in email parser", url: "" },
        { id: "CVE-2026-11003", severity: "MEDIUM", pkg: "curl", installed: "8.8.0-1", fixed: "8.9.1-1", title: "Cookie leak across redirects", url: "" },
        { id: "CVE-2026-11190", severity: "MEDIUM", pkg: "libxml2", installed: "2.12.7", fixed: "2.12.9", title: "Out-of-bounds read in XPath", url: "" },
      ],
    };
    case "registry_list": return ["ghcr.io", "registry.example.com"];
    case "registry_save": case "registry_delete": case "push_image": case "pull_image": case "build_image": case "create_container": return null;
    case "import_contexts": return [];

    /* логи */
    case "start_logs": {
      dm.logCid = a.id;
      clearInterval(dm.logTimer);
      setTimeout(() => {
        emit("log-state", { conn: a.conn, cid: a.id, state: "open" });
        for (const l of D_LOG_HISTORY) emit("docker-log", { conn: a.conn, cid: a.id, line: l + "\n" });
      }, 120);
      dm.logTimer = setInterval(() => {
        const line = D_LOG_TICK[Math.floor(Date.now() / 1000) % D_LOG_TICK.length].replace("{now}", stamp());
        emit("docker-log", { conn: a.conn, cid: dm.logCid, line: line + "\n" });
      }, 2500);
      return null;
    }
    case "stop_logs": clearInterval(dm.logTimer); dm.logTimer = null; return null;
    case "logs_multi_start": {
      const targets = a.targets ?? [];
      clearInterval(dm.logTimer);
      dm.logTimer = setInterval(() => {
        targets.forEach(([, label], i) => {
          emit("docker-log-multi", {
            conn: a.conn, label, color: i % 8,
            line: `${stamp()} INFO  [${label}] heartbeat ok\n`,
          });
        });
      }, 2200);
      return null;
    }
    case "logs_multi_stop": clearInterval(dm.logTimer); dm.logTimer = null; return null;
    case "logs_search": {
      const hits = D_LOG_HISTORY
        .map((line, index) => ({ line, index }))
        .filter(h => h.line.toLowerCase().includes((a.query ?? "").toLowerCase()));
      return { hits, scanned: 128_400, took_ms: 96, truncated: false };
    }
    case "start_stats": {
      clearInterval(dm.statsTimer);
      const send = () => emit("docker-stats", {
        conn: a.conn, cid: a.id,
        cpu_pct: 8 + Math.sin(Date.now() / 3000) * 5,
        mem_usage: (512 + Math.sin(Date.now() / 5000) * 40) * (1 << 20),
        mem_limit: 2 * GB,
      });
      send();
      dm.statsTimer = setInterval(send, 2000);
      return null;
    }

    /* файли */
    case "fs_list": case "host_fs_list": {
      const p = a.path === "" ? "/" : a.path.replace(/\/$/, "") || "/";
      return clone(D_FS[p] ?? D_FS["/srv/shopfront"]);
    }
    case "fs_read": case "host_fs_read": {
      const body = D_FILES[a.path] ?? `# ${a.path}\n\nДемо-режим: цей файл вигаданий.\n`;
      return { content_b64: strToB64(body), size: body.length, truncated: false, binary: false };
    }
    case "host_du": return clone(D_DU[a.path] ?? D_DU["/"]);
    case "host_fs_find": {
      const q = (a.query ?? "").toLowerCase();
      const all = [
        { path: "/srv/shopfront/docker-compose.yml", is_dir: false },
        { path: "/srv/shopfront/docker-compose.override.yml", is_dir: false },
        { path: "/srv/analytics/docker-compose.yml", is_dir: false },
        { path: "/srv/shopfront/.env", is_dir: false },
        { path: "/srv/shopfront/nginx", is_dir: true },
      ];
      return all.filter(x => x.path.toLowerCase().includes(q));
    }
    case "host_kill": return null;

    /* монітор хоста */
    case "host_monitor_start": {
      stopMonitor(conn);
      emit("host-monitor", monSample(conn));
      dm.monitors.set(conn, setInterval(() => emit("host-monitor", monSample(conn)), (a.interval ?? 3) * 1000));
      return null;
    }
    case "host_monitor_stop": stopMonitor(conn); return null;

    /* термінали */
    case "term_open": case "host_term_open": case "local_term_open": {
      const sid = "demo" + Math.floor(Date.now() % 100000);
      dm.terms.set(sid, { cwd: "/srv/shopfront", buf: "" });
      setTimeout(() => {
        emit("term-output", { sid, data_b64: strToB64(
          "Linux web-01 6.8.0-40-generic x86_64\r\n" +
          "Last login: Mon Aug 10 09:02:11 2026 from 203.0.113.9\r\n\r\n" + shellPrompt(sid)) });
      }, 150);
      return sid;
    }
    case "term_input": case "host_term_input": {
      const s = dm.terms.get(a.sid);
      if (!s) return null;
      const data = b64ToStr(a.dataB64 ?? a.data_b64 ?? "");
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const out = shellRun(a.sid, s.buf);
          s.buf = "";
          emit("term-output", { sid: a.sid, data_b64: strToB64("\r\n" + out + shellPrompt(a.sid)) });
        } else if (ch === "\x7f") {
          if (s.buf) { s.buf = s.buf.slice(0, -1); emit("term-output", { sid: a.sid, data_b64: strToB64("\b \b") }); }
        } else if (ch >= " ") {
          s.buf += ch;
          emit("term-output", { sid: a.sid, data_b64: strToB64(ch) });
        }
      }
      return null;
    }
    case "term_resize": case "host_term_resize": return null;
    case "term_close": case "host_term_close": dm.terms.delete(a.sid); return null;

    /* решта */
    case "compose_cmd": {
      const lines = [
        `$ docker ${a.action === "build" ? "compose build" : "compose " + a.action + " -d"}`,
        " ✔ Container shopfront-postgres-1  Healthy",
        " ✔ Container shopfront-redis-1     Healthy",
        " ✔ Container shopfront-api-1       Started",
        " ✔ Container shopfront-worker-1    Started",
        " ✔ Container shopfront-web-1       Started",
        "✓ Готово",
      ];
      lines.forEach((line, i) => setTimeout(
        () => emit("compose-output", { conn: a.conn, project: a.project, line, done: i === lines.length - 1 }),
        i * 350));
      return null;
    }
    case "forward_list": return [];
    case "forward_start": return { url: "http://127.0.0.1:18080", local_port: 18080, key: "k1" };
    case "forward_stop": return null;
    case "journal_list": return [
      { ts: Date.now() / 1000 - 120, conn: "web", action: "restart", target: "c2b3c4d5e6f7", detail: "shopfront-api-1", ok: true },
      { ts: Date.now() / 1000 - 900, conn: "web", action: "compose up", target: "shopfront", detail: "5 services", ok: true },
      { ts: Date.now() / 1000 - 3600, conn: "data", action: "stop", target: "f3c4d5e6f7a8", detail: "read-only profile", ok: false },
      { ts: Date.now() / 1000 - 7200, conn: "web", action: "prune", target: "images", detail: "звільнено 1.8 ГБ", ok: true },
    ];
    case "journal_clear": return null;
    case "tg_status": return { configured: false, chat_id: "" };
    case "tg_save": case "tg_forget": case "tg_send": return null;
    case "tg_detect_chat": return { chat_id: "-1001234567890", title: "Prystan demo" };
    case "check_update": return { current: "0.1.0", latest: "0.1.0", newer: false, url: "", notes: "" };
    case "clipboard_read": return "";
    case "open_url": return null;

    default:
      if (cmd.startsWith("host_fs_") || cmd.startsWith("fs_")) return null;  // запис у демо мовчки вдається
      console.warn("demo: команда без заглушки —", cmd);
      return null;
  }
}

function stopMonitor(conn) {
  const t = dm.monitors.get(conn);
  if (t) { clearInterval(t); dm.monitors.delete(conn); }
}

/* ── встановлення підміни ───────────────────────────── */
function installDemo() {
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => route(cmd, args ?? {}) },
    event: { listen: fakeListen },
  };
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("demo");
    const badge = document.createElement("span");
    badge.className = "badge demo-badge";
    badge.textContent = "DEMO";
    badge.title = "Демо-режим: усі сервери, контейнери й адреси вигадані";
    document.querySelector("header .spacer")?.after(badge);
  });
}

if (DEMO) installDemo();
