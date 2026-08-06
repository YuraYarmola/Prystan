"use strict";
/* Дерево, роутер вкладок, командна палітра, масові операції, старт */

/* ═══ дані ═══ */
async function refreshAll() {
  if (!S.activeConn || !S.conns[S.activeConn]?.up) { renderTree(); return; }
  try {
    const [c, i, v, n] = await Promise.all([
      invoke("list_containers", { conn: S.activeConn }),
      invoke("list_images", { conn: S.activeConn }),
      invoke("list_volumes", { conn: S.activeConn }),
      invoke("list_networks", { conn: S.activeConn }),
    ]);
    S.containers = c; S.images = i; S.volumes = v; S.networks = n;
    renderTree();
    if (S.view === "images") renderImages();
    if (S.view === "volumes") renderVolumes();
    if (S.view === "networks") renderNetworks();
    if (S.view === "dash") renderDash();
    if (S.view === "container" && S.selected) {
      const cur = S.containers.find(x => x.id === S.selected.id);
      if (cur) { S.selected = cur; renderDetailHeader(); }
    }
    if (S.view === "stack" && S.selectedStack) {
      S.selectedStack.rows = S.containers.filter(x => x.project === S.selectedStack.project);
      renderDetailHeader();
    }
  } catch (e) {
    const msg = String(e);
    // помилка транспорту = зʼєднання впало; підіймемо його, якщо воно «бажане»
    if (/connect|transport|broken pipe|refused|closed|немає активного/i.test(msg)) {
      markDown(S.activeConn, t("conn.lost"));
    } else {
      toast("Оновлення: " + msg);
    }
  }
}

/* ═══ health / фільтри ═══ */
function healthOf(c) {
  const s = (c.status || "").toLowerCase();
  if (s.includes("unhealthy")) return "unhealthy";
  if (s.includes("health: starting")) return "starting";
  if (s.includes("healthy")) return "healthy";
  return null;
}
function isProblem(c) {
  if (healthOf(c) === "unhealthy") return true;
  if (c.state === "restarting" || c.state === "dead") return true;
  const m = (c.status || "").match(/Exited \((\d+)\)/);
  return !!m && m[1] !== "0";
}
function passQuick(c) {
  if (S.quick === "running") return c.state === "running";
  if (S.quick === "stopped") return c.state !== "running";
  if (S.quick === "unhealthy") return isProblem(c);
  return true;
}

/* ═══ дерево ═══ */
function groupContainers(rows) {
  const groups = new Map();
  for (const c of rows) {
    const key = c.project || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const arr of groups.values())
    arr.sort((a, b) => (b.state === "running") - (a.state === "running") || a.name.localeCompare(b.name));
  return [...groups.entries()].sort((a, b) => {
    if (!a[0]) return 1; if (!b[0]) return -1;
    const ar = a[1].some(c => c.state === "running"), br = b[1].some(c => c.state === "running");
    if (ar !== br) return br - ar;
    return a[0].localeCompare(b[0]);
  });
}
function isCollapsed(project, rows) {
  if (S.collapsed.has(project)) return S.collapsed.get(project);
  return !rows.some(c => c.state === "running" || c.id === S.selected?.id);
}

