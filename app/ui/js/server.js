"use strict";
/* Сервер: live-монітор, процеси, дашборд усіх серверів */

function syncMonitor() {
  const want = (S.view === "server" || S.view === "dash") ? S.activeConn : null;
  if (S.monActive && S.monActive !== want) {
    invoke("host_monitor_stop", { conn: S.monActive }).catch(() => {});
    S.monActive = null;
  }
  if (want && S.monActive !== want && activeProfile()?.kind === "ssh") {
    S.monActive = want;
    invoke("host_monitor_start", { conn: want }).catch(e => toast("Монітор: " + e));
  }
  // дашборд: тримаємо монітори всіх підключених ssh-серверів
  if (S.view === "dash") {
    for (const p of S.profiles) {
      if (p.kind === "ssh" && S.conns[p.id]?.up) invoke("host_monitor_start", { conn: p.id }).catch(() => {});
    }
  }
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
        <td><div class="racts"><button data-pid="${p.pid}" class="danger" title="kill">✕</button></div></td>
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
      <div class="sc-label">${esc(p.name)} <span class="cdot up"></span>${p.readonly ? " 🔒" : ""}</div>
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
    toast(`⚠ ${p.name}: ${msg}`, "warn", 9000);
    tgAlert(`⚠ <b>${p.name}</b>\n${msg}`);
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
    $("proc-updated").textContent = "🔴 live · " + new Date().toLocaleTimeString();
  }
});
listen("host-monitor-closed", ev => {
  if (S.monActive === ev.payload.conn) S.monActive = null;
});

function wireServerUI() {
  $("proc-filter").oninput = renderProc;
  $("proc-sort").onchange = renderProc;
}
