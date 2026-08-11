"use strict";
/* Підключення: профілі, чіпи, імпорт контекстів, port-forward */

let editingProfile = null;
const retry = {};   // id -> { timer, attempt }

async function loadProfiles() {
  S.profiles = await invoke("list_profiles");
  renderConnBox();
  renderProfileList();
}

/**
 * @param {string} id
 * @param {object} opts  silent — без тостів і перемикання (фонове відновлення)
 *                       manual — користувач натиснув сам (вмикає autoconnect)
 */
async function connectProfile(id, opts = {}) {
  const p = S.profiles.find(x => x.id === id);
  if (!p) return false;
  if (S.conns[id]?.up || S.conns[id]?.connecting) return true;

  S.conns[id] = { connecting: true };
  renderConnBox();
  try {
    const info = await invoke("connect", { profileId: id });
    // Демон може бути не встановлений — сервер від цього не стає непридатним:
    // файли, консоль і моніторинг працюють, а Docker чекаємо окремо.
    S.conns[id] = { up: true, info, dockerOk: !!info.docker_ok, dockerError: info.docker_error };
    clearRetry(id);
    if (opts.manual !== false) await setWanted(id, true);
    if (!opts.silent) {
      toast(info.docker_ok
        ? `${t("conn.connectedTo")}: ${p.name} (Docker ${info.version})`
        : `${p.name}: ${t("conn.noDocker")}`, info.docker_ok ? "ok" : "warn", info.docker_ok ? 3000 : 7000);
      switchConn(id);
    } else {
      renderConnBox();
      if (S.activeConn === id) refreshAll();
    }
    if (!info.docker_ok) armDockerProbe();
    return true;
  } catch (e) {
    delete S.conns[id];
    renderConnBox();
    if (!opts.silent) toast(`${p.name}: ${e}`);
    if (p.autoconnect) scheduleRetry(id);
    return false;
  }
}

/** Ручне відключення: запамʼятовуємо намір і більше не піднімаємо само. */
async function disconnectProfile(id) {
  clearRetry(id);
  await setWanted(id, false);
  try { await invoke("disconnect", { id }); } catch {}
  delete S.conns[id];
  if (S.activeConn === id) {
    S.activeConn = null;
    S.selected = null; S.selectedStack = null; S.view = "welcome";
    $("engine").textContent = "";
    $("ro-badge").style.display = "none";
    renderDetail();
  }
  renderTree(); renderProfileList();
  toast(`${t("conn.disconnected")}: ${S.profiles.find(p => p.id === id)?.name ?? id}`, "ok", 2500);
}

async function setWanted(id, on) {
  const p = S.profiles.find(x => x.id === id);
  if (!p || p.autoconnect === on) return;
  S.profiles = await invoke("set_autoconnect", { id, on });
}

/* автовідновлення з наростаючою паузою: 5с → 10 → 20 → 40 → 60 (стеля) */
function scheduleRetry(id) {
  const p = S.profiles.find(x => x.id === id);
  if (!p?.autoconnect) return;
  const r = (retry[id] ||= { attempt: 0, timer: null });
  if (r.timer) return;
  r.attempt = Math.min(r.attempt + 1, 5);
  const delay = Math.min(60000, 5000 * Math.pow(2, r.attempt - 1));
  r.timer = setTimeout(async () => {
    r.timer = null;
    if (!S.profiles.find(x => x.id === id)?.autoconnect) return;
    const ok = await connectProfile(id, { silent: true, manual: false });
    if (ok) toast(`${t("conn.restored")}: ${p.name}`, "ok", 3000);
  }, delay);
  renderConnBox();
}

function clearRetry(id) {
  if (retry[id]?.timer) clearTimeout(retry[id].timer);
  delete retry[id];
}

/** Втратили зʼєднання (обрив тунелю / демон помер) — піднімаємо, якщо хотіли бути онлайн. */
function markDown(id, reason) {
  if (!S.conns[id]) return;
  delete S.conns[id];
  renderConnBox();
  const p = S.profiles.find(x => x.id === id);
  if (p?.autoconnect) {
    toast(`${p.name}: ${reason} — ${t("conn.reconnecting")}`, "warn", 4000);
    scheduleRetry(id);
  }
}

