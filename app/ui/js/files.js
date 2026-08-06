"use strict";
/* Файли (контейнер і хост) + редактор */

function curPath() {
  return S.filesPath[targetKey()] || (isHostView() ? (activeProfile()?.kind === "local" ? "C:/" : "/") : "/");
}
function setPath(p) { S.filesPath[targetKey()] = p; }

function fsInvoke(op, extra = {}) {
  if (isHostView()) return invoke("host_" + op, { conn: S.activeConn, ...extra });
  return invoke(op, { conn: S.activeConn, id: S.selected.id, ...extra });
}

async function openFiles() {
  $("fs-path").value = curPath();
  const box = $("files-table");
  box.innerHTML = `<div class="placeholder"><span class="spin"></span> ${t("files.reading")} ${esc(curPath())}…</div>`;
  try {
    const entries = await fsInvoke("fs_list", { path: curPath() });
    S.lastEntries = entries;
    renderFiles(entries);
  } catch (e) {
    box.innerHTML = `<div class="placeholder">⚠ ${esc(String(e))}${!isHostView() && S.selected?.state !== "running" ? "<br><br>" + t("files.stoppedHint") : ""}</div>`;
  }
}

function renderFiles(allEntries) {
  const box = $("files-table");
  const ff = $("fs-filter").value.toLowerCase();
  const entries = ff ? allEntries.filter(e => e.name.toLowerCase().includes(ff)) : allEntries;
  const rows = entries.map(e => `
    <tr class="clickable" data-name="${esc(e.name)}" data-dir="${e.is_dir}">
      <td>${e.is_dir ? "📁" : e.is_link ? "🔗" : "📄"} ${esc(e.name)}</td>
      <td style="text-align:right">${e.is_dir ? "" : fmtBytes(e.size)}</td>
      <td class="mono">${esc(e.perms)}</td>
      <td class="mono">${esc(e.owner)}</td>
      <td><div class="racts">
        ${!e.is_dir ? `<button data-f="edit" title="${t("files.edit")}">✎</button>` : ""}
        <button data-f="dl" title="${t("files.download")}">⇩</button>
        <button data-f="mv" title="${t("files.rename")}">✏</button>
        ${isHostView() && activeProfile()?.kind === "ssh" ? `<button data-f="chmod" title="${t("files.chmod")}">🔑</button>` : ""}
        <button data-f="del" class="danger" title="${t("files.delete")}">🗑</button>
      </div></td>
    </tr>`).join("");
  box.innerHTML = `<table class="grid">
    <thead><tr><th>${t("files.name")}</th><th style="text-align:right">${t("files.size")}</th><th>${t("files.perms")}</th><th>${t("files.owner")}</th><th style="width:150px"></th></tr></thead>
    <tbody>${curPath() !== "/" ? `<tr class="clickable" data-up="1"><td>📁 ..</td><td></td><td></td><td></td><td></td></tr>` : ""}${rows}</tbody>
  </table>${entries.length === 0 ? `<div class="placeholder">${allEntries.length ? t("files.noMatch") : t("files.empty")}</div>` : ""}`;

  box.querySelectorAll("tr.clickable").forEach(tr => {
    tr.ondblclick = () => nav(tr);
    tr.onclick = e => {
      const f = e.target.dataset?.f;
      if (!f) return;
      const full = joinPath(curPath(), tr.dataset.name);
      if (f === "dl") downloadPath(full);
      if (f === "edit") openEditor(full);
      if (f === "del") deletePath(full);
      if (f === "mv") renamePath(full, tr.dataset.name);
      if (f === "chmod") chmodPath(full);
    };
  });

  function nav(tr) {
    if (tr.dataset.up) { setPath(parentPath(curPath())); openFiles(); return; }
    if (tr.dataset.dir === "true") { setPath(joinPath(curPath(), tr.dataset.name)); openFiles(); }
    else openEditor(joinPath(curPath(), tr.dataset.name));
  }
}

async function downloadPath(full) {
  toast(t("files.download") + " " + full + "…", "ok", 2000);
  try {
    const saved = await fsInvoke("fs_download", { path: full });
    toast(t("files.saved") + ": " + saved, "ok", 6000);
  } catch (e) { toast("Download: " + e); }
}

async function deletePath(full) {
  if (!guardRW("guard.delete")) return;
  if (!(await ask({ title: t("files.deleteQ"), text: `<b>${esc(full)}</b> ` + t("files.deleteText", { where: isHostView() ? t("files.onServer") : t("files.inContainer") }), okLabel: t("common.delete") }))) return;
  try { await fsInvoke("fs_delete", { path: full }); openFiles(); }
  catch (e) { toast("Видалення: " + e); }
}

