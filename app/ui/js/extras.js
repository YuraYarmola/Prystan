"use strict";
/* Шари образу, diff контейнера, ліміти, сканування, реєстри, журнал, Telegram */

/* ═══ 1. Шари образу ═══ */
async function showLayers(image) {
  const tag = image.tags?.[0] || image.id.replace("sha256:", "").slice(0, 12);
  $("layers-title").textContent = "· " + tag;
  $("layers-body").innerHTML = `<div class="placeholder"><span class="spin"></span></div>`;
  $("layers-modal").classList.add("open");
  try {
    const layers = await invoke("image_history", { conn: S.activeConn, id: image.id });
    const total = layers.reduce((a, l) => a + (l.size || 0), 0);
    const rows = layers.map((l, i) => {
      const cmd = (l.created_by || "")
        .replace(/^\/bin\/sh -c #\(nop\)\s*/, "")
        .replace(/^\/bin\/sh -c\s*/, "RUN ");
      const pct = total ? (l.size / total * 100) : 0;
      return `<tr>
        <td class="mono" style="text-align:right;color:var(--dim)">${layers.length - i}</td>
        <td style="text-align:right;${l.size > 100 * 1024 * 1024 ? "color:var(--yellow);font-weight:600" : ""}">${l.size ? fmtBytes(l.size) : "—"}</td>
        <td style="width:90px"><div class="meter" style="margin:0"><i style="width:${pct.toFixed(0)}%"></i></div></td>
        <td class="grow mono" style="font-size:11px">${esc(cmd.slice(0, 300))}</td>
        <td class="hint">${l.created ? fmtAgo(l.created) : ""}</td>
      </tr>`;
    }).join("");
    $("layers-body").innerHTML = `
      <div style="padding:10px 14px" class="hint">${t("img.layersTotal", { n: layers.length, size: fmtBytes(total) })}</div>
      <table class="grid">
        <thead><tr><th style="text-align:right">#</th><th style="text-align:right">${t("files.size")}</th><th></th>
        <th>${t("img.command")}</th><th>${t("insp.created")}</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
  } catch (e) {
    $("layers-body").innerHTML = `<div class="placeholder">⚠ ${esc(String(e))}</div>`;
  }
}

/* ═══ 2. Diff файлової системи контейнера ═══ */
async function loadDiff() {
  const box = $("diff-body");
  if (!box) return;
  box.innerHTML = `<div class="placeholder"><span class="spin"></span></div>`;
  try {
    const list = await invoke("container_diff", { conn: S.activeConn, id: S.selected.id });
    if (!list.length) {
      box.innerHTML = `<div class="hint" style="padding:8px 0">${t("diff.none")}</div>`;
      return;
    }
    const ico = { added: ["A", "var(--green)"], modified: ["C", "var(--yellow)"], deleted: ["D", "var(--red)"] };
    const counts = { added: 0, modified: 0, deleted: 0 };
    list.forEach(c => counts[c.kind]++);
    const rows = list.slice(0, 3000).map(c => {
      const [ch, color] = ico[c.kind] || ["?", "var(--dim)"];
      return `<div class="mono" style="font-size:11.5px"><span style="color:${color};font-weight:700">${ch}</span> ${esc(c.path)}</div>`;
    }).join("");
    box.innerHTML = `
      <div class="hint" style="margin-bottom:6px">
        <span style="color:var(--green)">A ${counts.added}</span> ·
        <span style="color:var(--yellow)">C ${counts.modified}</span> ·
        <span style="color:var(--red)">D ${counts.deleted}</span>
        ${list.length > 3000 ? " · " + t("diff.truncated") : ""}
      </div>
      <pre style="max-height:340px">${rows}</pre>`;
  } catch (e) {
    box.innerHTML = `<div class="placeholder">⚠ ${esc(String(e))}</div>`;
  }
}

/* ═══ 3. Ліміти CPU/RAM ═══ */
async function applyLimits() {
  const c = S.selected;
  if (!c || !guardRW("guard.limits")) return;
  const cpus = parseFloat($("lim-cpus").value);
  const mem = parseInt($("lim-mem").value);
  try {
    await invoke("update_resources", {
      conn: S.activeConn, id: c.id,
      cpus: isNaN(cpus) ? null : cpus,
      memoryMb: isNaN(mem) ? null : mem,
      memorySwapMb: null,
      cpuShares: null,
    });
    toast(t("lim.applied"), "ok", 4000);
    openInspect();
  } catch (e) { toast("limits: " + e); }
}

/* ═══ 4. Сканування вразливостей ═══ */
let scanData = null;

async function scanImage(image) {
  const tag = image.tags?.[0] || image.id.replace("sha256:", "").slice(0, 19);
  scanData = null;
  $("scan-title").textContent = "· " + tag;
  $("scan-tools").style.display = "none";
  $("scan-body").innerHTML = "";
  $("scan-summary").innerHTML = `<span class="spin"></span> ${t("scan.starting")}`;
  $("scan-modal").classList.add("open");
  try {
    const r = await invoke("scan_image", { conn: S.activeConn, image: tag });
    scanData = r;
    renderScan();
  } catch (e) {
    $("scan-summary").innerHTML = `<div class="placeholder">⚠ ${esc(String(e))}</div>`;
  }
}

listen("scan-progress", ev => {
  if (ev.payload.conn !== S.activeConn) return;
  const el = $("scan-summary");
  if (el && !scanData) el.innerHTML = `<span class="spin"></span> ${esc(ev.payload.line)}`;
});

function renderScan() {
  const r = scanData;
  if (!r) return;
  const card = (label, n, color) =>
    `<div class="statcard" style="padding:8px 12px;${n ? `border-color:${color}` : ""}">
      <div class="sc-label">${label}</div><div class="sc-value" style="font-size:18px;color:${n ? color : "var(--dim)"}">${n}</div></div>`;
  $("scan-summary").innerHTML = `<div class="statgrid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">
    ${card("CRITICAL", r.critical, "var(--red)")}
    ${card("HIGH", r.high, "#ff7b45")}
    ${card("MEDIUM", r.medium, "var(--yellow)")}
    ${card("LOW", r.low, "var(--dim)")}
    ${card(t("scan.fixable"), r.fixable, "var(--green)")}
  </div>`;
  $("scan-tools").style.display = r.total ? "flex" : "none";
  renderScanTable();
}

function renderScanTable() {
  const r = scanData;
  if (!r) return;
  const f = $("scan-filter").value.toLowerCase();
  const sev = $("scan-sev").querySelector("button.on")?.dataset.s ?? "all";
  const list = r.vulns.filter(v => {
    if (sev === "fix" && !v.fixed) return false;
    if (sev !== "all" && sev !== "fix" && v.severity !== sev) return false;
    if (f && !(v.id + v.pkg + v.title).toLowerCase().includes(f)) return false;
    return true;
  });
  const color = s => ({ CRITICAL: "var(--red)", HIGH: "#ff7b45", MEDIUM: "var(--yellow)" }[s] || "var(--dim)");
  if (!r.total) {
    $("scan-body").innerHTML = `<div class="placeholder" style="color:var(--green)">✓ ${t("scan.clean")}</div>`;
    return;
  }
  $("scan-body").innerHTML = `<table class="grid">
    <thead><tr><th>CVE</th><th>${t("scan.severity")}</th><th>${t("scan.package")}</th>
    <th>${t("scan.installed")}</th><th>${t("scan.fixedIn")}</th><th>${t("scan.title2")}</th></tr></thead>
    <tbody>${list.slice(0, 500).map(v => `
      <tr>
        <td class="mono">${v.url ? `<a class="lnk" data-url="${esc(v.url)}">${esc(v.id)}</a>` : esc(v.id)}</td>
        <td style="color:${color(v.severity)};font-weight:600">${esc(v.severity)}</td>
        <td>${esc(v.pkg)}</td>
        <td class="mono">${esc(v.installed)}</td>
        <td class="mono" style="color:${v.fixed ? "var(--green)" : "var(--dim)"}">${esc(v.fixed || "—")}</td>
        <td class="grow" style="font-size:11.5px">${esc((v.title || "").slice(0, 140))}</td>
      </tr>`).join("")}</tbody></table>
    ${list.length > 500 ? `<div class="hint" style="padding:8px 12px">${t("scan.shown500")}</div>` : ""}`;
  $("scan-body").querySelectorAll("a.lnk").forEach(a =>
    a.onclick = () => invoke("open_url", { url: a.dataset.url }).catch(() => {}));
}

/* ═══ 5. Реєстри + push ═══ */
async function renderRegistries() {
  const list = await invoke("registry_list");
  const box = $("registry-list");
  box.innerHTML = list.length
    ? list.map(s => `<div class="pitem"><span class="pname">🔑 ${esc(s)}</span><span class="pdetail"></span>
        <button data-rg="${esc(s)}" class="danger">🗑</button></div>`).join("")
    : `<div class="hint">${t("reg.empty")}</div>`;
  box.querySelectorAll("button[data-rg]").forEach(b => b.onclick = async () => {
    await invoke("registry_delete", { server: b.dataset.rg });
    renderRegistries();
  });
}

async function pushImage(image) {
  const tag = image.tags?.[0];
  if (!tag || tag.includes("<none>")) return toast(t("img.needTag"), "warn", 4000);
  if (!guardRW("guard.push")) return;
  const target = await ask({ title: t("img.push"), text: t("img.pushHint"), input: tag, okLabel: t("img.push") });
  if (!target) return;
  const log = $("pull-log");
  log.style.display = "block";
  log.textContent = `⇧ push ${target}\n`;
  try { await invoke("push_image", { conn: S.activeConn, tag: target }); }
  catch (e) { toast("push: " + e, "err", 8000); }
}

listen("push-progress", ev => {
  if (ev.payload.conn !== S.activeConn) return;
  const log = $("pull-log");
  log.style.display = "block";
  const lines = log.textContent.split("\n");
  const line = ev.payload.line;
  if (line && lines[lines.length - 1]?.startsWith(line.split(" ")[0])) lines[lines.length - 1] = line;
  else lines.push(line);
  log.textContent = lines.slice(-25).join("\n");
  log.scrollTop = log.scrollHeight;
});

/* ═══ 6. Журнал дій ═══ */
let journalData = [];

async function openJournal() {
  const box = $("jr-table");
  box.innerHTML = `<div class="placeholder"><span class="spin"></span></div>`;
  try {
    journalData = await invoke("journal_list", { limit: 800 });
    renderJournal();
  } catch (e) { box.innerHTML = `<div class="placeholder">⚠ ${esc(String(e))}</div>`; }
}

function renderJournal() {
  const f = $("jr-filter").value.toLowerCase();
  const list = journalData.filter(e =>
    !f || (e.action + e.target + e.conn + e.detail).toLowerCase().includes(f));
  const nameOf = id => S.profiles.find(p => p.id === id)?.name ?? id ?? "";
  $("jr-count").textContent = `${list.length} / ${journalData.length}`;
  $("jr-table").innerHTML = `<table class="grid">
    <thead><tr><th style="width:150px">${t("jr.time")}</th><th>${t("jr.conn")}</th>
    <th>${t("jr.action")}</th><th>${t("jr.target")}</th><th>${t("jr.detail")}</th></tr></thead>
    <tbody>${list.slice(0, 500).map(e => `
      <tr>
        <td class="mono">${new Date(e.ts * 1000).toLocaleString()}</td>
        <td>${esc(nameOf(e.conn))}</td>
        <td><span style="color:${e.ok ? "var(--text)" : "var(--red)"}">${e.ok ? "" : "✗ "}${esc(e.action)}</span></td>
        <td class="mono">${esc(e.target)}</td>
        <td class="grow hint">${esc((e.detail || "").slice(0, 120))}</td>
      </tr>`).join("")}</tbody></table>`;
}

/* ═══ 7. Telegram ═══ */
async function openSettings() {
  const st = await invoke("tg_status");
  $("tg-chat").value = st.chat_id || "";
  $("tg-token").value = "";
  $("tg-token").placeholder = st.configured ? "•••••• (" + t("set.saved") + ")" : "123456:AA...";
  $("tg-state").textContent = st.configured ? "✓ " + t("set.saved") : t("set.notSet");
  $("tg-on-alerts").checked = !!S.tgAlerts;
  $("settings-modal").classList.add("open");
}

/** Надіслати алерт у Telegram, якщо увімкнено. */
function tgAlert(text) {
  if (!S.tgAlerts) return;
  invoke("tg_send", { text }).catch(() => {});
}

function wireExtras() {
  /* diff + ліміти живуть усередині Inspect — обробники вішаються там */
  $("scan-filter").oninput = renderScanTable;
  $("scan-sev").querySelectorAll("button").forEach(b => b.onclick = () => {
    $("scan-sev").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    renderScanTable();
  });

  $("registry-btn").onclick = () => { renderRegistries(); $("registry-modal").classList.add("open"); };
  $("rg-save").onclick = async () => {
    const server = $("rg-server").value.trim(), user = $("rg-user").value.trim(), pass = $("rg-pass").value;
    if (!server || !user || !pass) return toast(t("reg.needAll"));
    try {
      await invoke("registry_save", { server, username: user, password: pass });
      $("rg-server").value = $("rg-user").value = $("rg-pass").value = "";
      renderRegistries();
      toast(t("reg.saved"), "ok", 3000);
    } catch (e) { toast("registry: " + e); }
  };

  $("jr-filter").oninput = renderJournal;
  $("jr-refresh").onclick = openJournal;
  $("jr-clear").onclick = async () => {
    if (!(await ask({ title: t("jr.clearQ"), text: t("jr.clearText"), okLabel: t("logs.clear") }))) return;
    await invoke("journal_clear");
    openJournal();
  };

  $("settings-btn").onclick = openSettings;
  $("tg-save").onclick = async () => {
    const token = $("tg-token").value.trim(), chat = $("tg-chat").value.trim();
    if (!token || !chat) return toast(t("set.needBoth"));
    try {
      await invoke("tg_save", { token, chatId: chat });
      $("tg-state").textContent = "✓ " + t("set.saved");
      $("tg-token").value = "";
      toast(t("set.saved"), "ok", 3000);
    } catch (e) { toast("telegram: " + e); }
  };
  $("tg-test").onclick = async () => {
    try {
      await invoke("tg_send", { text: `⚓ Prystan: ${t("set.testMsg")}` });
      toast(t("set.testSent"), "ok", 4000);
    } catch (e) { toast("telegram: " + e, "err", 8000); }
  };
  $("tg-forget").onclick = async () => {
    try { await invoke("tg_forget"); $("tg-state").textContent = t("set.notSet"); $("tg-chat").value = ""; }
    catch (e) { toast("telegram: " + e); }
  };
  $("tg-on-alerts").onchange = e => { S.tgAlerts = e.target.checked; persist(); };
}