/* ── стан «сервер є, Docker немає» ──
   Демон могли не встановити, вимкнути або він ще піднімається після
   перезавантаження. Рвати через це підключення немає сенсу: сервером і далі
   можна користуватись, а демон ми перевіряємо самі, поки він не з'явиться. */
let probeTimer = null;

function armDockerProbe() {
  if (probeTimer) return;
  probeTimer = setInterval(() => {
    const waiting = Object.values(S.conns).some(c => c.up && !c.dockerOk);
    if (!waiting) { clearInterval(probeTimer); probeTimer = null; return; }
    if (document.visibilityState === "visible") probeDockerAll();
  }, 15000);
}

async function probeDockerAll() {
  for (const id of Object.keys(S.conns)) {
    if (S.conns[id]?.up && !S.conns[id].dockerOk) await probeDocker(id, false);
  }
}

/**
 * @param {string} id
 * @param {boolean} manual — користувач натиснув «перевірити зараз»
 */
async function probeDocker(id, manual) {
  const c = S.conns[id];
  if (!c?.up) return;
  try {
    const info = await invoke("docker_probe", { conn: id });
    const was = c.dockerOk;
    c.dockerOk = !!info.docker_ok;
    c.dockerError = info.docker_error;
    if (info.docker_ok) c.info = { ...c.info, ...info };
    if (id === S.activeConn) renderEngineLabel();
    if (info.docker_ok && !was) {
      const name = S.profiles.find(p => p.id === id)?.name ?? id;
      toast(t("conn.dockerBack", { name }), "ok", 5000);
      if (id === S.activeConn) { S.loading = true; renderTree(); renderDetail(); refreshAll(); }
      else renderConnBox();
      return;
    }
    if (manual && !info.docker_ok) toast(info.docker_error || t("conn.noDocker"), "warn", 6000);
    renderTree();
  } catch (e) {
    // підключення зникло зовсім — це вже інша історія
    markDown(id, String(e));
  }
}

/** Підняти всі зʼєднання, позначені autoconnect (старт застосунку). */
async function restoreConnections() {
  const wanted = S.profiles.filter(p => p.autoconnect);
  if (!wanted.length) return [];
  const res = await Promise.all(wanted.map(p => connectProfile(p.id, { silent: true, manual: false })));
  const okIds = wanted.filter((_, i) => res[i]).map(p => p.id);
  const failed = wanted.length - okIds.length;
  if (okIds.length) toast(t("conn.restoredN", { n: okIds.length }), "ok", 3000);
  if (failed) toast(t("conn.failedN", { n: failed }), "warn", 5000);
  return okIds;
}

function switchConn(id) {
  const changed = S.activeConn !== id;
  S.activeConn = id;
  S.selected = null; S.selectedStack = null; S.view = "welcome";
  S.bulkSel.clear();
  if (changed) {
    // дані попереднього сервера більше не дійсні: інакше секунду-дві
    // показувалися б чужі контейнери, ніби нічого й не перемкнулось
    S.containers = []; S.images = []; S.volumes = []; S.networks = [];
    S.pending = {};
    S.statsFor = null;
    S.loading = true;
  }
  renderEngineLabel();
  $("ro-badge").style.display = isReadonly() ? "inline-flex" : "none";
  persist();
  renderTree();
  renderDetail();
  refreshAll();
}

/** Підпис у шапці: версія демона або те, що його немає. */
function renderEngineLabel() {
  const c = S.conns[S.activeConn];
  const i = c?.info;
  $("engine").textContent = !c?.up ? ""
    : c.dockerOk && i ? `Docker ${i.version} · API ${i.api_version} · ${i.os}`
    : t("conn.noDockerShort");
}

