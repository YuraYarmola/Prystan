"use strict";
/* Дерево, роутер вкладок, командна палітра, масові операції, старт */

/* ═══ дані ═══ */

/** Перемалювати вміст відкритої панелі після оновлення даних. */
function repaintView() {
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
}

function connLost(e) {
  const msg = String(e);
  // помилка транспорту = зʼєднання впало; підіймемо його, якщо воно «бажане»
  if (/connect|transport|broken pipe|refused|closed|немає активного/i.test(msg)) {
    markDown(S.activeConn, t("conn.lost"));
    return true;
  }
  return false;
}

let refreshSeq = 0;

async function refreshAll(opts = {}) {
  if (!S.activeConn || !S.conns[S.activeConn]?.up) { renderTree(); return; }
  const conn = S.activeConn;
  const seq = ++refreshSeq;
  if (!opts.quiet) setBusy(true);
  try {
    const [c, i, v, n] = await Promise.all([
      invoke("list_containers", { conn }),
      invoke("list_images", { conn }),
      invoke("list_volumes", { conn }),
      invoke("list_networks", { conn }),
    ]);
    // поки чекали, користувач міг перемкнути сервер — старі дані не показуємо
    if (seq !== refreshSeq || conn !== S.activeConn) return;
    S.containers = c; S.images = i; S.volumes = v; S.networks = n;
    S.loading = false;
    clearSettledPending();
    renderTree();
    repaintView();
  } catch (e) {
    if (seq !== refreshSeq || conn !== S.activeConn) return;
    S.loading = false;
    if (!connLost(e)) toast("Оновлення: " + e);
    renderTree();
  } finally {
    if (seq === refreshSeq) setBusy(false);
  }
}

/* Легке оновлення лише списку контейнерів: дешевше за повний refreshAll,
   тому ним можна опитувати часто й стани змінюються майже миттєво. */
async function refreshContainers() {
  if (!S.activeConn || !S.conns[S.activeConn]?.up) return;
  const conn = S.activeConn;
  try {
    const list = await invoke("list_containers", { conn });
    if (conn !== S.activeConn) return;
    const changed = containersSig(list) !== containersSig(S.containers);
    S.containers = list;
    clearSettledPending();
    if (changed) { renderTree(); repaintView(); }
    else if (Object.keys(S.pending).length) renderTree();
  } catch (e) { connLost(e); }
}

const containersSig = list => list.map(c => c.id + c.state + c.status).join("|");

/** Періоди опитування живуть у налаштуваннях — переставляємо таймери на льоту. */
let pollFastT = null, pollFullT = null;
function armPolling() {
  clearInterval(pollFastT);
  clearInterval(pollFullT);
  const vis = () => document.visibilityState === "visible";
  if (S.cfg.pollFast) pollFastT = setInterval(() => vis() && refreshContainers(), S.cfg.pollFast * 1000);
  if (S.cfg.pollFull) pollFullT = setInterval(() => vis() && refreshAll({ quiet: true }), S.cfg.pollFull * 1000);
}

/** Дебаунс: після дії дані оновлюємо самі, не чекаючи події Docker. */
let softTimer = null;
function scheduleRefresh(delay = 150) {
  clearTimeout(softTimer);
  softTimer = setTimeout(() => refreshAll({ quiet: true }), delay);
}

/* ═══ очікування дії ═══
   Позначка тримає спінер на рядку, поки контейнер не змінить стан. */
const pendingSince = {};

function markPending(c) {
  S.pending[c.id] = c.state || "?";
  pendingSince[c.id] = Date.now();
  pumpPending();
}

function clearSettledPending() {
  for (const c of S.containers) {
    if (S.pending[c.id] && S.pending[c.id] !== c.state) {
      delete S.pending[c.id];
      delete pendingSince[c.id];
    }
  }
  // контейнер могли видалити — його вже немає у списку
  for (const id of Object.keys(S.pending)) {
    if (!S.containers.some(c => c.id === id)) { delete S.pending[id]; delete pendingSince[id]; }
  }
}

let pendingTimer = null;
function pumpPending() {
  if (pendingTimer) return;
  pendingTimer = setInterval(async () => {
    // прострочені позначки знімаємо, інакше спінер крутився б вічно
    for (const [id, ts] of Object.entries(pendingSince)) {
      if (Date.now() - ts > 20000) { delete S.pending[id]; delete pendingSince[id]; }
    }
    if (!Object.keys(S.pending).length) {
      clearInterval(pendingTimer);
      pendingTimer = null;
      renderTree();
      return;
    }
    await refreshContainers();
  }, 800);
}

/* ═══ health / фільтри ═══ */
function healthOf(c) {
  const s = (c.status || "").toLowerCase();
  if (s.includes("unhealthy")) return "unhealthy";
  if (s.includes("health: starting")) return "starting";
  if (s.includes("healthy")) return "healthy";
  return null;
}
/** Класи індикатора: пульсує лише те, що справді працює. */
function dotClass(c) {
  const h = healthOf(c);
  if (c.state === "running" && h) return `running hb-${h}`;
  return c.state;
}
function healthTitle(c) {
  const h = healthOf(c);
  return h ? `${c.state} · health: ${h}` : c.state;
}

function isProblem(c) {
  if (healthOf(c) === "unhealthy") return true;
  if (c.state === "restarting" || c.state === "dead") return true;
  const m = (c.status || "").match(/Exited \((\d+)\)/);
  return !!m && m[1] !== "0";
}
/* Шукаємо не лише за назвою: «8080» має знаходити того, хто зайняв порт,
   а «exited» — усе, що впало. Це найчастіші питання до списку. */
