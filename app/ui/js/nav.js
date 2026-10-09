"use strict";
/* Постійна навігація; запамʼятовуємо контекст окремо для кожного сервера. */
const navMemory = new Map();
let pendingNavigation = null, navScrollRestore = null, pickerSignature = "";
const RESOURCE_VIEWS = ["top", "images", "volumes", "networks", "df", "journal"];
const viewMode = view => view === "server" ? "server" : view === "project" ? "projects" : "containers";
function navigationState() {
  const id = S.activeConn ?? "";
  if (!navMemory.has(id)) navMemory.set(id, {mode:"containers", filter:"", quick:"all", views:{}, scroll:{}});
  return navMemory.get(id);
}
function rememberNavigation() {
  rememberContainerTableScroll();
  const state = navigationState();
  state.mode = S.navMode;
  state.filter = $("filter").value;
  state.quick = S.quick;
  const mode = S.navMode;
  state.scroll[mode] = pendingNavigation?.conn === S.activeConn
    ? pendingNavigation.scroll : (mode === "projects" ? $("projbox") : $("tree")).scrollTop;
  // Поки дані їдуть, welcome не має затерти вибраний контейнер.
  if (pendingNavigation?.conn === S.activeConn) return;
  const saved = {view:S.view, id:S.selected?.id, stack:S.selectedStack?.project,
    project:S.project?.id, info:S.projInfo, tab:S.tab, srvTab:S.srvTab, stackTab:S.stackTab, projTab:S.projTab};
  state.current = saved;
  if (!RESOURCE_VIEWS.includes(S.view) && S.view !== "dash") state.views[mode] = saved;
}
function applyNavigation(saved) {
  S.selected = null; S.selectedStack = null; S.project = null;
  S.view = "welcome";
  if (!saved) return;
  for (const key of ["tab","srvTab","stackTab","projTab"]) if (saved[key]) S[key] = saved[key];
  if (saved.view === "container") {
    S.selected = S.containers.find(c => c.id === saved.id) ?? null;
    if (S.selected) S.view = "container";
  } else if (saved.view === "containers" && S.conns[S.activeConn]?.dockerOk) {
    S.view = "containers"; S.selected = S.containers.find(c => c.id === saved.id) ?? null;
  } else if (saved.view === "stack") {
    const rows = S.containers.filter(c => c.project === saved.stack);
    if (rows.length) { S.selectedStack = {project:saved.stack, rows}; S.view = "stack"; }
  } else if (saved.view === "project") {
    const p = visibleProjects().find(p => p.id === saved.project);
    if (p && (!p.remote || S.conns[p.conn]?.up)) { S.project = p; S.projInfo = saved.info ?? null; S.view = "project"; }
  } else if (saved.view === "server" && activeProfile()?.kind === "ssh" && S.conns[S.activeConn]?.up) {
    S.view = "server";
  } else if (saved.view === "dash" || saved.view === "journal" || (RESOURCE_VIEWS.includes(saved.view) && S.conns[S.activeConn]?.dockerOk)) {
    S.view = saved.view;
  }
}
function prepareNavigation(conn) {
  const state = navigationState();
  S.navMode = state.mode;
  $("filter").value = state.filter;
  S.quick = state.quick;
  S.cursor = -1;
  navScrollRestore = state.scroll[S.navMode] ?? 0;
  const saved = state.current ?? state.views[S.navMode] ?? (S.navMode === "containers" && S.containerDisplay === "table" ? {view:"containers"} : null);
  const waitForList = (S.loading && S.navMode === "containers") || (saved && ["container","stack"].includes(saved.view));
  pendingNavigation = waitForList ? {conn, saved:saved ?? {view:"welcome"}, scroll:navScrollRestore} : null;
  applyNavigation(saved);
  if (!saved && S.navMode === "server" && activeProfile()?.kind === "ssh" && S.conns[conn]?.up) S.view = "server";
}
function restorePendingNavigation(conn) {
  if (!pendingNavigation || conn !== S.activeConn || pendingNavigation.conn !== conn) return false;
  const {saved,scroll} = pendingNavigation;
  pendingNavigation = null;
  applyNavigation(saved);
  navScrollRestore = scroll;
  return true;
}
function switchNavMode(mode) {
  if (mode === S.navMode && !RESOURCE_VIEWS.includes(S.view) && S.view !== "dash") return;
  rememberNavigation();
  pendingNavigation = null;
  S.navMode = mode;
  const state = navigationState(), saved = state.views[mode];
  navScrollRestore = state.scroll[mode] ?? 0;
  applyNavigation(saved);
  if (mode === "server" && activeProfile()?.kind === "ssh" && S.conns[S.activeConn]?.up) S.view = "server";
  if (S.loading && saved && ["container","stack"].includes(saved.view)) {
    pendingNavigation = {conn:S.activeConn, saved, scroll:navScrollRestore};
    applyNavigation(null);
  }
  renderTree(); renderDetail();
}
function openNavView(view) {
  rememberNavigation(); pendingNavigation = null;
  S.view = view; S.selected = null; S.selectedStack = null;
  renderTree(); renderDetail();
}
function groupCollapseKey(project) { return JSON.stringify([S.activeConn, project]); }
function setGroupCollapsed(project, collapsed) { S.collapsed.set(groupCollapseKey(project), collapsed); }
function serverAddress(p) {
  return p.kind === "local" ? t("conn.localSocket") : p.kind === "ssh" ? `${p.user}@${p.host}:${p.port || 22}` : `${p.host}:${p.port || 2375}`;
}
function serverStatus(p) {
  const c = S.conns[p.id];
  return c?.connecting || retry[p.id]?.timer ? t("conn.reconnecting") : c?.up ? (c.dockerOk ? t("conn.connected") : t("conn.noDockerShort")) : t("conn.disconnected");
}
function stepServer(delta) {
  if (document.querySelector(".modal-back.open")) return;
  const i = S.profiles.findIndex(p => p.id === S.activeConn);
  const p = S.profiles[(i + delta + S.profiles.length) % S.profiles.length];
  if (p) switchConn(p.id);
}
function recordServerVisit(id) {
  S.serverRecent = [id, ...S.serverRecent.filter(x => x !== id)].slice(0,8);
}
function orderedServerProfiles(query) {
  const f = query.trim().toLowerCase(), words = f.split(/\s+/).filter(Boolean);
  const score = p => {
    const name = p.name.toLowerCase();
    return !f ? 0 : name === f ? 0 : name.startsWith(f) ? 1 : words.every(w => name.includes(w)) ? 2 : 3;
  };
  const priority = p => {
    const pin = S.serverPins.indexOf(p.id), recent = S.serverRecent.indexOf(p.id);
    return pin >= 0 ? pin - 1000 : recent >= 0 ? recent - 100 : 0;
  };
  return S.profiles.filter(p => words.every(w => (p.name + " " + serverAddress(p)).toLowerCase().includes(w)))
    .sort((a,b) => score(a) - score(b) || priority(a) - priority(b));
}
function toggleServerPin(id) {
  S.serverPins = S.serverPins.includes(id) ? S.serverPins.filter(x => x !== id) : [...S.serverPins,id];
  persist(); pickerSignature = ""; renderServerSelector();
  document.activeElement?.closest("#server-options") && document.activeElement.scrollIntoView({block:"nearest"});
}
function previewServer(p) {
  if (p) $("server-preview").textContent = serverAddress(p) + " · " + serverStatus(p) + (p.readonly ? " · " + t("context.readonly") : "");
}
function renderServerQuickAccess() {
  const box = $("server-quick");
  if (!box) return;
  const profiles = S.serverPins.map(profileById).filter(Boolean).slice(0,4);
  const sig = JSON.stringify([LANG,S.activeConn,profiles.map(p => [p.id,p.name,serverStatus(p)])]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig; box.hidden = !profiles.length;
  box.innerHTML = "";
  for (const p of profiles) {
    const b = document.createElement("button");
    b.className = "server-shortcut" + (S.activeConn === p.id ? " on" : "");
    b.title = p.name + "\n" + serverAddress(p) + " · " + serverStatus(p);
    b.setAttribute("aria-current",String(S.activeConn === p.id));
    b.innerHTML = ic("star","sm") + "<span>" + esc(p.name) + "</span>";
    b.onclick = () => { closeServerPicker(false); switchConn(p.id); };
    box.appendChild(b);
  }
}
function closeServerPicker(focus = true) {
  $("server-picker").hidden = true;
  $("server-select").setAttribute("aria-expanded","false");
  if (focus) $("server-select").focus();
}
function openServerPicker() {
  $("server-picker").hidden = false;
  $("server-select").setAttribute("aria-expanded","true");
  $("server-search").value = "";
  $("server-options").scrollTop = 0;
  pickerSignature = "";
  renderServerPicker();
  $("server-search").focus();
}
function renderServerPicker() {
  if (!$("server-picker") || $("server-picker").hidden) return;
  const f = $("server-search").value.trim().toLowerCase();
  const shown = orderedServerProfiles(f);
  $("server-picker").classList.toggle("wide",S.profiles.length > 8);
  const sig = JSON.stringify([LANG,S.activeConn,f,S.serverPins,S.serverRecent,shown.map(p => [p.id,p.name,serverAddress(p),p.readonly,serverStatus(p)])]);
  if (sig === pickerSignature) return;
  pickerSignature = sig;
  const box = $("server-options"), scroll = box.scrollTop;
  const focused = document.activeElement?.closest("[data-profile]")?.dataset.profile;
  const action = document.activeElement?.classList.contains("server-power") ? ".server-power" : document.activeElement?.classList.contains("server-pin") ? ".server-pin" : ".server-choice";
  box.innerHTML = "";
  for (const p of shown) {
    const c = S.conns[p.id], row = document.createElement("div"), pinned = S.serverPins.includes(p.id);
    row.className = "server-option" + (S.activeConn === p.id ? " sel" : "");
    row.dataset.profile = p.id;
    const detail = serverAddress(p) + " · " + serverStatus(p) + (p.readonly ? " · " + t("context.readonly") : "");
    row.innerHTML = `<button class="server-choice" aria-current="${S.activeConn === p.id}" title="${esc(p.name + "\n" + detail)}" aria-label="${esc(p.name + " · " + serverStatus(p) + (p.readonly ? " · " + t("context.readonly") : ""))}">
      <span class="cdot ${c?.up ? c.dockerOk ? "up" : "nodocker" : c?.connecting ? "connecting" : ""}"></span>
      <strong class="server-name">${esc(p.name)}</strong>${p.readonly ? ic("lock","sm") : ""}
      ${S.activeConn === p.id ? ic("check") : ""}</button>
      <button class="server-pin ${pinned ? "pinned" : ""}" aria-pressed="${pinned}" title="${esc(t(pinned ? "nav.unpinServer" : "nav.pinServer"))}" aria-label="${esc(t(pinned ? "nav.unpinServer" : "nav.pinServer") + ": " + p.name)}">${ic("star","sm")}</button>
      <button class="server-power" ${c?.connecting ? "disabled" : ""} aria-label="${esc((c?.up ? t("conn.disconnect") : t("conn.connect")) + ": " + p.name)}" title="${esc(c?.up ? t("conn.disconnect") : t("conn.connect"))}">${ic(c?.up ? "power" : "play")}</button>`;
    row.querySelector(".server-choice").onclick = () => { closeServerPicker(); switchConn(p.id); };
    row.querySelector(".server-power").onclick = () => c?.up ? disconnectProfile(p.id) : connectProfile(p.id,{activate:false});
    row.querySelector(".server-pin").onclick = () => toggleServerPin(p.id);
    row.onmouseenter = () => previewServer(p);
    row.addEventListener("focusin",() => previewServer(p));
    row.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); closeServerPicker(false); showContextMenu(e.clientX,e.clientY,serverMenuItems(p)); };
    box.appendChild(row);
  }
  if (!shown.length) box.innerHTML = `<div class="placeholder">${esc(t("nav.noServers"))}</div>`;
  $("server-picker-hint").textContent = t("nav.pickerHint",{n:shown.length});
  previewServer(shown.find(p => p.id === S.activeConn) ?? shown[0]);
  if (!shown.length) $("server-preview").textContent = "";
  box.scrollTop = scroll;
  if (focused) {
    const row = [...box.children].find(r => r.dataset.profile === focused), control = row?.querySelector(action);
    (control && !control.disabled ? control : row?.querySelector(".server-choice"))?.focus({preventScroll:true});
  }
}
function renderNavigation() {
  if (!$("nav-modes")) return;
  const mode = S.navMode;
  $("nav-modes").querySelectorAll("button").forEach(b => {
    const selected = b.dataset.mode === mode && !RESOURCE_VIEWS.includes(S.view) && S.view !== "dash";
    b.classList.toggle("on",selected); b.setAttribute("aria-pressed",String(selected));
  });
  $("container-search").hidden = $("quickbar").hidden = mode !== "containers";
  $("tree").hidden = mode === "projects";
  $("treehead").hidden = mode !== "containers";
  $("projbox").hidden = mode !== "projects";
  $("quick-filter").querySelectorAll("button").forEach(b => b.classList.toggle("on",b.dataset.q === S.quick));
  $("nav-resources").value = RESOURCE_VIEWS.includes(S.view) ? S.view : "";
  [...$("nav-resources").options].forEach(o => { o.disabled = !!o.value && o.value !== "journal" && !S.conns[S.activeConn]?.dockerOk; });
  $("nav-dashboard").classList.toggle("on",S.view === "dash");
  $("bulkbar").hidden = mode !== "containers" || !S.conns[S.activeConn]?.dockerOk;
}
function renderServerSelector() {
  if (!$("server-select")) return;
  const p = activeProfile(), c = S.conns[S.activeConn];
  $("server-select").innerHTML = `<span class="cdot ${c?.up ? c.dockerOk ? "up" : "nodocker" : c?.connecting ? "connecting" : ""}"></span>
    <span class="server-info"><strong>${esc(p?.name ?? t("nav.chooseServer"))}</strong><small>${p ? esc(serverStatus(p)) + (p.readonly ? " · " + esc(t("context.readonly")) : "") : esc(t("conn.new"))}</small></span>${ic("chevronDown")}`;
  $("server-select").title = (p ? serverAddress(p) : t("nav.chooseServer")) + " · Alt+S";
  $("server-select").oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); if (p) showContextMenu(e.clientX,e.clientY,serverMenuItems(p)); };
  for (const id of ["server-prev","server-next"]) $(id).disabled = S.profiles.length < 2;
  renderServerPicker();
  renderServerQuickAccess();
}
function serverMenuItems(p) {
  const items = hostMenuItems(p), c = S.conns[p.id];
  if (items.length) items.push("-");
  items.push({icon:c?.up ? "power" : "play",label:t(c?.up ? "conn.disconnect" : "conn.connect"),
    disabled:!!c?.connecting,run:()=>c?.up ? disconnectProfile(p.id) : connectProfile(p.id,{activate:false})});
  if (p.id !== "local") items.push({icon:"pencil",label:t("conn.edit"),run:()=>openConnectionManager(p)});
  return items;
}
function openConnectionManager(p = null, adding = false) {
  closeServerPicker(false);
  editingProfile = p; fillProfileForm(p); renderProfileList();
  $("conn-modal").classList.toggle("adding",adding);
  $("conn-modal").classList.add("open");
  setTimeout(() => $("pf-name").focus(),60);
}
function wireNavigation() {
  $("server-select").onclick = () => $("server-picker").hidden ? openServerPicker() : closeServerPicker();
  $("server-add").onclick = () => openConnectionManager(null,true);
  $("server-manage").onclick = () => openConnectionManager();
  $("server-prev").onclick = () => stepServer(-1);
  $("server-next").onclick = () => stepServer(1);
  $("server-search").oninput = () => { $("server-options").scrollTop = 0; renderServerPicker(); };
  $("nav-modes").querySelectorAll("button").forEach(b => b.onclick = () => switchNavMode(b.dataset.mode));
  $("nav-resources").onchange = e => { if (e.target.value) openNavView(e.target.value); };
  $("nav-dashboard").onclick = () => openNavView("dash");
  document.addEventListener("mousedown",e => { if (!$("connbox").contains(e.target)) closeServerPicker(false); });
  $("server-picker").addEventListener("keydown",e => {
    if (e.key === "Escape") { e.preventDefault(); closeServerPicker(); return; }
    const choices = [...$("server-options").querySelectorAll(".server-choice")];
    const profile = e.target.closest("[data-profile]")?.dataset.profile;
    const i = choices.findIndex(b => b.closest("[data-profile]").dataset.profile === profile);
    const fromSearch = e.target === $("server-search");
    if (["ArrowDown","ArrowUp"].includes(e.key) || (!fromSearch && ["ArrowLeft","ArrowRight","Home","End"].includes(e.key))) {
      e.preventDefault(); e.stopPropagation();
      const cols = $("server-picker").classList.contains("wide") ? 2 : 1;
      const delta = e.key === "ArrowDown" ? cols : e.key === "ArrowUp" ? -cols : e.key === "ArrowRight" ? 1 : -1;
      const next = e.key === "Home" ? 0 : e.key === "End" ? choices.length-1 : i < 0 ? (delta > 0 ? 0 : choices.length-1) : i + delta;
      choices[Math.max(0,Math.min(choices.length-1,next))]?.focus();
    } else if (e.key === "Enter" && e.target === $("server-search")) { e.preventDefault(); choices[0]?.click(); }
  });
  document.addEventListener("keydown",e => {
    if (e.altKey && !e.ctrlKey && e.code === "KeyS" && !document.querySelector(".modal-back.open") && !e.target.closest?.(".CodeMirror,.xterm")) {
      e.preventDefault(); $("server-picker").hidden ? openServerPicker() : closeServerPicker(); return;
    }
    if (e.altKey && !e.ctrlKey && ["ArrowUp","ArrowDown"].includes(e.key) && !document.querySelector(".modal-back.open") && !e.target.closest?.(".CodeMirror,.xterm,input,textarea,select")) {
      e.preventDefault(); stepServer(e.key === "ArrowDown" ? 1 : -1);
    }
  });
}