function renderTree() {
  renderConnBox();
  const f = $("filter").value.toLowerCase();
  const tree = $("tree");
  tree.innerHTML = "";
  const prof = activeProfile();
  const up = S.conns[S.activeConn]?.up;

  // дашборд доступний завжди
  const dash = document.createElement("div");
  dash.className = "section";
  dash.innerHTML = `🗂 ${t("tree.dashboard")}`;
  if (S.view === "dash") dash.style.color = "var(--text)";
  dash.onclick = () => { S.view = "dash"; S.selected = null; S.selectedStack = null; renderTree(); renderDetail(); };
  tree.appendChild(dash);

  if (!up) {
    tree.insertAdjacentHTML("beforeend", `<div class="placeholder">${t("tree.connectFirst")}</div>`);
    return;
  }

  if (prof?.kind === "ssh") {
    const secS = document.createElement("div");
    secS.className = "section";
    secS.innerHTML = `${t("tree.server")} <span class="cnt">${esc(prof.host)}</span>`;
    tree.appendChild(secS);
    const row = document.createElement("div");
    row.id = "srvrow";
    for (const [tab, icon, label] of [["stats", "📊", t("tree.stats")], ["proc", "⚙️", t("tree.proc")], ["files", "📁", t("tree.hostFiles")], ["term", "⌨️", t("tree.hostTerm")]]) {
      const b = document.createElement("button");
      b.className = S.view === "server" && S.srvTab === tab ? "sel" : "";
      b.title = label;
      b.textContent = icon;
      b.onclick = () => { S.view = "server"; S.srvTab = tab; S.selected = null; S.selectedStack = null; renderTree(); renderDetail(); };
      row.appendChild(b);
    }
    tree.appendChild(row);
  }

  const secC = document.createElement("div");
  secC.className = "section";
  const runN = S.containers.filter(c => c.state === "running").length;
  const probN = S.containers.filter(isProblem).length;
  secC.innerHTML = `${t("tree.containers")} <span class="cnt">${probN ? `<span style="color:var(--red)">⚠${probN}</span> · ` : ""}${runN}/${S.containers.length}</span>`;
  tree.appendChild(secC);

  const shown = S.containers.filter(c => passQuick(c) && (!f ||
    c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) ||
    (c.project && c.project.toLowerCase().includes(f))));

  for (const [project, rows] of groupContainers(shown)) {
    const running = rows.filter(c => c.state === "running").length;
    const collapsed = project && !f && S.quick === "all" ? isCollapsed(project, rows) : false;

    if (project) {
      const g = document.createElement("div");
      g.className = "group" + (S.view === "stack" && S.selectedStack?.project === project ? " sel" : "");
      g.innerHTML = `
        <span class="tri">${collapsed ? "▶" : "▼"}</span>
        <span class="gname">📦 ${esc(project)} <span class="stack">compose</span></span>
        <span class="gacts">
          <button data-g="start" title="${esc(t("bulk.start"))}">▶</button>
          <button data-g="stop" title="${esc(t("bulk.stop"))}">■</button>
          <button data-g="open" title="${esc(t("ctr.stackActions"))}">⚙</button>
        </span>
        <span class="gcount">${running ? `<b>${running}</b>/` : ""}${rows.length}</span>`;
      g.onclick = async e => {
        const ga = e.target.dataset?.g;
        if (ga === "open") { e.stopPropagation(); return selectStack(project, rows); }
        if (ga) {
          e.stopPropagation();
          if (!guardRW("guard.groupAction")) return;
          const targets = ga === "start" ? rows.filter(c => c.state !== "running") : rows.filter(c => c.state === "running");
          if (!targets.length) return;
          targets.forEach(c => S.pending[c.id] = true);
          renderTree();
          const rs = await Promise.allSettled(targets.map(c => invoke("container_action", { conn: S.activeConn, id: c.id, action: ga })));
          const fails = rs.filter(r => r.status === "rejected");
          if (fails.length) toast(t("common.errors", { n: fails.length }) + ` · ${fails[0].reason}`);
          return;
        }
        S.collapsed.set(project, !collapsed);
        persist();
        renderTree();
      };
      tree.appendChild(g);
    }

    if (!collapsed) for (const c of rows) {
      const row = document.createElement("div");
      row.className = "row" + (S.selected?.id === c.id && S.view === "container" ? " sel" : "") + (project ? "" : " solo");
      const busy = S.pending[c.id];
      const h = healthOf(c);
      const dotCls = h === "unhealthy" ? "unhealthy" : c.state;
      const ports = (c.ports || "").split(",").map(s => s.trim()).filter(Boolean);
      row.innerHTML = `
        ${S.bulkMode ? `<input type="checkbox" class="cb" ${S.bulkSel.has(c.id) ? "checked" : ""}>` : ""}
        ${busy ? `<span class="spin"></span>` : `<div class="dot ${dotCls}"></div>`}
        <div class="info">
          <div class="name">${esc(project && c.service ? c.service : c.name)}${
            h === "unhealthy" ? `<span class="hb" style="color:var(--red)" title="unhealthy">⚠</span>`
            : h === "starting" ? `<span class="hb" style="color:var(--yellow)" title="health: starting">◌</span>`
            : h === "healthy" ? `<span class="hb" style="color:var(--green)" title="healthy">✓</span>` : ""}</div>
          <div class="sub">${esc(c.image)} · ${esc(c.status)}</div>
        </div>
        <div class="acts">
          ${ports.length && c.state === "running" ? `<button data-a="open" title="${esc(t("ctr.openBrowser"))} ${esc(ports[0])}">🌐</button>` : ""}
          ${c.state === "running"
            ? `<button data-a="stop" title="stop">■</button><button data-a="restart" title="restart">⟳</button>`
            : `<button data-a="start" title="start">▶</button><button data-a="rm" title="видалити" class="danger">🗑</button>`}
        </div>`;
      row.onclick = async e => {
        if (e.target.classList.contains("cb")) {
          if (e.target.checked) S.bulkSel.add(c.id); else S.bulkSel.delete(c.id);
          updateBulkBar();
          return;
        }
        const a = e.target.dataset?.a;
        if (a === "open") { e.stopPropagation(); return openContainerPort(c, ports[0]); }
        if (a) {
          if (!guardRW("guard.containerAction")) return;
          if (a === "rm" && !(await ask({ title: t("ctr.deleteQ"), text: t("ctr.deleteText", { name: esc(c.name) }), okLabel: t("common.delete") }))) return;
          return act(c, a);
        }
        selectContainer(c);
      };
      tree.appendChild(row);
    }
  }

  for (const [label, view, count] of [[t("tree.images"), "images", S.images.length], [t("tree.volumes"), "volumes", S.volumes.length], [t("tree.networks"), "networks", S.networks.length], [t("tree.disk"), "df", ""], [t("tree.journal"), "journal", ""]]) {
    const s = document.createElement("div");
    s.className = "section";
    s.innerHTML = `${label} <span class="cnt">${count}</span>`;
    if (S.view === view) s.style.color = "var(--text)";
    s.onclick = () => { S.view = view; S.selected = null; S.selectedStack = null; renderTree(); renderDetail(); };
    tree.appendChild(s);
  }

  $("count").textContent = `${t("common.containers")}: ${S.containers.length} (${t("common.running")}: ${runN}${probN ? `, ${t("common.problems")}: ${probN}` : ""}) · ${t("common.images")}: ${S.images.length}`;
  updateBulkBar();
}