function renderConnBox() {
  const box = $("connbox");
  box.innerHTML = "";

  const sec = document.createElement("div");
  sec.className = "section";
  const upN = Object.values(S.conns).filter(c => c.up).length;
  sec.innerHTML = `${ic(S.connsCollapsed ? "chevronRight" : "chevronDown", "sm")} ${t("tree.connections")}` +
    `<span class="cnt">${upN}/${S.profiles.length}</span>` +
    `<span class="plus" title="${esc(t("tree.connections.manage"))}">${ic("plus")}</span>`;
  sec.onclick = e => {
    if (e.target.classList.contains("plus")) {
      editingProfile = null; fillProfileForm(null); renderProfileList();
      $("conn-modal").classList.add("open");
      return;
    }
    S.connsCollapsed = !S.connsCollapsed;
    persist();
    renderConnBox();
  };
  box.appendChild(sec);

  if (!S.connsCollapsed) {
    const chips = document.createElement("div");
    chips.id = "connchips";
    for (const p of S.profiles) {
      const c = S.conns[p.id];
      const waiting = !!retry[p.id]?.timer;
      const chip = document.createElement("div");
      chip.className = "connchip" + (S.activeConn === p.id ? " active" : "") + (waiting ? " waiting" : "");
      chip.title = (p.kind === "ssh" ? `ssh ${p.user}@${p.host}:${p.port}` : p.kind === "tcp" ? `tcp ${p.host}:${p.port}` : t("conn.localSocket"))
        + (p.readonly ? " · read-only" : "")
        + (c?.up ? " · " + (c.dockerOk ? t("conn.connected") : t("conn.noDockerShort"))
           : waiting ? " · " + t("conn.reconnecting") : " · " + t("conn.clickConnect"));
      const dotState = c?.up ? (c.dockerOk ? "up" : "nodocker")
        : (c?.connecting || waiting) ? "connecting" : "";
      chip.innerHTML =
        `<span class="cdot ${dotState}"></span>` +
        `<span class="nm">${esc(p.name)}</span>` +
        (c?.connecting ? `<span class="spin"></span>` : "") +
        (p.readonly ? `<span class="ro" title="read-only">${ic("lock", "sm")}</span>` : "") +
        `<span class="pw" title="${esc(c?.up ? t("conn.disconnect") : t("conn.connect"))}">${ic(c?.up ? "power" : "play", "sm")}</span>`;
      chip.onclick = e => {
        if (e.target.classList.contains("pw")) {
          e.stopPropagation();
          return c?.up ? disconnectProfile(p.id) : connectProfile(p.id);
        }
        return c?.up ? switchConn(p.id) : connectProfile(p.id);
      };
      chips.appendChild(chip);
    }
    box.appendChild(chips);
  }
}

function renderProfileList() {
  const box = $("profile-list");
  box.innerHTML = "";
  for (const p of S.profiles) {
    const up = S.conns[p.id]?.up;
    const div = document.createElement("div");
    div.className = "pitem";
    div.innerHTML = `
      <span class="cdot ${up ? "up" : ""}"></span>
      <span class="pname">${esc(p.name)}${p.readonly ? ic("lock", "sm") : ""}</span>
      <span class="pdetail">${p.kind === "ssh" ? `ssh ${esc(p.user)}@${esc(p.host)}:${p.port}` : p.kind === "tcp" ? `tcp ${esc(p.host)}:${p.port}` : t("conn.localSocket")}</span>
      ${p.autoconnect ? `<span class="hint" title="${esc(t("conn.autoHint"))}">${ic("repeat", "sm")}</span>` : ""}
      ${up ? `<button data-x="dis">${ic("power")} ${t("conn.disconnect")}</button>` : `<button data-x="con" class="primary">${ic("play")} ${t("conn.connect")}</button>`}
      ${p.id !== "local" ? `<button data-x="edit" title="${esc(t("conn.edit"))}">${ic("pencil")}</button><button data-x="del" class="danger" title="${esc(t("common.delete"))}">${ic("trash")}</button>` : ""}`;
    div.querySelectorAll("button").forEach(b => b.onclick = async () => {
      const x = b.dataset.x;
      if (x === "con") { $("conn-modal").classList.remove("open"); connectProfile(p.id); }
      if (x === "dis") { await disconnectProfile(p.id); renderProfileList(); }
      if (x === "edit") { editingProfile = p; fillProfileForm(p); }
      if (x === "del") { S.profiles = await invoke("delete_profile", { id: p.id }); renderTree(); renderProfileList(); }
    });
    box.appendChild(div);
  }
}

