"use strict";
/* Локальні проєкти: тека на цій машині поруч із серверами.
   Зазвичай цикл виглядає так — глянути файл, поправити, перезібрати.
   Раніше для цього треба було виходити із застосунку; тепер усе тут:
   файловий менеджер, консоль просто в цій теці й compose-дії. */

let editingProject = null;

async function loadProjects() {
  try { S.projects = await invoke("list_projects"); }
  catch { S.projects = []; }
  renderProjectBox();
  renderProjectList();
}

function renderProjectBox() {
  const box = $("projbox");
  if (!box) return;
  box.innerHTML = "";

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `${ic("folderCode")} ${t("proj.section")}` +
    `<span class="cnt">${visibleProjects().length}</span>` +
    `<span class="plus" title="${esc(t("proj.add"))}">${ic("plus")}</span>`;
  sec.onclick = e => {
    if (e.target.closest(".plus")) { openProjectModal(); return; }
    S.projCollapsed = !S.projCollapsed;
    persist();
    renderProjectBox();
  };
  box.appendChild(sec);

  if (S.projCollapsed) return;

  // Список привʼязаний до вибраного сервера: для проду — свої теки, для
  // стейджа — свої. Проєкти без сервера (створені раніше) видно скрізь.
  const shown = visibleProjects();
  if (!shown.length) {
    box.insertAdjacentHTML("beforeend",
      `<div class="hint" style="padding:8px 12px">${S.projects.length ? t("proj.emptyFor") : t("proj.empty")}</div>`);
    return;
  }

  const chips = document.createElement("div");
  chips.id = "projchips";
  for (const p of shown) {
    const chip = document.createElement("div");
    chip.className = "projchip" + (S.view === "project" && S.project?.id === p.id ? " active" : "");
    chip.title = p.remote ? `${profileById(p.conn)?.host ?? p.conn}:${p.path}` : p.path;
    chip.innerHTML = `${ic("folderCode", "sm")}<span class="nm">${esc(p.name)}</span>` +
      (p.remote ? `<span class="rem" title="${esc(t("proj.remote"))}">${ic("server", "sm")}</span>` : "");
    chip.onclick = () => openProject(p.id);
    chip.oncontextmenu = e => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { icon: "folderOpen", label: t("ctx.open"), run: () => openProject(p.id) },
        { icon: "terminal", label: t("proj.openTerm"), run: () => { openProject(p.id); S.projTab = "term"; renderDetail(); } },
        { icon: "link", label: t("ctx.copyPath"), run: () => copyText(p.path) },
        "-",
        { icon: "pencil", label: t("conn.edit"), run: () => openProjectModal(p) },
        { icon: "trash", label: t("common.delete"), danger: true, run: () => removeProject(p.id) },
      ]);
    };
    chips.appendChild(chip);
  }
  box.appendChild(chips);
}

async function openProject(id) {
  const p = S.projects.find(x => x.id === id);
  if (!p) return;
  if (p.remote && !S.conns[p.conn]?.up) {
    toast(t("proj.connectFirst", { name: profileById(p.conn)?.name ?? p.conn }), "warn", 5000);
    const ok = await connectProfile(p.conn, { silent: true });
    if (!ok) return;
  }
  S.project = p;
  S.projInfo = null;
  S.view = "project";
  S.selected = null;
  S.selectedStack = null;
  if (!["files", "term", "compose", "du"].includes(S.projTab)) S.projTab = "files";
  renderTree();
  renderDetail();
  // що є в теці (compose, Dockerfile, git) — вирішує, які дії показувати
  try {
    const info = p.remote
      ? await invoke("host_project_probe", { conn: p.conn, path: p.path })
      : await invoke("project_probe", { path: p.path });
    if (S.project?.id !== p.id) return;
    S.projInfo = info;
    renderProjectHeader();
    if (S.projTab === "compose") openProjectCompose();
  } catch {}
}