async function act(c, action) {
  S.pending[c.id] = true;
  renderTree();
  try { await invoke("container_action", { conn: S.activeConn, id: c.id, action }); }
  catch (e) { delete S.pending[c.id]; renderTree(); toast("Помилка: " + e); }
}

/* ═══ B3 масові операції ═══ */
function updateBulkBar() {
  const bar = $("bulkbar");
  bar.style.display = S.bulkMode && S.bulkSel.size ? "flex" : "none";
  $("bulk-count").textContent = `${t("bulk.selected")}: ${S.bulkSel.size}`;
}
function wireBulk() {
  $("bulk-toggle").onclick = () => {
    S.bulkMode = !S.bulkMode;
    S.bulkSel.clear();
    $("bulk-toggle").classList.toggle("primary", S.bulkMode);
    renderTree();
  };
  $("bulkbar").querySelectorAll("button[data-b]").forEach(b => b.onclick = async () => {
    if (!guardRW("guard.bulkAction")) return;
    const action = b.dataset.b;
    const ids = [...S.bulkSel];
    if (action === "rm" && !(await ask({ title: t("ctr.deleteMany"), text: t("ctr.deleteManyText", { n: ids.length }), okLabel: t("common.delete") }))) return;
    ids.forEach(id => S.pending[id] = true);
    renderTree();
    const rs = await Promise.allSettled(ids.map(id => invoke("container_action", { conn: S.activeConn, id, action })));
    const fails = rs.filter(r => r.status === "rejected");
    toast(fails.length ? t("common.doneWithErrors", { fails: fails.length, total: ids.length }) : `${t("common.done")}: ${ids.length}`, fails.length ? "warn" : "ok", 4000);
    S.bulkSel.clear();
    refreshAll();
  });
}