function matchesFilter(c, f) {
  if (!f) return true;
  return [c.name, c.image, c.project, c.service, c.ports, c.status, c.state, c.id.slice(0, 12)]
    .some(v => (v || "").toLowerCase().includes(f));
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
  renderProjectBox();
  const f = $("filter").value.toLowerCase();
  const tree = $("tree");
  tree.innerHTML = "";
  const prof = activeProfile();
  const up = S.conns[S.activeConn]?.up;

  // дашборд доступний завжди
  const dash = document.createElement("div");
  dash.className = "section";
  dash.innerHTML = `${ic("grid")} ${t("tree.dashboard")}`;
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
    for (const [tab, icon, label] of [
      ["stats", "activity", t("tree.stats")],
      ["proc", "cpu", t("tree.proc")],
      ["files", "folder", t("tree.hostFiles")],
      ["du", "pieChart", t("du.title")],
      ["term", "terminal", t("tree.hostTerm")],
    ]) {
      const b = document.createElement("button");
      b.className = S.view === "server" && S.srvTab === tab ? "sel" : "";
      b.title = label;
      b.innerHTML = ic(icon, "big");
      b.onclick = () => { S.view = "server"; S.srvTab = tab; S.selected = null; S.selectedStack = null; renderTree(); renderDetail(); };
      row.appendChild(b);
    }
    tree.appendChild(row);
  }

  const secC = document.createElement("div");
  secC.className = "section";
  const runN = S.containers.filter(c => c.state === "running").length;
  const probN = S.containers.filter(isProblem).length;
  secC.innerHTML = `${t("tree.containers")} <span class="cnt">${
    probN ? `<span style="color:var(--red)">${ic("alert", "sm")} ${probN}</span> · ` : ""}${runN}/${S.containers.length}</span>`;
  tree.appendChild(secC);

  // перше завантаження після підключення — показуємо, що дані вже їдуть
  if (S.loading && !S.containers.length) {
    tree.insertAdjacentHTML("beforeend", skeleton(8));
    $("count").textContent = t("common.loading");
    return;
  }

  const shown = S.containers.filter(c => passQuick(c) && matchesFilter(c, f));
  S.treeItems = [];

  for (const [project, rows] of groupContainers(shown)) {
    const running = rows.filter(c => c.state === "running").length;
    const collapsed = project && !f && S.quick === "all" ? isCollapsed(project, rows) : false;

    if (project) {
      const g = document.createElement("div");
      g.className = "group" + (S.view === "stack" && S.selectedStack?.project === project ? " sel" : "");
      g.innerHTML = `
        <span class="tri">${ic(collapsed ? "chevronRight" : "chevronDown", "sm")}</span>
        <span class="gname">${ic("layers")} ${esc(project)} <span class="stack">compose</span></span>
        <span class="gacts">
          <button data-g="start" title="${esc(t("bulk.start"))}">${ic("play")}</button>
          <button data-g="stop" title="${esc(t("bulk.stop"))}">${ic("stop")}</button>
          <button data-g="open" title="${esc(t("ctr.stackActions"))}">${ic("settings")}</button>
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
          targets.forEach(markPending);
          renderTree();
          const rs = await Promise.allSettled(targets.map(c => invoke("container_action", { conn: S.activeConn, id: c.id, action: ga })));
          const fails = rs.filter(r => r.status === "rejected");
          if (fails.length) toast(t("common.errors", { n: fails.length }) + ` · ${fails[0].reason}`);
          scheduleRefresh();
          return;
        }
        S.collapsed.set(project, !collapsed);
        persist();
        renderTree();
      };
      g.oncontextmenu = e => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, stackMenuItems(project, rows));
      };
      tree.appendChild(g);
      S.treeItems.push({ el: g, kind: "group", project, rows, collapsed });
    }

    if (!collapsed) for (const c of rows) {
      const row = document.createElement("div");
      row.className = "row" + (S.selected?.id === c.id && S.view === "container" ? " sel" : "") + (project ? "" : " solo");
      const busy = S.pending[c.id];
      const h = healthOf(c);
      const ports = portsOf(c);
      const loops = S.crashing[S.activeConn + ":" + c.id];
      row.innerHTML = `
        ${S.bulkMode ? `<input type="checkbox" class="cb" ${S.bulkSel.has(c.id) ? "checked" : ""}>` : ""}
        ${busy ? `<span class="spin"></span>` : `<div class="dot ${dotClass(c)}" title="${esc(healthTitle(c))}"></div>`}
        <div class="info">
          <div class="name">${esc(project && c.service ? c.service : c.name)}${
            h === "unhealthy" ? `<span class="hb" style="color:var(--yellow)" title="unhealthy">${ic("alert", "sm")}</span>`
            : h === "starting" ? `<span class="hb" style="color:var(--yellow)" title="health: starting">${ic("loader", "sm")}</span>`
            : h === "healthy" ? `<span class="hb" style="color:var(--green)" title="healthy">${ic("check", "sm")}</span>` : ""}${
            loops ? `<span class="loopbadge" title="${esc(t("ctr.crashLoop", { name: c.name, n: loops }))}">${ic("rotate", "sm")}${loops}</span>` : ""}</div>
          <div class="sub">${esc(c.image)} · ${esc(c.status)}</div>
        </div>
        <div class="acts">
          ${ports.length && c.state === "running" ? `<button data-a="open" title="${esc(t("ctr.openBrowser"))} ${esc(ports[0])}">${ic("globe")}</button>` : ""}
          ${c.state === "running"
            ? `<button data-a="stop" title="stop">${ic("stop")}</button><button data-a="restart" title="restart">${ic("rotate")}</button>`
            : `<button data-a="start" title="start">${ic("play")}</button><button data-a="rm" title="${esc(t("common.delete"))}" class="danger">${ic("trash")}</button>`}
        </div>`;
      row.onclick = async e => {
        if (e.target.classList.contains("cb")) {
          if (e.target.checked) S.bulkSel.add(c.id); else S.bulkSel.delete(c.id);
          updateBulkBar();
          return;
        }
        const a = e.target.closest("[data-a]")?.dataset?.a;
        if (a === "open") {
          e.stopPropagation();
          if (ports.length === 1) return openContainerPort(c, ports[0]);
          return showContextMenu(e.clientX, e.clientY, ports.map(p => ({
            icon: "globe", label: p, run: () => openContainerPort(c, p),
          })));
        }
        if (a) {
          if (!guardRW("guard.containerAction")) return;
          if (a === "rm" && !(await confirmDanger(t("ctr.deleteQ"), t("ctr.deleteText", { name: esc(c.name) })))) return;
          return act(c, a);
        }
        selectContainer(c);
      };
      row.oncontextmenu = e => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, containerMenuItems(c));
      };
      tree.appendChild(row);
      S.treeItems.push({ el: row, kind: "row", c });
    }
  }

  applyCursor();

  for (const [label, view, count, icon] of [
    [t("top.title"), "top", "", "activity"],
    [t("tree.images"), "images", S.images.length, "image"],
    [t("tree.volumes"), "volumes", S.volumes.length, "database"],
    [t("tree.networks"), "networks", S.networks.length, "network"],
    [t("tree.disk"), "df", "", "hardDrive"],
    [t("tree.journal"), "journal", "", "history"],
  ]) {
    const s = document.createElement("div");
    s.className = "section";
    s.innerHTML = `${ic(icon)} ${label} <span class="cnt">${count}</span>`;
    if (S.view === view) s.style.color = "var(--text)";
    s.onclick = () => { S.view = view; S.selected = null; S.selectedStack = null; renderTree(); renderDetail(); };
    tree.appendChild(s);
  }

  $("count").textContent = `${t("common.containers")}: ${S.containers.length} (${t("common.running")}: ${runN}${probN ? `, ${t("common.problems")}: ${probN}` : ""}) · ${t("common.images")}: ${S.images.length}`;
  updateBulkBar();
}

/* ═══ контекстні меню дерева ═══
   Правий клік на контейнері раніше не робив нічого, хоча у файлах і консолі
   меню було — руки самі туди тягнуться. */

function portsOf(c) {
  return (c.ports || "").split(",").map(s => s.trim()).filter(Boolean);
}

function containerMenuItems(c) {
  const run = c.state === "running";
  const ro = isReadonly();
  const ports = portsOf(c);
  const open = tab => { selectContainer(c); S.tab = tab; renderDetail(); };
  const items = [
    { icon: "list", label: t("tab.logs"), run: () => open("logs") },
    { icon: "terminal", label: t("tab.term"), disabled: !run, run: () => open("term") },
    { icon: "folder", label: t("tab.files"), run: () => open("files") },
    { icon: "info", label: t("tab.inspect"), run: () => open("inspect") },
  ];
  if (ports.length && run) {
    items.push("-");
    // раніше кнопка вміла лише перший порт — решта була недосяжна
    for (const p of ports) {
      items.push({ icon: "globe", label: t("ctr.openBrowser") + " " + p, run: () => openContainerPort(c, p) });
    }
  }
  items.push("-");
  if (run) {
    items.push({ icon: "stop", label: t("ctr.stop"), disabled: ro, run: () => act(c, "stop") });
    items.push({ icon: "rotate", label: t("ctr.restart"), disabled: ro, run: () => act(c, "restart") });
    items.push({ icon: "pause", label: t("ctr.pause"), disabled: ro, run: () => act(c, "pause") });
  } else if (c.state === "paused") {
    items.push({ icon: "play", label: t("ctr.unpause"), disabled: ro, run: () => act(c, "unpause") });
  } else {
    items.push({ icon: "play", label: t("ctr.start"), disabled: ro, run: () => act(c, "start") });
  }
  items.push("-");
  items.push({ icon: "copy", label: t("ctx.copyName"), run: () => copyText(c.name) });
  items.push({ icon: "link", label: t("ctx.copyId"), run: () => copyText(c.id) });
  items.push({
    icon: "trash", label: t("files.delete"), danger: true, disabled: ro,
    run: async () => {
      if (!(await confirmDanger(t("ctr.deleteQ"), t("ctr.deleteText", { name: esc(c.name) })))) return;
      act(c, "rm");
    },
  });
  return items;
}

function stackMenuItems(project, rows) {
  const ro = isReadonly();
  const bulk = async a => {
    if (!guardRW("guard.groupAction")) return;
    const targets = a === "start" ? rows.filter(c => c.state !== "running")
      : a === "stop" ? rows.filter(c => c.state === "running") : rows;
    targets.forEach(markPending);
    renderTree();
    await Promise.allSettled(targets.map(c => invoke("container_action", { conn: S.activeConn, id: c.id, action: a })));
    scheduleRefresh();
  };
  return [
    { icon: "layers", label: t("ctr.stackActions"), run: () => selectStack(project, rows) },
    { icon: "list", label: t("tab.stackLogs"), run: () => { selectStack(project, rows); S.stackTab = "logs"; renderDetail(); } },
    "-",
    { icon: "play", label: t("ctr.startAll"), disabled: ro, run: () => bulk("start") },
    { icon: "stop", label: t("ctr.stopAll"), disabled: ro, run: () => bulk("stop") },
    { icon: "rotate", label: t("ctr.restartAll"), disabled: ro, run: () => bulk("restart") },
    "-",
    { icon: "copy", label: t("ctx.copyName"), run: () => copyText(project) },
  ];
}

/** Підтвердження небезпечної дії; у налаштуваннях його можна вимкнути. */
async function confirmDanger(title, text) {
  if (!S.cfg.confirmDestructive) return true;
  return !!(await ask({ title, text, okLabel: t("common.delete") }));
}

/* ═══ навігація деревом з клавіатури ═══ */
function applyCursor() {
  const items = S.treeItems;
  if (S.cursor >= items.length) S.cursor = items.length - 1;
  items.forEach((it, i) => it.el.classList.toggle("cursor", i === S.cursor));
}

function moveCursor(delta) {
  const items = S.treeItems;
  if (!items.length) return;
  if (S.cursor < 0) {
    // починаємо з поточного вибраного, а не завжди згори
    S.cursor = items.findIndex(it => it.kind === "row" && it.c.id === S.selected?.id);
    if (S.cursor < 0) S.cursor = 0;
  } else {
    S.cursor = Math.max(0, Math.min(items.length - 1, S.cursor + delta));
  }
  applyCursor();
  S.treeItems[S.cursor]?.el.scrollIntoView({ block: "nearest" });
}

function cursorItem() {
  return S.cursor >= 0 ? S.treeItems[S.cursor] : null;
}

function wireTreeKeys() {
  document.addEventListener("keydown", e => {
    if (document.querySelector(".modal-back.open")) return;
    const el = e.target instanceof Element ? e.target : null;
    const typing = !!el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.closest(".xterm") || el.closest(".CodeMirror"));
    // зі списку фільтра стрілками теж хочеться потрапити в дерево
    const fromFilter = el?.id === "filter";
    if (typing && !(fromFilter && ["ArrowDown", "ArrowUp", "Enter"].includes(e.key))) return;

    const it = cursorItem();
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveCursor(1); break;
      case "ArrowUp": e.preventDefault(); moveCursor(-1); break;
      case "Enter":
        if (!it) return;
        e.preventDefault();
        if (it.kind === "row") selectContainer(it.c);
        else selectStack(it.project, it.rows);
        break;
      case "ArrowRight":
        if (it?.kind === "group" && it.collapsed) { e.preventDefault(); S.collapsed.set(it.project, false); persist(); renderTree(); }
        break;
      case "ArrowLeft":
        if (it?.kind === "group" && !it.collapsed) { e.preventDefault(); S.collapsed.set(it.project, true); persist(); renderTree(); }
        break;
      case " ":
        if (it?.kind === "row" && S.bulkMode) {
          e.preventDefault();
          if (S.bulkSel.has(it.c.id)) S.bulkSel.delete(it.c.id); else S.bulkSel.add(it.c.id);
          renderTree();
        }
        break;
      case "Delete":
        if (it?.kind === "row" && !isReadonly()) {
          e.preventDefault();
          confirmDanger(t("ctr.deleteQ"), t("ctr.deleteText", { name: esc(it.c.name) }))
            .then(ok => ok && act(it.c, "rm"));
        }
        break;
    }
  });
}

async function act(c, action) {
  markPending(c);
  renderTree();
  try {
    await invoke("container_action", { conn: S.activeConn, id: c.id, action });
    // не покладаємось лише на подію Docker: вона може не дійти через тунель
    scheduleRefresh();
  } catch (e) {
    delete S.pending[c.id];
    renderTree();
    toast("Помилка: " + e);
  }
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
    ids.forEach(id => {
      const c = S.containers.find(x => x.id === id);
      if (c) markPending(c);
    });
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
const S_TABS = () => [["stats", t("tab.overview")], ["proc", t("tab.proc")], ["files", t("tab.files")], ["du", t("du.title")], ["term", t("tab.term")]];
const K_TABS = () => [["logs", t("tab.stackLogs")], ["compose", t("tab.compose")]];
const P_TABS = () => [["files", t("tab.files")], ["term", t("tab.term")], ["compose", t("tab.compose")], ["du", t("du.title")]];

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
    renderWelcome();
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
    $("detail-header").dataset.sig = "";
    $("detail-header").innerHTML = `
      ${ic("server", "big")}
      <span class="title">${esc(prof.name)}</span>
      <span class="sub">${esc(prof.user)}@${esc(prof.host)}:${prof.port}${info ? " · Docker " + esc(info.version) : ""}</span>
      ${prof.readonly ? `<span class="badge ro">${ic("lock")} read-only</span>` : ""}`;
    tabs.innerHTML = S_TABS().map(([id, l]) => `<div class="tab ${S.srvTab === id ? "active" : ""}" data-tab="${id}">${l}</div>`).join("");
    tabs.querySelectorAll(".tab").forEach(t => t.onclick = () => { S.srvTab = t.dataset.tab; renderTree(); renderDetail(); });
    if (S.srvTab === "stats") show("pane-srv-stats", openSrvStats);
    if (S.srvTab === "proc") show("pane-srv-proc", openSrvProc);
    if (S.srvTab === "files") show("pane-files", openFiles);
    if (S.srvTab === "du") show("pane-du", openDu);
    if (S.srvTab === "term") show("pane-term", openTerm);
    return;
  }

  if (S.view === "project") {
    const p = S.project;
    tabs.style.display = "flex";
    renderProjectHeader();
    tabs.innerHTML = P_TABS().map(([id, l]) => `<div class="tab ${S.projTab === id ? "active" : ""}" data-tab="${id}">${l}</div>`).join("");
    tabs.querySelectorAll(".tab").forEach(t => t.onclick = () => { S.projTab = t.dataset.tab; renderDetail(); });
    if (S.projTab === "files") show("pane-files", openFiles);
    if (S.projTab === "term") show("pane-term", openTerm);
    if (S.projTab === "compose") show("pane-compose", openProjectCompose);
    if (S.projTab === "du") show("pane-du", openDu);
    return;
  }

  tabs.style.display = "none";
  const hdr = { images: t("tree.images"), volumes: t("tree.volumes"), networks: t("tree.networks"), df: t("df.title"), dash: t("pal.dashboard"), journal: t("tree.journal"), top: t("top.title") };
  $("detail-header").dataset.sig = "";
  $("detail-header").innerHTML = `<span class="title">${hdr[S.view] ?? ""}</span>`;
  if (S.view === "top") show("pane-top", openTop);
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
      ${ic("layers", "big")}
      <span class="title">${esc(st.project)}</span>
      <span class="sub">${t("ctr.stackRunning", { run, total: st.rows.length })} · ${st.rows.map(r => esc(r.service || r.name)).join(", ").slice(0, 90)}</span>
      <span style="flex:1"></span>
      <button data-s="start" title="${esc(t("bulk.start"))}">${ic("play")} ${t("ctr.startAll")}</button>
      <button data-s="stop" title="${esc(t("bulk.stop"))}">${ic("stop")} ${t("ctr.stopAll")}</button>
      <button data-s="restart" title="${esc(t("bulk.restart"))}">${ic("rotate")} ${t("ctr.restartAll")}</button>`;
    h.querySelectorAll("button").forEach(b => b.onclick = async () => {
      if (!guardRW("guard.groupAction")) return;
      const a = b.dataset.s;
      const targets = a === "start" ? st.rows.filter(c => c.state !== "running")
        : a === "stop" ? st.rows.filter(c => c.state === "running") : st.rows;
      targets.forEach(markPending);
      renderTree();
      await Promise.allSettled(targets.map(c => invoke("container_action", { conn: S.activeConn, id: c.id, action: a })));
      scheduleRefresh();
    });
    return;
  }

  const c = S.selected;
  if (!c || S.view !== "container") return;
  const ports = portsOf(c);
  const cached = S.ctrStats[c.id];
  h.innerHTML = `
    <div class="dot ${dotClass(c)}" title="${esc(healthTitle(c))}"></div>
    <span class="title">${esc(c.name)}</span>
    <span class="sub">${esc(c.image)} · ${esc(c.status)}</span>
    <span class="badge stats" id="livestats" style="${c.state === "running" ? "" : "display:none"}">${
      c.state === "running" ? (cached ? statsHtml(cached) : "CPU <b>…</b> · RAM <b>…</b>") : ""}</span>
    <span style="flex:1"></span>
    ${ports.length && c.state === "running" ? `<button data-a="open" title="${esc(t("ctr.openBrowser"))}">${ic("globe")} ${esc(ports[0])}</button>` : ""}
    ${c.state === "running"
      ? `<button data-a="stop">${ic("stop")} ${t("ctr.stop")}</button><button data-a="restart">${ic("rotate")} ${t("ctr.restart")}</button><button data-a="pause" title="${esc(t("ctr.pause"))}">${ic("pause")}</button>`
      : c.state === "paused"
      ? `<button data-a="unpause">${ic("play")} ${t("ctr.unpause")}</button>`
      : `<button data-a="start" class="primary">${ic("play")} ${t("ctr.start")}</button>`}
    <button data-a="rm" class="danger" title="${esc(t("common.delete"))}">${ic("trash")}</button>`;
  h.querySelectorAll("button").forEach(b => b.onclick = async ev => {
    const a = b.dataset.a;
    if (a === "open") {
      // портів може бути кілька — тоді пропонуємо вибрати, а не мовчки беремо перший
      if (ports.length === 1) return openContainerPort(c, ports[0]);
      const r = b.getBoundingClientRect();
      return showContextMenu(r.left, r.bottom + 4, ports.map(p => ({
        icon: "globe", label: p, run: () => openContainerPort(c, p),
      })));
    }
    if (!guardRW("guard.containerAction")) return;
    if (a === "rm" && !(await confirmDanger(t("ctr.deleteQ"), t("ctr.deleteText", { name: esc(c.name) })))) return;
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

/* ═══ стартовий екран ═══
   Порожнє вікно з двома рядками тексту нічого не пояснює тому, хто відкрив
   застосунок уперше. Показуємо, з чого почати, і прибираємо зайве, коли
   підключення вже є. */
function renderWelcome() {
  const box = $("welcome");
  const connected = Object.values(S.conns).some(c => c.up);
  const card = (icon, title, sub, act) =>
    `<div class="wcard" data-w="${act}">${ic(icon, "big")}<div><b>${esc(title)}</b><span>${esc(sub)}</span></div></div>`;
  box.innerHTML = `
    <div class="wtitle">${ic("anchor", "big")} ${t("welcome.title")}</div>
    <div class="whint">${connected ? t("welcome.text") : t("welcome.firstRun")}</div>
    <div class="wgrid">
      ${connected ? "" : card("play", t("welcome.local"), t("welcome.localSub"), "local")}
      ${card("server", t("welcome.server"), t("welcome.serverSub"), "server")}
      ${card("folderCode", t("proj.add"), t("welcome.projectSub"), "project")}
      ${card("search", t("app.palette.title"), t("welcome.paletteSub"), "palette")}
      ${card("info", t("welcome.shortcuts"), t("welcome.shortcutsSub"), "keys")}
    </div>`;
  box.querySelectorAll("[data-w]").forEach(el => el.onclick = () => {
    const w = el.dataset.w;
    if (w === "local") connectProfile("local");
    if (w === "server") { editingProfile = null; fillProfileForm(null); renderProfileList(); $("conn-modal").classList.add("open"); }
    if (w === "project") openProjectModal();
    if (w === "palette") openPalette();
    if (w === "keys") showShortcuts();
  });
}

/* ═══ шпаргалка по клавішах ═══ */
const SHORTCUTS = () => [
  ["Ctrl+K", t("pal.title")],
  ["/", t("keys.filter")],
  ["↑ ↓ · Enter", t("keys.tree")],
  ["← →", t("keys.fold")],
  ["Ctrl+R", t("pal.refreshAll")],
  ["Del", t("keys.del")],
  ["F2", t("files.rename")],
  ["Ctrl+C / Ctrl+V", t("keys.clip")],
  ["Ctrl+Shift+A", t("ctx.selectAll")],
  ["Backspace", t("keys.up")],
  ["Esc", t("keys.esc")],
  ["?", t("welcome.shortcuts")],
];

function showShortcuts() {
  $("keys-body").innerHTML = SHORTCUTS()
    .map(([k, d]) => `<div class="keyrow"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join("");
  $("keys-modal").classList.add("open");
}

/* ═══ навантаження по контейнерах ═══ */
let topTimer = null;

function openTop() {
  clearInterval(topTimer);
  if (!S.topRows.length) $("top-table").innerHTML = loadingBox(t("top.reading"));
  refreshTop();
  topTimer = setInterval(() => {
    if (S.view !== "top") { clearInterval(topTimer); topTimer = null; return; }
    refreshTop();
  }, 4000);
}

async function refreshTop() {
  const conn = S.activeConn;
  if (!conn || !S.conns[conn]?.up) return;
  try {
    const rows = await invoke("containers_stats_snapshot", { conn });
    if (conn !== S.activeConn || S.view !== "top") return;
    S.topRows = rows;
    renderTop();
  } catch (e) {
    $("top-table").innerHTML = errorBox(e);
  }
}

function renderTop() {
  const key = S.topSort in (S.topRows[0] ?? {}) ? S.topSort : "cpu_pct";
  const rows = [...S.topRows].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
  const totalCpu = rows.reduce((a, r) => a + r.cpu_pct, 0);
  const totalMem = rows.reduce((a, r) => a + r.mem_usage, 0);
  const maxCpu = Math.max(...rows.map(r => r.cpu_pct), 1);
  const maxMem = Math.max(...rows.map(r => r.mem_usage), 1);
  const th = (k, label, right) =>
    `<th data-sort="${k}" class="sortable${S.topSort === k ? " on" : ""}"${right ? ' style="text-align:right"' : ""}>${label}</th>`;
  $("top-table").innerHTML = `
    <div class="hint" style="padding:8px 12px">
      ${t("top.summary", { n: rows.length, cpu: totalCpu.toFixed(1), mem: fmtBytes(totalMem) })}
    </div>
    <table class="grid">
      <thead><tr>
        <th>${t("files.name")}</th>
        ${th("cpu_pct", "CPU", true)}<th style="width:110px"></th>
        ${th("mem_usage", "RAM", true)}<th style="width:110px"></th>
        ${th("net_rx", "↓", true)}${th("net_tx", "↑", true)}${th("pids", "PID", true)}
      </tr></thead>
      <tbody>${rows.map(r => `
        <tr class="clickable" data-id="${esc(r.id)}">
          <td>${esc(r.name)}</td>
          <td style="text-align:right;${r.cpu_pct > 80 ? "color:var(--red)" : r.cpu_pct > 40 ? "color:var(--yellow)" : ""}">${r.cpu_pct.toFixed(1)}%</td>
          <td><div class="meter" style="margin:0"><i style="width:${(r.cpu_pct / maxCpu * 100).toFixed(0)}%"></i></div></td>
          <td style="text-align:right">${fmtBytes(r.mem_usage)}</td>
          <td><div class="meter" style="margin:0"><i style="width:${(r.mem_usage / maxMem * 100).toFixed(0)}%"></i></div></td>
          <td style="text-align:right">${fmtBytes(r.net_rx)}</td>
          <td style="text-align:right">${fmtBytes(r.net_tx)}</td>
          <td style="text-align:right">${r.pids}</td>
        </tr>`).join("")}</tbody>
    </table>
    ${rows.length ? "" : `<div class="placeholder">${t("top.empty")}</div>`}`;
  $("top-table").querySelectorAll("th.sortable").forEach(h => h.onclick = () => {
    S.topSort = h.dataset.sort;
    renderTop();
  });
  $("top-table").querySelectorAll("tr.clickable").forEach(tr => tr.onclick = () => {
    const c = S.containers.find(x => x.id === tr.dataset.id);
    if (c) selectContainer(c);
  });
}

/** Бейдж швидкості. Малюється окремою функцією, щоб пережити зміну мови. */
function renderPerf() {
  const p = S.perf;
  if (!p) return;
  const ms = n => `<b>${n} ${t("unit.ms")}</b>`;
  $("perf").innerHTML = (p.startup ? `${t("app.startup")}: ${ms(p.startup)} · ` : "") + `UI: ${ms(p.ui)}`;
}

/* ═══ перевірка оновлень ═══ */
async function checkUpdate(manual) {
  try {
    const r = await invoke("check_update");
    S.update = r;
    const badge = $("update-badge");
    badge.style.display = r.newer ? "inline-flex" : "none";
    badge.title = t("upd.available", { v: r.latest });
    badge.onclick = () => invoke("open_url", { url: r.url }).catch(() => {});
    if (manual) {
      toast(r.newer ? t("upd.available", { v: r.latest }) : t("upd.latest", { v: r.current }), "ok", 6000);
    }
  } catch (e) {
    if (manual) toast(String(e), "warn", 6000);
  }
}

/* ═══ A4 командна палітра ═══ */
let palItems = [], palIdx = 0;

function buildPalette(q) {
  const ql = q.toLowerCase().trim();
  const items = [];
  const add = (ico, title, sub, run) => items.push({ ico, title, sub, run });

  for (const c of S.containers) {
    add(c.state === "running" ? "dot" : "circle", c.name, c.project ? t("pal.container") + " · " + c.project : t("pal.container"),
      () => selectContainer(c));
  }
  const projects = [...new Set(S.containers.filter(c => c.project).map(c => c.project))];
  for (const p of projects) {
    add("layers", p, t("pal.stack"), () => selectStack(p, S.containers.filter(c => c.project === p)));
  }
  for (const p of S.profiles) {
    add("server", p.name, S.conns[p.id]?.up ? t("pal.connActive") : t("pal.connClick"),
      () => S.conns[p.id]?.up ? switchConn(p.id) : connectProfile(p.id));
  }
  for (const p of S.projects) {
    add("folderCode", p.name, t("proj.one") + " · " + p.path, () => openProject(p.id));
  }
  const nav = [
    ["activity", t("tree.stats"), () => { S.view = "server"; S.srvTab = "stats"; }],
    ["cpu", t("tree.proc"), () => { S.view = "server"; S.srvTab = "proc"; }],
    ["folder", t("tree.hostFiles"), () => { S.view = "server"; S.srvTab = "files"; }],
    ["pieChart", t("du.title"), () => { S.view = "server"; S.srvTab = "du"; }],
    ["terminal", t("tree.hostTerm"), () => { S.view = "server"; S.srvTab = "term"; }],
    ["grid", t("pal.dashboard"), () => { S.view = "dash"; }],
    ["hardDrive", t("pal.diskUsage"), () => { S.view = "df"; }],
    ["image", t("tree.images"), () => { S.view = "images"; }],
    ["database", t("tree.volumes"), () => { S.view = "volumes"; }],
    ["network", t("tree.networks"), () => { S.view = "networks"; }],
    ["history", t("tree.journal"), () => { S.view = "journal"; }],
  ];
  for (const [ico, title, fn] of nav) {
    add(ico, title, t("pal.nav"), () => { S.selected = null; S.selectedStack = null; fn(); renderTree(); renderDetail(); });
  }
  add("hammer", t("pal.buildImage"), t("pal.action"), () => { S.view = "images"; renderTree(); renderDetail(); $("build-btn").click(); });
  add("plus", t("pal.newContainer"), t("pal.action"), () => { S.view = "images"; renderTree(); renderDetail(); $("create-btn").click(); });
  add("folderPlus", t("proj.add"), t("pal.action"), () => openProjectModal());
  add("plug", t("pal.closeTunnels"), t("pal.action"), stopAllForwards);
  add("moon", t("pal.toggleTheme"), t("pal.action"), () => setTheme(S.theme === "dark" ? "light" : "dark"));
  add("rotate", t("pal.refreshAll"), t("pal.action"), refreshAll);

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
      <span class="pi-ico">${ic(it.ico)}</span><span>${esc(it.title)}</span><span class="pi-sub">${esc(it.sub)}</span>
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

/* Падіння контейнера має доходити з будь-якого підключеного сервера, а не лише
   з відкритого — інакше сповіщення працюють тільки поки ви й так дивитесь.
   «Несподіване» визначаємо не по тому, чи бачили ми старт (контейнер міг
   працювати тижнями до запуску застосунку), а по тому, чи зупиняли його ми
   самі: у S.pending лежать саме наші дії. */
const crashLog = {};    // conn:id -> час останніх падінь, для розпізнавання циклу
const alertedDie = {};  // щоб перезапуск по колу не слав десять повідомлень
const alertedLoop = {}; // про сам цикл повідомляємо окремо від падінь
const ALERT_HOLD = 10 * 60 * 1000;

function connName(id) {
  return S.profiles.find(p => p.id === id)?.name ?? id;
}

function handleContainerEvent(p) {
  if (p.action !== "die" || !p.id) return;
  const key = p.conn + ":" + p.id;
  const name = p.name || p.id.slice(0, 12);
  const code = String(p.exit_code ?? "");
  // зупинку, яку натиснули ми самі, не рахуємо ні за подію, ні за цикл
  if (S.pending[p.id]) return;

  const now = Date.now();
  const where = connName(p.conn);

  // цикл перезапуску: три падіння за десять хвилин
  const hist = (crashLog[key] ||= []).filter(ts => now - ts < ALERT_HOLD);
  hist.push(now);
  crashLog[key] = hist;
  const looping = hist.length >= 3;
  if (looping) S.crashing[key] = hist.length;

  if (!alertedDie[key] || now - alertedDie[key] > ALERT_HOLD) {
    alertedDie[key] = now;
    const why = code && code !== "0"
      ? t("ctr.exitCode", { code }) + (code === "137" ? " · OOM?" : "")
      : "";
    const msg = t("ctr.unexpectedStop", { name }) + (why ? ` (${why})` : "");
    toast(`${where}: ${msg}`, "warn", 9000);
    tgAlert(`⚠ <b>${where}</b>\n${msg}`, "ctrDie");
  }

  // Про цикл повідомляємо окремо: інакше придушення повторів з'їдало б
  // найважливіше — саме третє падіння показує, що сервіс не піднімається.
  if (looping && (!alertedLoop[key] || now - alertedLoop[key] > ALERT_HOLD)) {
    alertedLoop[key] = now;
    const loop = t("ctr.crashLoop", { name, n: hist.length });
    toast(`${where}: ${loop}`, "err", 12000);
    tgAlert(`🔁 <b>${where}</b>\n${loop}`, "ctrDie");
  }
}

listen("docker-event", ev => {
  const p = ev.payload;
  handleContainerEvent(p);          // алерти — з усіх серверів
  if (p.conn !== S.activeConn) return;   // а от перемальовка — лише для відкритого
  const light = $("eventlight");
  light.classList.add("on");
  setTimeout(() => light.classList.remove("on"), 300);
  $("lastevent").textContent = `${t("events.one")}: ${p.action ?? "?"}`;
  if (p.id && ["start", "die", "stop", "destroy", "pause", "unpause"].includes(p.action)) delete S.pending[p.id];

  clearTimeout(refreshTimer);
  // тихо: смужка прогресу — для того, чого чекає користувач, а не для
  // фонових подій, яких на активному демоні десятки за хвилину
  refreshTimer = setTimeout(() => refreshAll({ quiet: true }), 200);
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
  if (!p.up && S.conns[p.conn]?.up) {
    const name = S.profiles.find(x => x.id === p.conn)?.name ?? p.conn;
    tgAlert(`⚠ <b>${name}</b>\n${t("conn.eventsLostShort")}`, "connLost");
    markDown(p.conn, t("conn.eventsLostShort"));
  }
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
  $("refresh").onclick = () => refreshAll();
  $("theme-btn").onclick = () => setTheme(S.theme === "dark" ? "light" : "dark");
  $("lang-sel").onchange = e => setLang(e.target.value);
  $("fwd-badge").onclick = stopAllForwards;

  /* Стандартне меню браузера («Зберегти як…», «Переглянути код») тут ні до чого:
     це застосунок, а не сторінка. Але прибрати його й не дати нічого натомість —
     гірше, ніж лишити: тому там, де є виділений текст, показуємо своє «копіювати».
     У полях вводу лишається системне меню — лише воно вміє вставляти. */
  document.addEventListener("contextmenu", e => {
    const el = e.target instanceof Element ? e.target : null;
    if (el && (/INPUT|TEXTAREA/.test(el.tagName) || el.isContentEditable || el.closest(".CodeMirror"))) return;
    e.preventDefault();
    if (!el || el.closest(".ctxmenu")) return;
    const sel = String(window.getSelection?.() ?? "").trim();
    if (!sel) return;
    showContextMenu(e.clientX, e.clientY, [
      { icon: "copy", label: t("ctx.copy"), hint: "Ctrl+C", run: () => copyText(sel) },
    ]);
  });
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
    if (e.key === "?" && !typing) { e.preventDefault(); showShortcuts(); }
    if (e.key === "r" && e.ctrlKey && !typing) { e.preventDefault(); refreshAll(); }
  });

  wireTreeKeys();
  wireResizer();
}

/* ── ширина лівої панелі ──
   Секцій там стало три, і на ноутбуці список контейнерів опинявся у щілині.
   Тягнемо межу мишею; подвійний клік повертає типову ширину. */
const LEFT_MIN = 300;                                  // збігається з min-width у CSS
const leftMax = () => Math.max(LEFT_MIN, window.innerWidth - 420);
const clampLeft = w => Math.max(LEFT_MIN, Math.min(leftMax(), w || 380));

function wireResizer() {
  const left = $("left");
  const bar = $("resizer");
  // збережене значення могло лишитись від іншого розміру вікна
  S.cfg.leftWidth = clampLeft(S.cfg.leftWidth);
  left.style.width = S.cfg.leftWidth + "px";
  let startX = 0, startW = 0, moved = false;
  const onMove = e => {
    moved = true;
    left.style.width = clampLeft(startW + e.clientX - startX) + "px";
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("resizing");
    if (!moved) return;                                 // просто клік — нічого не міняємо
    S.cfg.leftWidth = clampLeft(parseInt(left.style.width));
    persist();
    doResize(activeSess());
  };
  bar.addEventListener("mousedown", e => {
    e.preventDefault();
    startX = e.clientX;
    startW = left.getBoundingClientRect().width;
    moved = false;
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  bar.addEventListener("dblclick", () => {
    left.style.width = "380px";
    S.cfg.leftWidth = 380;
    persist();
  });
}

/* ═══ старт ═══ */
(async () => {
  const lastConn = restore();
  wireGlobal(); wireConnUI(); wireLogsUI(); wireFilesUI(); wireEditorUI();
  wireTermUI(); wireServerUI(); wireResourcesUI(); wirePalette(); wireBulk();
  wireExtras(); wireProjectUI(); wireDuUI();

  applyIcons();
  applyI18n();
  $("lang-sel").value = LANG;
  $("quick-filter").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.q === S.quick));
  $("log-wrap").classList.toggle("primary", !S.logWrap);

  await loadProfiles();
  await loadProjects();
  fillProfileForm(null);
  S.perf = { ui: Math.round(performance.now()) };
  renderPerf();

  // відновлюємо всі зʼєднання, які були увімкнені (autoconnect)
  const restored = await restoreConnections();
  // перше знайомство: якщо прапорців ще немає — піднімаємо локальний демон
  if (!S.profiles.some(p => p.autoconnect)) await connectProfile("local");

  const target = [lastConn, ...restored, "local"].find(id => S.conns[id]?.up);
  if (target) switchConn(target);
  const info = S.conns[S.activeConn]?.info;
  if (info) {
    S.perf = { startup: info.startup_ms, ui: Math.round(performance.now()) };
    renderPerf();
  }

  refreshForwards();
  syncMonitor();                       // фонові монітори для порогових алертів
  if (S.cfg.checkUpdates) setTimeout(() => checkUpdate(false), 4000);
  // повне оновлення — рідко, список контейнерів — часто: він і дає відчуття
  // «стан змінився одразу», але коштує один дешевий запит
  armPolling();
  // повернулись у вікно — одразу підтягуємо актуальне
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshContainers();
  });
  window.addEventListener("focus", () => refreshContainers());
})();