function fillProfileForm(p) {
  $("pf-title").textContent = p ? t("conn.edit") + ": " + p.name : t("conn.new");
  $("pf-name").value = p?.name ?? "";
  $("pf-kind").value = p?.kind === "tcp" ? "tcp" : "ssh";
  $("pf-host").value = p?.host ?? "";
  $("pf-port").value = p?.port || "";
  $("pf-user").value = p?.user ?? "";
  $("pf-key").value = p?.key_path ?? "";
  $("pf-readonly").checked = !!p?.readonly;
  updateKindFields();
}
function updateKindFields() {
  const ssh = $("pf-kind").value === "ssh";
  $("l-user").style.display = $("pf-user").style.display = ssh ? "" : "none";
  $("l-key").style.display = $("pf-key").style.display = ssh ? "" : "none";
  $("pf-port").placeholder = ssh ? "22" : "2375";
}

function wireConnUI() {
  $("pf-kind").onchange = updateKindFields;
  $("pf-save").onclick = async () => {
    const kind = $("pf-kind").value;
    const prof = {
      id: editingProfile?.id ?? "",
      name: $("pf-name").value.trim() || $("pf-host").value.trim(),
      kind,
      host: $("pf-host").value.trim(),
      port: parseInt($("pf-port").value) || (kind === "ssh" ? 22 : 2375),
      user: $("pf-user").value.trim(),
      key_path: $("pf-key").value.trim(),
      readonly: $("pf-readonly").checked,
    };
    if (!prof.host) return toast(t("conn.needHost"));
    if (kind === "ssh" && !prof.user) return toast(t("conn.needUser"));
    S.profiles = await invoke("save_profile", { profile: prof });
    editingProfile = null;
    fillProfileForm(null);
    renderTree(); renderProfileList();
    toast(t("conn.saved"), "ok", 2500);
  };

  /* B9 — імпорт docker contexts */
  $("import-contexts").onclick = async () => {
    try {
      const list = await invoke("import_contexts");
      if (!list.length) return toast(t("conn.noContexts"), "warn", 4000);
      let added = 0;
      for (const c of list) {
        if (S.profiles.some(p => p.host === c.profile.host && p.kind === c.profile.kind)) continue;
        S.profiles = await invoke("save_profile", {
          profile: {
            id: "", name: c.name, kind: c.profile.kind, host: c.profile.host,
            port: c.profile.port, user: c.profile.user, key_path: "", readonly: false,
          },
        });
        added++;
      }
      renderTree(); renderProfileList();
      toast(added ? t("conn.imported", { n: added }) : t("conn.allImported"), "ok", 4000);
    } catch (e) { toast("Імпорт: " + e); }
  };
}

/* ── A5/A6: port-forward і відкриття в браузері ── */
async function openContainerPort(c, mapping) {
  // mapping: "8081:80" (host:container) з labels списку
  const hostPort = parseInt(String(mapping).split(":")[0]);
  if (!hostPort) return;
  const prof = activeProfile();
  try {
    const r = await invoke("forward_start", {
      conn: S.activeConn,
      remoteHost: "127.0.0.1",
      remotePort: hostPort,
      label: `${c.name}:${hostPort}`,
    });
    await refreshForwards();
    try {
      await invoke("open_url", { url: r.url });
      toast(prof.kind === "ssh"
        ? `${t("ctr.openBrowser")}: ${r.url} → ${prof.host}:${hostPort}`
        : `${t("ctr.openBrowser")}: ${r.url}`, "ok", 5000);
    } catch (e) {
      // браузер не відкрився — принаймні даємо готовий URL
      await copyText(r.url, true);
      toast(`${r.url} — ${t("ctr.urlCopied")} (${e})`, "warn", 9000);
    }
  } catch (e) { toast("Port-forward: " + e); }
}

async function refreshForwards() {
  try {
    S.forwards = await invoke("forward_list");
    const badge = $("fwd-badge");
    badge.style.display = S.forwards.length ? "inline-block" : "none";
    $("fwd-count").textContent = S.forwards.length;
    badge.title = S.forwards.map(f => `${f.label} → 127.0.0.1:${f.local_port}`).join("\n");
  } catch {}
}

async function stopAllForwards() {
  for (const f of S.forwards) await invoke("forward_stop", { key: f.key });
  await refreshForwards();
  toast(t("conn.tunnelsClosed"), "ok", 2500);
}