/* B5 — перейменування */
async function renamePath(full, name) {
  if (!guardRW("guard.rename")) return;
  const to = await ask({ title: t("files.rename"), text: esc(full), input: name, okLabel: t("files.rename") });
  if (!to || to === name) return;
  const target = to.includes("/") ? to : joinPath(curPath(), to);
  try { await fsInvoke("fs_rename", { from: full, to: target }); openFiles(); }
  catch (e) { toast("Перейменування: " + e); }
}

/* B5 — chmod */
async function chmodPath(full) {
  if (!guardRW("guard.chmod")) return;
  const mode = await ask({ title: t("files.chmod"), text: t("files.modeOctal") + ` <b>${esc(full)}</b>`, input: "644", okLabel: "chmod" });
  if (!mode) return;
  try { await fsInvoke("fs_chmod", { path: full, mode }); openFiles(); }
  catch (e) { toast("chmod: " + e); }
}

async function uploadFiles(fileList) {
  if (!guardRW("guard.upload")) return;
  for (const file of fileList) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      await fsInvoke("fs_upload", { dir: curPath(), filename: file.name, contentB64: u8ToB64(buf) });
      toast(`⇪ ${file.name} → ${curPath()}`, "ok", 3000);
    } catch (err) { toast(`Upload ${file.name}: ${err}`); }
  }
  openFiles();
}

function wireFilesUI() {
  $("fs-path").onkeydown = e => {
    if (e.key === "Enter") {
      const v = $("fs-path").value.trim();
      if (v) { setPath(v.length > 1 ? v.replace(/\/+$/, "") : v); openFiles(); }
    }
    if (e.key === "Escape") $("fs-path").value = curPath();
  };
  $("fs-up").onclick = () => { setPath(parentPath(curPath())); openFiles(); };
  $("fs-copy").onclick = () => { navigator.clipboard.writeText(curPath()); toast(t("files.copied") + ": " + curPath(), "ok", 2000); };
  $("fs-filter").oninput = () => renderFiles(S.lastEntries);
  $("fs-refresh").onclick = () => openFiles();
  $("fs-mkdir").onclick = async () => {
    if (!guardRW("guard.mkdir")) return;
    const name = await ask({ title: t("files.mkdir"), text: t("files.newDirName") + " " + esc(curPath()), input: "", okLabel: t("files.create") });
    if (!name) return;
    try { await fsInvoke("fs_mkdir", { path: joinPath(curPath(), name) }); openFiles(); }
    catch (e) { toast("mkdir: " + e); }
  };
  $("fs-upload-btn").onclick = () => $("fs-upload-input").click();
  $("fs-upload-input").onchange = async e => { await uploadFiles(e.target.files); e.target.value = ""; };

  /* B5 — drag & drop із провідника */
  const pane = $("pane-files");
  pane.addEventListener("dragover", e => { e.preventDefault(); pane.classList.add("dragging"); });
  pane.addEventListener("dragleave", e => { if (e.target === pane || !pane.contains(e.relatedTarget)) pane.classList.remove("dragging"); });
  pane.addEventListener("drop", async e => {
    e.preventDefault();
    pane.classList.remove("dragging");
    if (e.dataTransfer?.files?.length) await uploadFiles(e.dataTransfer.files);
  });
}

/* ═══ редактор ═══ */
const MODE_BY_EXT = {
  js: "javascript", mjs: "javascript", json: "application/json", ts: "javascript",
  py: "python", sh: "shell", bash: "shell", env: "properties", ini: "properties",
  properties: "properties", yml: "yaml", yaml: "yaml", xml: "xml", html: "htmlmixed",
  htm: "htmlmixed", css: "css", conf: "nginx", sql: "sql", md: "markdown",
  dockerfile: "dockerfile", txt: null, log: null,
};
function modeFor(path) {
  const base = path.split("/").pop().toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "nginx.conf") return "nginx";
  if (base.startsWith(".env")) return "properties";
  if (base.includes("compose") && /\.(yml|yaml)$/.test(base)) return "yaml";
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return MODE_BY_EXT[ext] ?? null;
}