/* ═══ роутер ═══ */
function selectContainer(c) {
  if (S.selected?.id !== c.id) S.statsFor = null;  // новий контейнер — новий стрім
  S.selected = c; S.selectedStack = null; S.view = "container";
  renderTree(); renderDetail();
}
function selectStack(project, rows) {
  S.selectedStack = { project, rows };
  S.selected = null; S.view = "stack";
  renderTree(); renderDetail();
}

const C_TABS = () => [["logs", t("tab.logs")], ["files", t("tab.files")], ["term", t("tab.term")], ["inspect", t("tab.inspect")]];
const S_TABS = () => [["stats", t("tab.overview")], ["proc", t("tab.proc")], ["files", t("tab.files")], ["term", t("tab.term")]];
const K_TABS = () => [["logs", t("tab.stackLogs")], ["compose", t("tab.compose")]];

function renderDetail() {
  const tabs = $("tabs");
  document.querySelectorAll(".pane").forEach(p => p.classList.remove("active"));
  $("welcome").style.display = "none";
  syncMonitor();

  const show = (id, fn) => { $(id).classList.add("active"); fn?.(); };

  if (S.view === "welcome") {
    $("detail-header").dataset.sig = "";
    $("detail-header").innerHTML = "";
    tabs.style.display = "none";
    $("welcome").style.display = "block";
    return;
  }

  if (S.view === "container") {
    tabs.style.display = "flex";
    renderDetailHeader();
    tabs.innerHTML = C_TABS().map(([id, l]) => `<div class="tab ${S.tab === id ? "active" : ""}" data-tab="${id}">${l}</div>`).join("");
    tabs.querySelectorAll(".tab").forEach(t => t.onclick = () => { S.tab = t.dataset.tab; renderDetail(); });
    if (S.tab === "logs") show("pane-logs", openLogs);
    if (S.tab === "files") show("pane-files", openFiles);
    if (S.tab === "term") show("pane-term", openTerm);
    if (S.tab === "inspect") show("pane-inspect", openInspect);
    return;
  }

  if (S.view === "stack") {
    tabs.style.display = "flex";
    renderDetailHeader();
    tabs.innerHTML = K_TABS().map(([id, l]) => `<div class="tab ${S.stackTab === id ? "active" : ""}" data-tab="${id}">${l}</div>`).join("");
    tabs.querySelectorAll(".tab").forEach(t => t.onclick = () => { S.stackTab = t.dataset.tab; renderDetail(); });
    if (S.stackTab === "logs") show("pane-logs", openStackLogs);
    if (S.stackTab === "compose") show("pane-compose", openComposePane);
    return;
  }

  if (S.view === "server") {
    const prof = activeProfile();
    const info = S.conns[S.activeConn]?.info;
    tabs.style.display = "flex";
    $("detail-header").innerHTML = `
      <span style="font-size:16px">🖥</span>
      <span class="title">${esc(prof.name)}</span>
      <span class="sub">${esc(prof.user)}@${esc(prof.host)}:${prof.port}${info ? " · Docker " + esc(info.version) : ""}</span>
      ${prof.readonly ? `<span class="badge" style="border-color:var(--yellow);color:var(--yellow)">🔒 read-only</span>` : ""}`;
    tabs.innerHTML = S_TABS().map(([id, l]) => `<div class="tab ${S.srvTab === id ? "active" : ""}" data-tab="${id}">${l}</div>`).join("");
    tabs.querySelectorAll(".tab").forEach(t => t.onclick = () => { S.srvTab = t.dataset.tab; renderTree(); renderDetail(); });
    if (S.srvTab === "stats") show("pane-srv-stats", openSrvStats);
    if (S.srvTab === "proc") show("pane-srv-proc", openSrvProc);
    if (S.srvTab === "files") show("pane-files", openFiles);
    if (S.srvTab === "term") show("pane-term", openTerm);
    return;
  }

  tabs.style.display = "none";
  const hdr = { images: t("tree.images"), volumes: t("tree.volumes"), networks: t("tree.networks"), df: t("df.title"), dash: t("pal.dashboard"), journal: t("tree.journal") };
  $("detail-header").dataset.sig = "";
  $("detail-header").innerHTML = `<span class="title">${hdr[S.view] ?? ""}</span>`;
  if (S.view === "images") show("pane-images", renderImages);
  if (S.view === "volumes") show("pane-volumes", renderVolumes);
  if (S.view === "networks") show("pane-networks", renderNetworks);
  if (S.view === "df") show("pane-df", openDf);
  if (S.view === "dash") show("pane-dash", openDash);
  if (S.view === "journal") show("pane-journal", openJournal);
}

