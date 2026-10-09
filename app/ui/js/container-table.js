"use strict";
/* Огляд контейнерів: статистика, фокус і прокрутка належать конкретному серверу. */
const containerTables = new Map();
let containerTableTimer = null, containerTableRequest = null;
function containerTableState() {
  const conn = S.activeConn;
  if (!containerTables.has(conn)) containerTables.set(conn, {stats:new Map(), scroll:0, restoreScroll:false, error:"", updated:0, signature:""});
  return containerTables.get(conn);
}
function containerSeverity(c) {
  return isProblem(c) ? 5 : healthOf(c) === "starting" ? 4 : c.state === "paused" ? 3 : c.state === "created" ? 2 : c.state === "running" ? 0 : 1;
}
function containerMetric(c, key, stats) {
  const value = stats.get(c.id)?.[key === "cpu" ? "cpu_pct" : "mem_usage"];
  return c.state === "running" && typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function sortedContainerRows(rows, stats) {
  const {key,dir} = S.containerSort;
  const name = (a,b) => a.name.localeCompare(b.name,LANG,{numeric:true}) || a.id.localeCompare(b.id);
  return [...rows].sort((a,b) => {
    if (key === "name") return dir * name(a,b);
    if (key === "status") return dir * (containerSeverity(a)-containerSeverity(b)) || name(a,b);
    const av = containerMetric(a,key,stats), bv = containerMetric(b,key,stats);
    // Невідоме навантаження — в кінці в обох напрямках, а не удаваний нуль.
    return av === null && bv !== null ? 1 : bv === null && av !== null ? -1 : dir * ((av ?? 0)-(bv ?? 0)) || name(a,b);
  });
}
function containerStateLabel(c) {
  return t(isProblem(c) ? "ct.problem" : healthOf(c) === "starting" ? "ct.starting" : "ct." + (["running","exited","paused","restarting","created","dead","removing"].includes(c.state) ? c.state : "unknown"));
}
function rememberContainerTableScroll() {
  if (!S.loading && !containerTableState().restoreScroll && $("pane-containers")?.classList.contains("active") && $("ct-scroll").dataset.conn === S.activeConn) containerTableState().scroll = $("ct-scroll").scrollTop;
}
function openContainerTable() {
  if (!S.conns[S.activeConn]?.up || !S.conns[S.activeConn]?.dockerOk) return;
  rememberNavigation(); pendingNavigation = null;
  containerTableState().restoreScroll = true;
  S.navMode = "containers"; S.containerDisplay = "table"; S.view = "containers"; S.selectedStack = null;
  persist(); renderTree(); renderDetail();
}
function returnToContainerTree() {
  rememberContainerTableScroll(); S.containerDisplay = "tree";
  const c = S.containers.find(c => c.id === S.selected?.id);
  S.view = c ? "container" : "welcome"; S.selected = c ?? null;
  persist(); renderTree(); renderDetail();
}
function openTableContainer(c, logs = false) {
  rememberContainerTableScroll();
  if (logs) S.tab = "logs";
  selectContainer(c);
}
function syncContainerTable() {
  if (S.view !== "containers" || !S.conns[S.activeConn]?.dockerOk) {
    clearInterval(containerTableTimer); containerTableTimer = null; containerTableRequest = null;
    if (!S.conns[S.activeConn]?.dockerOk) {
      const state = containerTableState(); state.stats.clear(); state.updated = 0; state.error = "";
    }
    return;
  }
  if (!containerTableTimer) containerTableTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshContainerTableStats();
  },4000);
  if (Date.now()-containerTableState().updated > 3500) refreshContainerTableStats();
}
async function refreshContainerTableStats() {
  const conn = S.activeConn;
  if (S.view !== "containers" || !S.conns[conn]?.up || !S.conns[conn]?.dockerOk) return;
  if (containerTableRequest?.conn === conn) return;
  const request = {conn}; containerTableRequest = request;
  const valid = () => containerTableRequest === request && S.activeConn === conn && S.view === "containers" && S.conns[conn]?.up && S.conns[conn]?.dockerOk;
  try {
    const rows = await invoke("containers_stats_snapshot",{conn});
    if (!valid()) return;
    const state = containerTableState();
    state.stats = new Map(rows.map(r => [r.id,r])); state.error = ""; state.updated = Date.now();
    renderContainerTable();
  } catch (e) {
    if (!valid()) return;
    const state = containerTableState();
    state.stats.clear(); state.error = String(e); state.updated = Date.now();
    renderContainerTable();
  } finally { if (containerTableRequest === request) containerTableRequest = null; }
}
function renderContainerTable() {
  if (S.view !== "containers" || !$("ct-scroll")) return;
  const state = containerTableState(), box = $("ct-scroll"), filter = $("filter").value.toLowerCase();
  if (!S.conns[S.activeConn]?.up || !S.conns[S.activeConn]?.dockerOk) {
    syncContainerTable(); state.signature = "";
    box.innerHTML = `<div class="nav-empty">${esc(t(S.conns[S.activeConn]?.up ? "conn.noDocker" : "tree.connectFirst"))}</div>`;
    $("ct-count").textContent = ""; $("ct-stats-status").textContent = ""; $("ct-retry").hidden = true;
    return;
  }
  if (document.activeElement !== $("ct-search")) $("ct-search").value = $("filter").value;
  $("ct-state").value = S.quick;
  const rows = sortedContainerRows(S.containers.filter(c => passQuick(c) && matchesFilter(c,filter)),state.stats);
  $("ct-count").textContent = t("ct.count",{n:rows.length,total:S.containers.length});
  $("ct-stats-status").textContent = state.error ? t("ct.statsError") : !state.updated ? t("ct.reading") : t("ct.live");
  $("ct-stats-status").title = state.error;
  $("ct-retry").hidden = !state.error;
  const sig = JSON.stringify([LANG,S.loading,S.activeConn,S.containerSort,state.error,S.selected?.id,S.bulkMode,[...S.bulkSel],rows.map(c=>[c.id,c.name,c.state,c.status,c.image,c.project,c.ports,!!S.pending[c.id],containerMetric(c,"cpu",state.stats),containerMetric(c,"ram",state.stats)])]);
  const paneActive = $("pane-containers").classList.contains("active");
  if (S.loading) state.restoreScroll = true;
  if (state.signature === sig && box.dataset.conn === S.activeConn) {
    if (state.restoreScroll && !S.loading && paneActive) { box.scrollTop = state.scroll; state.restoreScroll = false; }
    return;
  }
  const active = document.activeElement, focused = active?.closest("[data-ct-id]")?.dataset.ctId, action = active?.dataset.ctAction, focusedSort = active?.dataset.ctSort;
  const same = box.dataset.conn === S.activeConn;
  const scroll = same && paneActive && !state.restoreScroll ? box.scrollTop : state.scroll;
  state.signature = sig; box.dataset.conn = S.activeConn;
  const th = (key,label) => `<th scope="col" aria-sort="${S.containerSort.key === key ? S.containerSort.dir === 1 ? "ascending" : "descending" : "none"}"><button data-ct-sort="${key}">${esc(label)}${S.containerSort.key === key ? (S.containerSort.dir === 1 ? " ↑" : " ↓") : ""}</button></th>`;
  const metric = (c,key) => {
    const value = containerMetric(c,key,state.stats);
    return value === null ? `<span class="hint" title="${esc(t(c.state === "running" ? "ct.noStats" : "ct.notRunning"))}">—</span>` : key === "cpu" ? value.toFixed(1)+"%" : fmtBytes(value);
  };
  box.innerHTML = `<table class="ct-grid"><caption class="sr-only">${esc(t("ct.table"))}</caption><colgroup><col><col class="ct-col-state"><col class="ct-col-metric"><col class="ct-col-ram"><col class="ct-col-ports"><col class="ct-col-actions"></colgroup>
    <thead><tr>${th("name",t("files.name"))}${th("status",t("ct.status"))}${th("cpu","CPU")}${th("ram","RAM")}<th scope="col" class="ct-ports">${esc(t("ct.ports"))}</th><th scope="col"><span class="sr-only">${esc(t("nav.actions"))}</span></th></tr></thead>
    <tbody>${rows.map(c => `<tr data-ct-id="${esc(c.id)}" class="${isProblem(c) ? "ct-problem" : ""}">
      <td><div class="ct-item">${S.bulkMode ? `<input type="checkbox" class="ct-bulk" data-ct-action="select" aria-label="${esc(t("ct.select")+": "+c.name)}" ${S.bulkSel.has(c.id) ? "checked" : ""}>` : ""}<div class="ct-label"><button class="ct-name" data-ct-action="open" title="${esc(c.name+"\n"+c.image+(c.project ? "\n"+c.project : ""))}">${esc(c.name)}</button><div class="ct-image" title="${esc(c.image)}">${esc(c.image)}</div>${c.ports ? `<div class="ct-ports-inline" title="${esc(c.ports)}">${esc(c.ports)}</div>` : ""}</div></div></td>
      <td><span class="ct-status ${isProblem(c) ? "problem" : ""}" title="${esc(S.pending[c.id] ? t("common.loading") : c.status)}">${S.pending[c.id] ? `<span class="spin"></span>` : `<span class="cdot ${c.state === "running" && !isProblem(c) ? "up" : ""}"></span>`}${esc(containerStateLabel(c))}</span></td>
      <td class="ct-number">${metric(c,"cpu")}</td><td class="ct-number">${metric(c,"ram")}</td>
      <td class="ct-ports"><span title="${esc(c.ports)}">${esc(c.ports || "—")}</span></td>
      <td class="ct-actions"><button data-ct-action="logs" title="${esc(t("tab.logs"))}" aria-label="${esc(t("tab.logs")+": "+c.name)}">${ic("list")}</button><button data-ct-action="menu" title="${esc(t("nav.actions"))}" aria-label="${esc(t("nav.actions")+": "+c.name)}">${ic("more")}</button></td></tr>`).join("")}</tbody></table>`;
  if (!rows.length) box.insertAdjacentHTML("beforeend", `<div class="nav-empty">${esc(t(S.loading ? "common.loading" : S.containers.length ? "nav.noContainers" : "nav.emptyContainers"))}${S.containers.length ? `<button data-ct-clear>${esc(t("nav.clearFilters"))}</button>` : ""}</div>`);
  state.scroll = scroll;
  if (!S.loading && paneActive) { box.scrollTop = scroll; state.restoreScroll = false; }
  else state.restoreScroll = true;
  if (focused) [...box.querySelectorAll("[data-ct-id]")].find(r => r.dataset.ctId === focused)?.querySelector('[data-ct-action="'+action+'"]')?.focus({preventScroll:true});
  if (focusedSort) box.querySelector('[data-ct-sort="'+focusedSort+'"]')?.focus({preventScroll:true});
}
function setContainerSort(key) {
  if (!["name","status","cpu","ram"].includes(key)) return;
  S.containerSort = {key,dir:S.containerSort.key === key ? -S.containerSort.dir : key === "name" ? 1 : -1};
  resetContainerTableScroll();
  persist(); renderContainerTable();
}
function resetContainerTableScroll() {
  containerTableState().scroll = $("ct-scroll").scrollTop = 0;
  containerTableState().restoreScroll = true;
}
function filterContainerTable(value, quick = S.quick) {
  $("filter").value = value; S.quick = quick; S.cursor = -1; navScrollRestore = 0;
  resetContainerTableScroll();
  persist(); renderTree();
}
function wireContainerTable() {
  $("ct-tree").onclick = returnToContainerTree;
  $("ct-search").oninput = e => filterContainerTable(e.target.value);
  $("ct-state").onchange = e => filterContainerTable($("filter").value,e.target.value);
  $("ct-retry").onclick = refreshContainerTableStats;
  $("ct-scroll").onclick = e => {
    const sort = e.target.closest("[data-ct-sort]");
    if (sort) { setContainerSort(sort.dataset.ctSort); return; }
    if (e.target.closest("[data-ct-clear]")) { filterContainerTable("","all"); return; }
    const button = e.target.closest("[data-ct-action]"), row = e.target.closest("[data-ct-id]");
    const c = S.containers.find(c => c.id === row?.dataset.ctId);
    if (!c) return;
    if (button?.dataset.ctAction === "select") {
      if (button.checked) S.bulkSel.add(c.id); else S.bulkSel.delete(c.id);
      renderTree(); return;
    }
    if (button?.dataset.ctAction === "menu") { const r=button.getBoundingClientRect(); showContextMenu(r.left,r.bottom,containerMenuItems(c)); }
    else openTableContainer(c,button?.dataset.ctAction === "logs");
  };
  $("ct-scroll").oncontextmenu = e => {
    const c = S.containers.find(c => c.id === e.target.closest("[data-ct-id]")?.dataset.ctId);
    if (c) { e.preventDefault(); showContextMenu(e.clientX,e.clientY,containerMenuItems(c)); }
  };
  $("ct-scroll").onkeydown = e => {
    if (e.altKey || e.ctrlKey || e.metaKey || !["ArrowUp","ArrowDown","Home","End"].includes(e.key)) return;
    const choices=[...$("ct-scroll").querySelectorAll('[data-ct-action="open"]')];
    const row=e.target.closest("[data-ct-id]"), i=choices.findIndex(b=>b.closest("[data-ct-id]") === row);
    if (i < 0) return;
    e.preventDefault();
    choices[Math.max(0,Math.min(choices.length-1,e.key === "Home" ? 0 : e.key === "End" ? choices.length-1 : i+(e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
}