async function openEditor(path, target = null) {
  target = target ?? (isHostView() ? "host" : "container");
  const inv = (op, extra) => target === "host"
    ? invoke("host_" + op, { conn: S.activeConn, ...extra })
    : invoke(op, { conn: S.activeConn, id: S.selected.id, ...extra });
  try {
    const r = await inv("fs_read", { path });
    if (r.binary) {
      if (await ask({ title: t("editor.binary"), text: t("editor.binaryText", { path: esc(path), size: fmtBytes(r.size) }), okLabel: "⇩ Download" }))
        downloadPath(path);
      return;
    }
    S.editorCtx = { path, truncated: r.truncated, target };
    $("editor-title").textContent = (target === "host" ? "🖥 " : "📦 ") + path + ` (${fmtBytes(r.size)})`;
    $("editor-note").textContent = r.truncated ? t("editor.truncated") : (isReadonly() ? t("editor.roProfile") : "");
    $("editor-save").disabled = r.truncated || isReadonly();
    $("editor-modal").classList.add("open");
    if (!S.editor) {
      S.editor = CodeMirror.fromTextArea($("editor-ta"), {
        lineNumbers: true, theme: "material-darker", indentUnit: 2, viewportMargin: 50,
      });
      S.editor.setSize("100%", "100%");
      S.editor.setOption("extraKeys", { "Ctrl-S": saveEditor, "Ctrl-F": () => $("editor-search").focus() });
      S.editor.on("change", () => {
        if (S._settingValue) return;
        S.editorDirty = true;
        $("editor-dirty").style.display = "inline";
      });
    }
    S.editor.setOption("mode", modeFor(path));
    S._settingValue = true;
    S.editor.setValue(b64ToStr(r.content_b64));
    S._settingValue = false;
    S.editorDirty = false;
    $("editor-dirty").style.display = "none";
    $("editor-search").value = "";
    $("editor-search-cnt").textContent = "";
    setTimeout(() => S.editor.refresh(), 60);
  } catch (e) { toast("Відкриття: " + e); }
}

async function saveEditor() {
  const ctx = S.editorCtx;
  if (!ctx || ctx.truncated) return;
  if (!guardRW("guard.saveFile")) return;
  const inv = (op, extra) => ctx.target === "host"
    ? invoke("host_" + op, { conn: S.activeConn, ...extra })
    : invoke(op, { conn: S.activeConn, id: S.selected.id, ...extra });
  try {
    // B6 — бекап .bak перед записом
    const backup = $("editor-backup").checked;
    if (backup && ctx.target === "host") {
      await invoke("host_fs_read", { conn: S.activeConn, path: ctx.path })
        .then(r => invoke("host_fs_write", { conn: S.activeConn, path: ctx.path + ".bak", contentB64: r.content_b64 }))
        .catch(() => {});
    }
    await inv("fs_write", { path: ctx.path, contentB64: strToB64(S.editor.getValue()), backup: ctx.target === "container" ? backup : undefined });
    S.editorDirty = false;
    $("editor-dirty").style.display = "none";
    toast("💾 " + t("files.saved") + ": " + ctx.path + (backup ? " (.bak)" : ""), "ok", 3000);
  } catch (e) { toast("Збереження: " + e); }
}

let edCursor = null;
function edFind(dir) {
  const q = $("editor-search").value;
  if (!q || !S.editor) return;
  const total = S.editor.getValue().toLowerCase().split(q.toLowerCase()).length - 1;
  if (!edCursor) edCursor = S.editor.getSearchCursor(q, S.editor.getCursor(), { caseFold: true });
  let found = dir === "prev" ? edCursor.findPrevious() : edCursor.findNext();
  if (!found) {
    edCursor = S.editor.getSearchCursor(q, dir === "prev" ? { line: S.editor.lineCount() - 1 } : { line: 0, ch: 0 }, { caseFold: true });
    found = dir === "prev" ? edCursor.findPrevious() : edCursor.findNext();
  }
  if (found) {
    S.editor.setSelection(edCursor.from(), edCursor.to());
    S.editor.scrollIntoView({ from: edCursor.from(), to: edCursor.to() }, 60);
  }
  $("editor-search-cnt").textContent = total ? t("editor.found", { n: total }) : t("editor.notFound");
}

async function closeEditor() {
  if (S.editorDirty) {
    const yes = await ask({ title: t("editor.unsaved"), text: t("editor.unsavedText", { path: esc(S.editorCtx?.path ?? "") }), okLabel: t("editor.close") });
    if (!yes) return;
  }
  $("editor-modal").classList.remove("open");
  S.editorDirty = false;
}

function wireEditorUI() {
  $("editor-save").onclick = saveEditor;
  $("editor-download").onclick = () => S.editorCtx && downloadPath(S.editorCtx.path);
  $("editor-search").oninput = () => { edCursor = null; edFind("next"); };
  $("editor-search").onkeydown = e => {
    if (e.key === "Enter") edFind(e.shiftKey ? "prev" : "next");
    if (e.key === "Escape") { $("editor-search").value = ""; $("editor-search-cnt").textContent = ""; S.editor.focus(); }
  };
  $("editor-prev").onclick = () => edFind("prev");
  $("editor-next").onclick = () => edFind("next");
  $("editor-close").onclick = closeEditor;
}