/* підпис шапки: перемальовуємо лише коли реально щось змінилось,
   інакше бейдж зі статистикою блимав би на кожну подію Docker */
function headerSig() {
  if (S.view === "stack" && S.selectedStack) {
    const st = S.selectedStack;
    return "stack|" + st.project + "|" + st.rows.map(r => r.id + r.state).join(",");
  }
  const c = S.selected;
  if (!c) return "";
  return ["ctr", c.id, c.state, c.status, c.name, c.ports].join("|");
}

function renderDetailHeader(force) {
  const h = $("detail-header");
  const sig = headerSig();
  if (!force && sig && h.dataset.sig === sig) {
    // стан не змінився — оновлювати DOM не треба
    ensureStats();
    return;
  }
  h.dataset.sig = sig;

  if (S.view === "stack" && S.selectedStack) {
    const st = S.selectedStack;
    const run = st.rows.filter(c => c.state === "running").length;
    h.innerHTML = `
      <span style="font-size:15px">📦</span>
      <span class="title">${esc(st.project)}</span>
      <span class="sub">${t("ctr.stackRunning", { run, total: st.rows.length })} · ${st.rows.map(r => esc(r.service || r.name)).join(", ").slice(0, 90)}</span>
      <span style="flex:1"></span>
      <button data-s="start">${t("ctr.startAll")}</button><button data-s="stop">${t("ctr.stopAll")}</button><button data-s="restart">${t("ctr.restartAll")}</button>`;
    h.querySelectorAll("button").forEach(b => b.onclick = async () => {
      if (!guardRW("guard.groupAction")) return;
      const a = b.dataset.s;
      const targets = a === "start" ? st.rows.filter(c => c.state !== "running")
        : a === "stop" ? st.rows.filter(c => c.state === "running") : st.rows;
      targets.forEach(c => S.pending[c.id] = true);
      renderTree();
      await Promise.allSettled(targets.map(c => invoke("container_action", { conn: S.activeConn, id: c.id, action: a })));
    });
    return;
  }

  const c = S.selected;
  if (!c || S.view !== "container") return;
  const ports = (c.ports || "").split(",").map(s => s.trim()).filter(Boolean);
  const cached = S.ctrStats[c.id];
  h.innerHTML = `
    <div class="dot ${healthOf(c) === "unhealthy" ? "unhealthy" : c.state}"></div>
    <span class="title">${esc(c.name)}</span>
    <span class="sub">${esc(c.image)} · ${esc(c.status)}</span>
    <span class="badge stats" id="livestats" style="${c.state === "running" ? "" : "display:none"}">${
      c.state === "running" ? (cached ? statsHtml(cached) : "CPU <b>…</b> · RAM <b>…</b>") : ""}</span>
    <span style="flex:1"></span>
    ${ports.length && c.state === "running" ? `<button data-a="open" title="${esc(t("ctr.openBrowser"))}">🌐 ${esc(ports[0])}</button>` : ""}
    ${c.state === "running"
      ? `<button data-a="stop">${t("ctr.stop")}</button><button data-a="restart">${t("ctr.restart")}</button><button data-a="pause">⏸</button>`
      : c.state === "paused"
      ? `<button data-a="unpause">${t("ctr.unpause")}</button>`
      : `<button data-a="start" class="primary">${t("ctr.start")}</button>`}
    <button data-a="rm" class="danger">🗑</button>`;
  h.querySelectorAll("button").forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    if (a === "open") return openContainerPort(c, ports[0]);
    if (!guardRW("guard.containerAction")) return;
    if (a === "rm" && !(await ask({ title: t("ctr.deleteQ"), text: t("ctr.deleteText", { name: esc(c.name) }), okLabel: t("common.delete") }))) return;
    act(c, a);
    if (a === "rm") { S.view = "welcome"; S.selected = null; renderDetail(); }
  });
  ensureStats();
}

