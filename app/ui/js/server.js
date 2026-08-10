"use strict";
/* Сервер: live-монітор, процеси, дашборд усіх серверів */

/**
 * Монітори всіх підключених SSH-серверів.
 * Відкритий сервер опитуємо часто, решту — рідко: пороги CPU/RAM/диска мають
 * спрацьовувати й тоді, коли ви дивитесь зовсім в інше місце, інакше алерти
 * ловлять лише те, що ви й так бачите на екрані.
 */
function syncMonitor() {
  const focused = (S.view === "server" || S.view === "dash") ? S.activeConn : null;
  const bg = S.cfg.bgMonitor;
  for (const p of S.profiles) {
    if (p.kind !== "ssh") continue;
    const up = S.conns[p.id]?.up;
    const fast = S.view === "dash" || p.id === focused;
    if (!up || (!fast && !bg)) {
      if (S.mon[p.id]) { invoke("host_monitor_stop", { conn: p.id }).catch(() => {}); delete S.mon[p.id]; }
      continue;
    }
    invoke("host_monitor_start", { conn: p.id, interval: fast ? 3 : bg })
      .catch(e => { if (fast) toast("Монітор: " + e); });
  }
  S.monActive = focused;
}

function meter(pct) {
  return `<div class="meter"><i class="${pct > 90 ? "crit" : pct > 70 ? "warn" : ""}" style="width:${Math.max(0, pct).toFixed(0)}%"></i></div>`;
}

function openSrvStats() {
  const d = S.mon[S.activeConn];
  if (d) renderSrvStats(d);
  else $("srv-stats").innerHTML = `<div class="placeholder"><span class="spin"></span> ${t("srv.connecting")}</div>`;
}

function renderSrvStats(d) {
  const memUsed = d.mem_total - d.mem_avail;
  const memPct = d.mem_total ? memUsed / d.mem_total * 100 : 0;
  const cpuTxt = d.cpu_pct < 0 ? "…" : d.cpu_pct.toFixed(1) + "%";
  const hist = S.monHist[S.activeConn]?.cpu ?? [];
  const memHist = S.monHist[S.activeConn]?.mem ?? [];
  $("srv-stats").innerHTML = `
    <div class="statgrid">
      <div class="statcard">
        <div class="sc-label">${t("srv.cpu")} (${d.ncpu} ${t("srv.cores")})</div>
        <div class="sc-value">${cpuTxt}</div>
        <div class="sc-sub">load: ${esc(d.load)}</div>
        ${meter(d.cpu_pct)}
        ${sparkline(hist, 100)}
      </div>
      <div class="statcard">
        <div class="sc-label">${t("srv.mem")}</div>
        <div class="sc-value">${fmtBytes(memUsed)}</div>
        <div class="sc-sub">${t("srv.of")} ${fmtBytes(d.mem_total)} (${memPct.toFixed(0)}%)</div>
        ${meter(memPct)}
        ${sparkline(memHist, 100)}
      </div>
      <div class="statcard">
        <div class="sc-label">${t("srv.server")}</div>
        <div class="sc-value" style="font-size:15px">${esc(d.hostname)}</div>
        <div class="sc-sub">${t("srv.uptime")}: ${fmtDur(d.uptime)}</div>
      </div>
      ${d.disks.map(dk => {
        const pct = dk.size ? dk.used / dk.size * 100 : 0;
        return `<div class="statcard">
          <div class="sc-label">${t("srv.disk")} ${esc(dk.mount)}</div>
          <div class="sc-value">${fmtBytes(dk.used)}</div>
          <div class="sc-sub">${t("srv.of")} ${fmtBytes(dk.size)} (${pct.toFixed(0)}%)</div>
          ${meter(pct)}
        </div>`;
      }).join("")}
    </div>
    <div class="hint" style="margin-top:12px">${t("srv.live")}</div>`;
}