function renderProjectHeader() {
  const p = S.project;
  const info = S.projInfo;
  const h = $("detail-header");
  h.dataset.sig = "";
  h.innerHTML = `
    ${ic("folderCode", "big")}
    <span class="title">${esc(p.name)}</span>
    <span class="sub mono">${p.remote ? esc((profileById(p.conn)?.host ?? p.conn) + ":") : ""}${esc(p.path)}</span>
    <span id="proj-badges">${
      !info ? ""
      : !info.exists ? `<span class="badge" style="border-color:var(--red);color:var(--red)">${t("proj.missing")}</span>`
      : [
          info.compose ? `<span class="badge">${esc(info.compose)}</span>` : "",
          info.dockerfile ? `<span class="badge">Dockerfile</span>` : "",
          info.git ? `<span class="badge">git</span>` : "",
        ].join(" ")}</span>
    <span style="flex:1"></span>
    <button id="proj-term">${ic("terminal")} ${t("proj.openTerm")}</button>
    <button id="proj-edit" title="${esc(t("conn.edit"))}">${ic("pencil")}</button>`;
  $("proj-term").onclick = () => { S.projTab = "term"; renderDetail(); };
  $("proj-edit").onclick = () => openProjectModal(p);
}

/** Compose-панель для проєкту: ті самі кнопки, але з локальним docker. */
function openProjectCompose() {
  const p = S.project;
  S.composeCtx = {
    conn: projConn(),
    project: p.name,
    workdir: p.path,
    config: S.projInfo?.compose ? p.path + "/" + S.projInfo.compose : "",
    kind: p.remote ? "ssh" : "local",
  };
  const hasCompose = !!S.projInfo?.compose;
  $("cm-workdir").textContent = `${t("compose.workdir")}: ${p.path}` +
    (hasCompose ? "" : " · " + t("proj.noCompose"));
  ["cm-up", "cm-down", "cm-restart", "cm-pull", "cm-build"].forEach(id => $(id).disabled = !hasCompose);
  $("cm-edit-compose").disabled = !hasCompose;
  $("cm-edit-env").disabled = false;
}

/* ── список і форма ── */

function renderProjectList() {
  const box = $("project-list");
  if (!box) return;
  box.innerHTML = S.projects.length
    ? S.projects.map(p => `
      <div class="pitem">
        <span class="pname">${ic("folderCode", "sm")} ${esc(p.name)}</span>
        <span class="pdetail mono">${p.remote ? esc((profileById(p.conn)?.name ?? p.conn) + " · ") : ""}${esc(p.path)}</span>
        <button data-x="edit" data-id="${esc(p.id)}">${ic("pencil")}</button>
        <button data-x="del" data-id="${esc(p.id)}" class="danger">${ic("trash")}</button>
      </div>`).join("")
    : `<div class="hint">${t("proj.empty")}</div>`;
  box.querySelectorAll("button[data-x]").forEach(b => b.onclick = () => {
    const p = S.projects.find(x => x.id === b.dataset.id);
    if (!p) return;
    if (b.dataset.x === "edit") fillProjectForm(p);
    else removeProject(p.id);
  });
}

function visibleProjects() {
  return S.projects.filter(p => !p.conn || p.conn === S.activeConn);
}

function fillProjectForm(p) {
  editingProject = p;
  $("pj-title").textContent = p ? t("conn.edit") + ": " + p.name : t("proj.add");
  $("pj-path").value = p?.path ?? "";
  $("pj-name").value = p?.name ?? "";
  $("pj-where").value = p?.remote ? "remote" : "local";
  syncProjectWhere();
  // сервер за замовчуванням — той, що відкритий зараз
  const sel = $("pj-conn");
  sel.innerHTML = `<option value="">${esc(t("proj.allServers"))}</option>` +
    S.profiles.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  const want = p ? (p.conn ?? "") : (S.activeConn ?? "");
  sel.value = want;
  if (sel.value !== want) sel.value = "";
}

/** Підказки у формі залежать від того, де лежить тека. */
function syncProjectWhere() {
  const remote = $("pj-where").value === "remote";
  $("pj-path").placeholder = remote ? "/srv/myapp" : "E:\\work\\myapp";
  $("pj-pick").title = remote ? t("proj.pickRemote") : t("proj.pick");
  // серверній теці потрібен конкретний сервер — «усі сервери» тут не має сенсу
  const all = $("pj-conn").querySelector('option[value=""]');
  if (all) all.disabled = remote;
  if (remote && !$("pj-conn").value) $("pj-conn").value = S.activeConn ?? "";
}

/* ── оглядач тек на сервері ──
   Рідного діалогу по SSH не буває, тож свій: список підтек через того самого
   агента, що й файловий менеджер. */