/* стрім статистики піднімаємо один раз на контейнер, а не на кожну перемальовку */
function ensureStats() {
  const c = S.selected;
  if (!c || S.view !== "container" || c.state !== "running") return;
  if (S.statsFor === c.id) return;
  S.statsFor = c.id;
  invoke("start_stats", { conn: S.activeConn, id: c.id }).catch(() => { S.statsFor = null; });
}

/* ═══ A4 командна палітра ═══ */
let palItems = [], palIdx = 0;

function buildPalette(q) {
  const ql = q.toLowerCase().trim();
  const items = [];
  const add = (ico, title, sub, run) => items.push({ ico, title, sub, run });

  for (const c of S.containers) {
    add(c.state === "running" ? "🟢" : "⚪", c.name, c.project ? t("pal.container") + " · " + c.project : t("pal.container"),
      () => selectContainer(c));
  }
  const projects = [...new Set(S.containers.filter(c => c.project).map(c => c.project))];
  for (const p of projects) {
    add("📦", p, t("pal.stack"), () => selectStack(p, S.containers.filter(c => c.project === p)));
  }
  for (const p of S.profiles) {
    add("🖥", p.name, S.conns[p.id]?.up ? t("pal.connActive") : t("pal.connClick"),
      () => S.conns[p.id]?.up ? switchConn(p.id) : connectProfile(p.id));
  }
  const nav = [
    ["📊", t("tree.stats"), () => { S.view = "server"; S.srvTab = "stats"; }],
    ["⚙️", t("tree.proc"), () => { S.view = "server"; S.srvTab = "proc"; }],
    ["📁", t("tree.hostFiles"), () => { S.view = "server"; S.srvTab = "files"; }],
    ["⌨️", t("tree.hostTerm"), () => { S.view = "server"; S.srvTab = "term"; }],
    ["🗂", t("pal.dashboard"), () => { S.view = "dash"; }],
    ["💽", t("pal.diskUsage"), () => { S.view = "df"; }],
    ["🖼", t("tree.images"), () => { S.view = "images"; }],
    ["🗄", t("tree.volumes"), () => { S.view = "volumes"; }],
    ["🌐", t("tree.networks"), () => { S.view = "networks"; }],
  ];
  for (const [ico, title, fn] of nav) {
    add(ico, title, t("pal.nav"), () => { S.selected = null; S.selectedStack = null; fn(); renderTree(); renderDetail(); });
  }
  add("🔨", t("pal.buildImage"), t("pal.action"), () => { S.view = "images"; renderTree(); renderDetail(); $("build-btn").click(); });
  add("＋", t("pal.newContainer"), t("pal.action"), () => { S.view = "images"; renderTree(); renderDetail(); $("create-btn").click(); });
  add("🔌", t("pal.closeTunnels"), t("pal.action"), stopAllForwards);
  add("🌓", t("pal.toggleTheme"), t("pal.action"), () => setTheme(S.theme === "dark" ? "light" : "dark"));
  add("⟳", t("pal.refreshAll"), t("pal.action"), refreshAll);

  const scored = items
    .map(it => {
      const t = it.title.toLowerCase();
      if (!ql) return { it, s: 0 };
      if (t.startsWith(ql)) return { it, s: 3 };
      if (t.includes(ql)) return { it, s: 2 };
      if (it.sub.toLowerCase().includes(ql)) return { it, s: 1 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map(x => x.it);
  return scored;
}

function renderPalette() {
  const box = $("palette-list");
  box.innerHTML = palItems.map((it, i) =>
    `<div class="pal-item ${i === palIdx ? "on" : ""}" data-i="${i}">
      <span class="pi-ico">${it.ico}</span><span>${esc(it.title)}</span><span class="pi-sub">${esc(it.sub)}</span>
    </div>`).join("") || `<div class="placeholder">${t("pal.nothing")}</div>`;
  box.querySelectorAll(".pal-item").forEach(el => el.onclick = () => runPalette(+el.dataset.i));
  box.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
}

function runPalette(i) {
  const it = palItems[i];
  $("palette-modal").classList.remove("open");
  if (it) setTimeout(() => it.run(), 10);
}

function openPalette() {
  $("palette-input").value = "";
  palItems = buildPalette("");
  palIdx = 0;
  renderPalette();
  $("palette-modal").classList.add("open");
  setTimeout(() => $("palette-input").focus(), 50);
}

function wirePalette() {
  $("palette-btn").onclick = openPalette;
  $("palette-input").oninput = e => { palItems = buildPalette(e.target.value); palIdx = 0; renderPalette(); };
  $("palette-input").onkeydown = e => {
    if (e.key === "ArrowDown") { palIdx = Math.min(palItems.length - 1, palIdx + 1); renderPalette(); e.preventDefault(); }
    if (e.key === "ArrowUp") { palIdx = Math.max(0, palIdx - 1); renderPalette(); e.preventDefault(); }
    if (e.key === "Enter") runPalette(palIdx);
    if (e.key === "Escape") $("palette-modal").classList.remove("open");
  };
}

/* ═══ події докера ═══ */
let refreshTimer = null;
const wasRunning = {};
listen("docker-event", ev => {
  const p = ev.payload;
  if (p.conn !== S.activeConn) return;
  const light = $("eventlight");
  light.classList.add("on");
  setTimeout(() => light.classList.remove("on"), 300);
  $("lastevent").textContent = `${t("events.one")}: ${p.action ?? "?"}`;
  if (p.id && ["start", "die", "stop", "destroy", "pause", "unpause"].includes(p.action)) delete S.pending[p.id];

  // C4 — алерт про несподіване падіння
  if (p.action === "die" && p.id) {
    const c = S.containers.find(x => x.id === p.id);
    if (c && wasRunning[p.id]) {
      toast(t("ctr.unexpectedStop", { name: c.name }), "warn", 8000);
      tgAlert(`⚠ <b>${activeProfile()?.name ?? ""}</b>\n${t("ctr.unexpectedStop", { name: c.name })}`);
    }
  }
  if (p.action === "start" && p.id) wasRunning[p.id] = true;

  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, 200);
  if (p.id === S.selected?.id) {
    if (p.action === "start") { S.statsFor = null; ensureStats(); }
    if (p.action === "die") {
      S.statsFor = null;
      delete S.ctrStats[p.id];
      const el = $("livestats");
      if (el) el.style.display = "none";
    }
  }
});

listen("conn-state", ev => {
  const p = ev.payload;
  if (!p.up && S.conns[p.conn]?.up) markDown(p.conn, t("conn.eventsLostShort"));
});

/* ═══ глобальні хоткеї ═══ */
/** Закрити модалку правильно: редактор питає про незбережені зміни. */
function closeModal(el) {
  if (!el) return;
  if (el.id === "editor-modal") closeEditor();
  else el.classList.remove("open");
}

function wireGlobal() {
  document.querySelectorAll("[data-close]").forEach(el =>
    el.addEventListener("click", () => closeModal($(el.dataset.close))));

  // клік по затемненню поза вікном закриває модалку
  document.querySelectorAll(".modal-back").forEach(back => {
    back.addEventListener("mousedown", e => { back._downOnBack = e.target === back; });
    back.addEventListener("click", e => {
      // тільки якщо і натиснули, і відпустили саме на тлі (щоб не закривалось при виділенні тексту)
      if (e.target === back && back._downOnBack) closeModal(back);
      back._downOnBack = false;
    });
  });

  $("filter").oninput = renderTree;
  $("refresh").onclick = refreshAll;
  $("theme-btn").onclick = () => setTheme(S.theme === "dark" ? "light" : "dark");
  $("lang-btn").onclick = () => {
    const order = ["uk", "ru", "en"];
    setLang(order[(order.indexOf(LANG) + 1) % order.length]);
    toast(t("lang.name"), "ok", 1500);
  };
  $("fwd-badge").onclick = stopAllForwards;
  $("quick-filter").querySelectorAll("button").forEach(b => b.onclick = () => {
    S.quick = b.dataset.q;
    $("quick-filter").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    persist();
    renderTree();
  });

  document.addEventListener("keydown", e => {
    // e.target може бути document (синтетичні події) — у нього немає closest()
    const el = e.target instanceof Element ? e.target : null;
    const typing = !!el && (/INPUT|TEXTAREA/.test(el.tagName) || el.closest(".xterm") || el.closest(".CodeMirror"));
    if (e.ctrlKey && e.code === "KeyK") { e.preventDefault(); openPalette(); return; }
    if (e.key === "Escape") {
      const open = [...document.querySelectorAll(".modal-back.open")];
      if (open.length) { closeModal(open[open.length - 1]); return; }   // закриваємо верхню
      return;
    }
    if (e.key === "/" && !typing) { e.preventDefault(); $("filter").focus(); $("filter").select(); }
    if (e.key === "r" && e.ctrlKey && !typing) { e.preventDefault(); refreshAll(); }
  });
}

/* ═══ старт ═══ */
(async () => {
  const lastConn = restore();
  wireGlobal(); wireConnUI(); wireLogsUI(); wireFilesUI(); wireEditorUI();
  wireTermUI(); wireServerUI(); wireResourcesUI(); wirePalette(); wireBulk(); wireExtras();

  applyI18n();
  $("lang-btn").textContent = LANG.toUpperCase();
  $("quick-filter").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.q === S.quick));
  $("log-wrap").classList.toggle("primary", !S.logWrap);

  await loadProfiles();
  fillProfileForm(null);
  $("perf").innerHTML = `UI: <b>${Math.round(performance.now())} мс</b>`;

  // відновлюємо всі зʼєднання, які були увімкнені (autoconnect)
  const restored = await restoreConnections();
  // перше знайомство: якщо прапорців ще немає — піднімаємо локальний демон
  if (!S.profiles.some(p => p.autoconnect)) await connectProfile("local");

  const target = [lastConn, ...restored, "local"].find(id => S.conns[id]?.up);
  if (target) switchConn(target);
  const info = S.conns[S.activeConn]?.info;
  if (info) $("perf").innerHTML = `старт+конект: <b>${info.startup_ms} мс</b> · UI: <b>${Math.round(performance.now())} мс</b>`;

  refreshForwards();
  setInterval(() => { if (document.visibilityState === "visible") refreshAll(); }, 30000);
})();