/* процеси */
let procData = [];
function openSrvProc() {
  const d = S.mon[S.activeConn];
  if (d) { parseProc(d); renderProc(); }
  else $("proc-table").innerHTML = `<div class="placeholder"><span class="spin"></span> ${t("srv.connecting")}</div>`;
}

function parseProc(d) {
  procData = d.ps.map(l => {
    const m = l.trim().split(/\s+/);
    if (m.length < 11) return null;
    const cmd = m.slice(10).join(" ");
    if (cmd.includes("==B") || cmd.startsWith("sh -c while true")) return null;
    return { user: m[0], pid: +m[1], cpu: +m[2], mem: +m[3], rss: +m[5] * 1024, stat: m[7], cmd };
  }).filter(Boolean);
}

function renderProc() {
  const f = $("proc-filter").value.toLowerCase();
  const sortKey = $("proc-sort").value;
  const rows = procData
    .filter(p => !f || p.cmd.toLowerCase().includes(f) || p.user.toLowerCase().includes(f) || String(p.pid).includes(f))
    .sort((a, b) => b[sortKey] - a[sortKey])
    .slice(0, 60)
    .map(p => `
      <tr>
        <td class="mono">${p.pid}</td>
        <td>${esc(p.user)}</td>
        <td style="text-align:right;${p.cpu > 50 ? "color:var(--red)" : p.cpu > 20 ? "color:var(--yellow)" : ""}">${p.cpu.toFixed(1)}%</td>
        <td style="text-align:right">${p.mem.toFixed(1)}%</td>
        <td style="text-align:right">${fmtBytes(p.rss)}</td>
        <td class="grow mono" style="font-size:11px">${esc(p.cmd.slice(0, 140))}</td>
        <td><div class="racts"><button data-pid="${p.pid}" class="danger" title="kill">${ic("x")}</button></div></td>
      </tr>`).join("");
  $("proc-table").innerHTML = `<table class="grid">
    <thead><tr><th>PID</th><th>USER</th><th style="text-align:right">CPU</th><th style="text-align:right">MEM</th><th style="text-align:right">RSS</th><th>${t("srv.cmd")}</th><th style="width:40px"></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  $("proc-table").querySelectorAll("button[data-pid]").forEach(b => b.onclick = async () => {
    if (!guardRW("guard.kill")) return;
    const pid = +b.dataset.pid;
    const proc = procData.find(p => p.pid === pid);
    const ok = await ask({
      title: t("srv.killTitle", { pid }),
      text: `<span class="mono">${esc(proc?.cmd.slice(0, 120) ?? "")}</span><br><br>` + t("srv.killText"),
      okLabel: "kill",
    });
    if (!ok) return;
    try { await invoke("host_kill", { conn: S.activeConn, pid, signal: b.dataset.killed ? "KILL" : "TERM" }); b.dataset.killed = "1"; }
    catch (e) { toast("kill: " + e); }
  });
}

/* ═══ аналіз використання диска по теках ═══
   `df` каже, що диск повний, але не каже, чим саме. Тут — один рівень
   углиб із розмірами й смужками; у теку можна провалитись і копати далі. */

const duKey = () => (S.view === "project" ? "@proj:" + (S.project?.id ?? "") : S.activeConn);
const duConn = () => (S.view === "project" ? "local" : S.activeConn);
const duRoot = () => (S.view === "project" ? (S.project?.path ?? "/") : "/");
const duPath = () => S.duPath[duKey()] ?? duRoot();

/** Перейти до аналізу конкретної теки (з файлового менеджера чи меню). */
function gotoDu(path) {
  S.duPath[duKey()] = path;
  if (S.view === "project") S.projTab = "du";
  else { S.view = "server"; S.srvTab = "du"; }
  renderTree();
  renderDetail();
}

function openDu() {
  const cached = S.duData[duKey() + "|" + duPath()];
  $("du-path").value = duPath();
  if (cached) renderDu(cached);
  else runDu();
}

async function runDu() {
  const path = duPath();
  const conn = duConn();
  const key = duKey();
  $("du-path").value = path;
  $("du-total").textContent = "";
  $("du-body").innerHTML = loadingBox(t("du.scanning"));
  setBusy(true);
  try {
    const d = await invoke("host_du", { conn, path });
    S.duData[key + "|" + path] = d;
    if (duKey() !== key || duPath() !== path) return;   // користувач уже пішов далі
    renderDu(d);
  } catch (e) {
    $("du-body").innerHTML = errorBox(e);
  } finally {
    setBusy(false);
  }
}

function renderDu(d) {
  const max = d.entries.reduce((a, e) => Math.max(a, e.size), 0) || 1;
  const sum = d.entries.reduce((a, e) => a + e.size, 0);
  const total = d.total || sum || 1;
  $("du-total").textContent = `${t("du.total")}: ${fmtBytes(d.total || sum)}` +
    (d.partial ? " · " + t("du.partial") : "");
  if (!d.entries.length) {
    $("du-body").innerHTML = `<div class="placeholder">${t("files.empty")}</div>`;
    return;
  }
  $("du-body").innerHTML = d.entries.slice(0, 300).map(e => `
    <div class="durow ${e.is_dir ? "dir" : ""}" data-path="${esc(e.path)}" data-dir="${e.is_dir}">
      <span class="dn">${ic(e.is_dir ? "folder" : "file")}<span>${esc(e.name)}</span></span>
      <span class="dsize">${fmtBytes(e.size)}</span>
      <span class="dpct">${(e.size / total * 100).toFixed(1)}%</span>
      <span class="dbar"><i style="width:${(e.size / max * 100).toFixed(1)}%"></i></span>
    </div>`).join("");
  $("du-body").querySelectorAll(".durow.dir").forEach(el => el.onclick = () => {
    S.duPath[duKey()] = el.dataset.path;
    openDu();
  });
}

function wireDuUI() {
  $("du-go").onclick = () => {
    S.duPath[duKey()] = $("du-path").value.trim() || duRoot();
    runDu();
  };
  $("du-up").onclick = () => {
    const p = duPath();
    if (p === duRoot()) return;
    S.duPath[duKey()] = parentPath(p);
    openDu();
  };
  $("du-path").onkeydown = e => { if (e.key === "Enter") $("du-go").click(); };
}

/* C5 — дашборд усіх серверів */
function openDash() {
  renderDash();
}

function renderDash() {
  const cards = S.profiles.map(p => {
    const up = S.conns[p.id]?.up;
    const d = S.mon[p.id];
    const ctrs = p.id === S.activeConn ? S.containers : null;
    if (!up) {
      return `<div class="statcard clickable" data-conn="${esc(p.id)}">
        <div class="sc-label">${esc(p.name)}</div>
        <div class="sc-value" style="font-size:14px;color:var(--dim)">${t("srv.notConnected")}</div>
        <div class="sc-sub">${esc(p.kind === "ssh" ? p.user + "@" + p.host : p.kind)}</div>
      </div>`;
    }
    if (p.kind !== "ssh") {
      const run = ctrs ? ctrs.filter(c => c.state === "running").length : "—";
      return `<div class="statcard clickable" data-conn="${esc(p.id)}">
        <div class="sc-label">${esc(p.name)} <span class="cdot up"></span></div>
        <div class="sc-value" style="font-size:15px">${run}${ctrs ? " / " + ctrs.length : ""}</div>
        <div class="sc-sub">${t("srv.runningCtrs")}</div>
      </div>`;
    }
    if (!d) {
      return `<div class="statcard clickable" data-conn="${esc(p.id)}">
        <div class="sc-label">${esc(p.name)} <span class="cdot up"></span></div>
        <div class="sc-value" style="font-size:14px"><span class="spin"></span></div>
        <div class="sc-sub">${t("srv.collecting")}</div>
      </div>`;
    }
    const memPct = d.mem_total ? (d.mem_total - d.mem_avail) / d.mem_total * 100 : 0;
    const disk = d.disks[0];
    const diskPct = disk && disk.size ? disk.used / disk.size * 100 : 0;
    const worst = Math.max(d.cpu_pct, memPct, diskPct);
    return `<div class="statcard clickable" data-conn="${esc(p.id)}" style="${worst > 90 ? "border-color:var(--red)" : worst > 75 ? "border-color:var(--yellow)" : ""}">
      <div class="sc-label">${esc(p.name)} <span class="cdot up"></span>${p.readonly ? ic("lock", "sm") : ""}</div>
      <div class="sc-value" style="font-size:15px">${esc(d.hostname)}</div>
      <div class="sc-sub">CPU ${d.cpu_pct < 0 ? "…" : d.cpu_pct.toFixed(0) + "%"} · RAM ${memPct.toFixed(0)}% · ${t("srv.disk")} ${diskPct.toFixed(0)}%</div>
      ${meter(Math.max(0, d.cpu_pct))}
      ${meter(memPct)}
      <div class="sc-sub" style="margin-top:6px">${t("srv.uptime")} ${fmtDur(d.uptime)}</div>
    </div>`;
  }).join("");

  $("dash-body").innerHTML = `<div class="statgrid">${cards}</div>
    <div class="hint" style="margin-top:12px">${t("srv.dashHint")}</div>`;
  $("dash-body").querySelectorAll("[data-conn]").forEach(el => el.onclick = () => {
    const id = el.dataset.conn;
    if (S.conns[id]?.up) { switchConn(id); S.view = "server"; S.srvTab = "stats"; renderTree(); renderDetail(); }
    else connectProfile(id);
  });
}

/* C4 — алерти по порогах */
const alerted = {};
function checkAlerts(conn, d) {
  const p = S.profiles.find(x => x.id === conn);
  if (!p) return;
  const fire = (key, msg) => {
    const k = conn + ":" + key;
    if (alerted[k] && Date.now() - alerted[k] < 10 * 60 * 1000) return;
    alerted[k] = Date.now();
    toast(`${p.name}: ${msg}`, "warn", 9000);
    tgAlert(`⚠ <b>${p.name}</b>\n${msg}`, "thresholds");
  };
  const memPct = d.mem_total ? (d.mem_total - d.mem_avail) / d.mem_total * 100 : 0;
  if (memPct > 92) fire("mem", `пам'ять ${memPct.toFixed(0)}%`);
  if (d.cpu_pct > 95) fire("cpu", `CPU ${d.cpu_pct.toFixed(0)}%`);
  for (const dk of d.disks) {
    const pct = dk.size ? dk.used / dk.size * 100 : 0;
    if (pct > 90) fire("disk" + dk.mount, `диск ${dk.mount} заповнено на ${pct.toFixed(0)}%`);
  }
}

listen("host-monitor", ev => {
  const p = ev.payload;
  S.mon[p.conn] = p;
  if (!S.monHist[p.conn]) S.monHist[p.conn] = { cpu: [], mem: [] };
  if (p.cpu_pct >= 0) pushHist(S.monHist[p.conn], "cpu", p.cpu_pct);
  const memPct = p.mem_total ? (p.mem_total - p.mem_avail) / p.mem_total * 100 : 0;
  pushHist(S.monHist[p.conn], "mem", memPct);
  checkAlerts(p.conn, p);

  if (S.view === "dash") { renderDash(); return; }
  if (p.conn !== S.activeConn || S.view !== "server") return;
  if (S.srvTab === "stats") renderSrvStats(p);
  if (S.srvTab === "proc") {
    parseProc(p); renderProc();
    $("proc-updated").innerHTML = `<span class="livedot"></span> live · ${new Date().toLocaleTimeString()}`;
  }
});
listen("host-monitor-closed", ev => {
  if (S.monActive === ev.payload.conn) S.monActive = null;
});

function wireServerUI() {
  $("proc-filter").oninput = renderProc;
  $("proc-sort").onchange = renderProc;
}