let pdResolve = null;
let pdConn = null;

function pickRemoteFolder(conn, start) {
  return new Promise(resolve => {
    pdResolve = resolve;
    pdConn = conn;
    $("pd-where").textContent = "· " + (profileById(conn)?.name ?? conn);
    $("pickdir-modal").classList.add("open");
    pdOpen(start && start.startsWith("/") ? start : "/");
  });
}

async function pdOpen(path) {
  $("pd-path").value = path;
  $("pd-list").innerHTML = loadingBox(t("files.reading") + " " + path);
  try {
    const entries = await invoke("host_fs_list", { conn: pdConn, path });
    const dirs = entries.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    $("pd-list").innerHTML = dirs.length
      ? dirs.map(d => `<div class="pdrow" data-name="${esc(d.name)}">${ic("folder")} ${esc(d.name)}</div>`).join("")
      : `<div class="placeholder">${t("files.empty")}</div>`;
    $("pd-list").querySelectorAll(".pdrow").forEach(el =>
      el.onclick = () => pdOpen(joinPath($("pd-path").value, el.dataset.name)));
  } catch (e) {
    $("pd-list").innerHTML = errorBox(e);
  }
}

function wirePickDir() {
  $("pd-up").onclick = () => { const p = $("pd-path").value; if (p !== "/") pdOpen(parentPath(p)); };
  $("pd-path").onkeydown = e => { if (e.key === "Enter") pdOpen($("pd-path").value.trim() || "/"); };
  $("pd-ok").onclick = () => {
    $("pickdir-modal").classList.remove("open");
    pdResolve?.($("pd-path").value.trim().replace(/\/+$/, "") || "/");
    pdResolve = null;
  };
  // закрили хрестиком або Esc — без вибору
  document.querySelector('#pickdir-modal [data-close]').addEventListener("click", () => { pdResolve?.(null); pdResolve = null; });
}

/** Системний діалог вибору теки; null — користувач передумав. */
async function pickFolder(start) {
  try { return await invoke("pick_folder", { start: start || null }); }
  catch (e) { toast(String(e)); return null; }
}

function openProjectModal(p = null) {
  fillProjectForm(p);
  renderProjectList();
  $("project-modal").classList.add("open");
  setTimeout(() => $("pj-path").focus(), 60);
}

async function removeProject(id) {
  const p = S.projects.find(x => x.id === id);
  if (!(await ask({ title: t("proj.removeQ"), text: esc(p?.name ?? ""), okLabel: t("common.delete") }))) return;
  S.projects = await invoke("delete_project", { id });
  if (S.project?.id === id) { S.project = null; S.view = "welcome"; renderDetail(); }
  renderProjectBox();
  renderProjectList();
}

function wireProjectUI() {
  $("pj-save").onclick = async () => {
    const path = $("pj-path").value.trim().replace(/[\\]/g, "/").replace(/\/+$/, "");
    if (!path) return toast(t("proj.needPath"));
    try {
      S.projects = await invoke("save_project", {
        project: {
          id: editingProject?.id ?? "", name: $("pj-name").value.trim(), path,
          conn: $("pj-conn").value, remote: $("pj-where").value === "remote",
        },
      });
      editingProject = null;
      fillProjectForm(null);
      renderProjectBox();
      renderProjectList();
      toast(t("conn.saved"), "ok", 2500);
    } catch (e) { toast(String(e)); }
  };
  $("pj-path").onkeydown = e => { if (e.key === "Enter") $("pj-save").click(); };
  $("pj-where").onchange = syncProjectWhere;
  wirePickDir();
  $("pj-pick").onclick = async () => {
    const remote = $("pj-where").value === "remote";
    let dir;
    if (remote) {
      const conn = $("pj-conn").value;
      if (!conn) return toast(t("proj.needServer"), "warn", 4000);
      if (!S.conns[conn]?.up) return toast(t("proj.connectFirst", { name: profileById(conn)?.name ?? conn }), "warn", 5000);
      dir = await pickRemoteFolder(conn, $("pj-path").value.trim());
    } else {
      dir = await pickFolder($("pj-path").value.trim());
    }
    if (!dir) return;
    $("pj-path").value = dir;
    if (!$("pj-name").value.trim()) $("pj-name").value = dir.split("/").filter(Boolean).pop() ?? "";
  };
}
