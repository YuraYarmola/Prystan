"use strict";
/* Образи, томи, мережі, disk usage, create, build, compose, inspect */

function renderImages() {
  if (S.loading && !S.images.length) { $("images-table").innerHTML = skeleton(6); return; }
  const rows = [...S.images].sort((a, b) => b.created - a.created).map(i => `
    <tr>
      <td class="grow">${i.tags.length ? i.tags.map(esc).join("<br>") : `<span class="mono">${esc(i.id.replace("sha256:", "").slice(0, 12))}</span> <span class="hint">&lt;none&gt;</span>`}</td>
      <td style="text-align:right">${fmtBytes(i.size)}</td>
      <td>${fmtAgo(i.created)}</td>
      <td><div class="racts">
        <button data-act="layers" data-id="${esc(i.id)}" title="${esc(t("img.layers"))}">${ic("layers")}</button>
        <button data-act="scan" data-id="${esc(i.id)}" title="${esc(t("scan.title"))}">${ic("shield")}</button>
        <button data-act="push" data-id="${esc(i.id)}" title="${esc(t("img.push"))}">${ic("upload")}</button>
        <button data-act="rm" data-id="${esc(i.id)}" class="danger" title="${esc(t("common.delete"))}">${ic("trash")}</button>
      </div></td>
    </tr>`).join("");
  $("images-table").innerHTML = `<table class="grid">
    <thead><tr><th>${t("res.tag")}</th><th style="text-align:right">${t("files.size")}</th><th>${t("insp.created")}</th><th style="width:150px"></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  $("images-table").querySelectorAll("button[data-act]").forEach(b => b.onclick = async () => {
    const img = S.images.find(i => i.id === b.dataset.id);
    if (!img) return;
    if (b.dataset.act === "layers") return showLayers(img);
    if (b.dataset.act === "scan") return scanImage(img);
    if (b.dataset.act === "push") return pushImage(img);
    if (!guardRW("guard.rmImage")) return;
    if (!(await ask({ title: t("res.deleteImage"), text: esc(img.tags[0] ?? img.id.slice(0, 19)), okLabel: t("common.delete") }))) return;
    try { await invoke("remove_image", { conn: S.activeConn, id: b.dataset.id }); refreshAll(); }
    catch (e) { toast("rmi: " + e); }
  });
}

function renderVolumes() {
  if (S.loading && !S.volumes.length) { $("volumes-table").innerHTML = skeleton(5); return; }
  const rows = S.volumes.map(v => `
    <tr>
      <td class="grow">${esc(v.name)}</td>
      <td>${esc(v.driver)}</td>
      <td class="mono grow">${esc(v.mountpoint)}</td>
      <td><div class="racts"><button data-n="${esc(v.name)}" class="danger" title="${esc(t("common.delete"))}">${ic("trash")}</button></div></td>
    </tr>`).join("");
  $("volumes-table").innerHTML = `<table class="grid">
    <thead><tr><th>${t("files.name")}</th><th>${t("res.driver")}</th><th>${t("res.mountpoint")}</th><th style="width:60px"></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  $("volumes-table").querySelectorAll("button[data-n]").forEach(b => b.onclick = async () => {
    if (!guardRW("guard.rmVolume")) return;
    if (!(await ask({ title: t("res.deleteVolume"), text: t("res.deleteVolumeText", { name: esc(b.dataset.n) }), okLabel: t("common.delete") }))) return;
    try { await invoke("remove_volume", { conn: S.activeConn, name: b.dataset.n }); refreshAll(); }
    catch (e) { toast("volume rm: " + e); }
  });
}

function renderNetworks() {
  if (S.loading && !S.networks.length) { $("networks-table").innerHTML = skeleton(5); return; }
  const rows = S.networks.map(n => `
    <tr>
      <td class="grow">${esc(n.name)}</td>
      <td>${esc(n.driver)}</td>
      <td>${esc(n.scope)}</td>
      <td><div class="racts">${["bridge", "host", "none"].includes(n.name) ? "" : `<button data-id="${esc(n.id)}" class="danger" title="${esc(t("common.delete"))}">${ic("trash")}</button>`}</div></td>
    </tr>`).join("");
  $("networks-table").innerHTML = `<table class="grid">
    <thead><tr><th>${t("files.name")}</th><th>${t("res.driver")}</th><th>${t("res.scope")}</th><th style="width:60px"></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  $("networks-table").querySelectorAll("button[data-id]").forEach(b => b.onclick = async () => {
    if (!guardRW("guard.rmNetwork")) return;
    try { await invoke("remove_network", { conn: S.activeConn, id: b.dataset.id }); refreshAll(); }
    catch (e) { toast("network rm: " + e); }
  });
}

/* B1 — disk usage */
async function openDf() {
  const box = $("df-body");
  box.innerHTML = `<div class="placeholder"><span class="spin"></span> ${t("df.counting")}</div>`;
  try {
    const d = await invoke("system_df", { conn: S.activeConn });
    const card = (label, value, sub, extra = "") => `
      <div class="statcard">
        <div class="sc-label">${label}</div>
        <div class="sc-value">${fmtBytes(value)}</div>
        <div class="sc-sub">${sub}</div>${extra}
      </div>`;
    box.innerHTML = `
      <div class="statgrid">
        ${card(t("df.images"), d.images_total, `${d.images_count} ${t("df.pcs")} · ${t("df.unused")}: ${fmtBytes(d.images_unused)}`,
          d.images_unused > 0 ? `<button style="margin-top:10px" class="danger" data-p="images">prune ${fmtBytes(d.images_unused)}</button>` : "")}
        ${card(t("df.containers"), d.containers_total, `${d.containers_count} ${t("df.writable")}`,
          `<button style="margin-top:10px" class="danger" data-p="containers">${t("df.pruneStopped")}</button>`)}
        ${card(t("df.volumes"), d.volumes_total, `${d.volumes_count} ${t("df.pcs")} · ${t("df.unused")}: ${fmtBytes(d.volumes_unused)}`,
          d.volumes_unused > 0 ? `<button style="margin-top:10px" class="danger" data-p="volumes">prune ${fmtBytes(d.volumes_unused)}</button>` : "")}
        ${card(t("df.cache"), d.build_cache, t("df.buildCache"),
          d.build_cache > 0 ? `<button style="margin-top:10px" class="danger" data-p="builder">prune</button>` : "")}
      </div>
      <div class="statcard" style="margin-top:14px">
        <div class="sc-label">${t("df.total")}</div>
        <div class="sc-value">${fmtBytes(d.images_total + d.containers_total + d.volumes_total + d.build_cache)}</div>
        <div class="sc-sub">${t("df.canFree")}: ${fmtBytes(d.images_unused + d.volumes_unused + d.build_cache)}</div>
      </div>`;
    box.querySelectorAll("button[data-p]").forEach(b => b.onclick = () => pruneWhat(b.dataset.p, b.textContent));
  } catch (e) {
    box.innerHTML = errorBox(e);
  }
}

async function pruneWhat(what, label) {
  if (!guardRW("guard.prune")) return;
  if (!(await ask({ title: t("res.pruneTitle"), text: t("res.pruneText", { label: esc(label), conn: esc(activeProfile()?.name) }) + `<br><span class="hint">${t("res.pruneWarn")}</span>`, okLabel: t("res.pruneTitle") }))) return;
  try {
    const r = await invoke("prune", { conn: S.activeConn, what });
    toast(r, "ok", 5000);
    refreshAll();
    if (S.view === "df") openDf();
  } catch (e) { toast("prune: " + e); }
}

/* pull */
function wirePull() {
  $("pull-btn").onclick = async () => {
    if (!guardRW("guard.pull")) return;
    const image = $("pull-name").value.trim();
    if (!image) return;
    const log = $("pull-log");
    log.style.display = "block";
    log.textContent = "⇩ " + image + "\n";
    try { await invoke("pull_image", { conn: S.activeConn, image }); refreshAll(); }
    catch (e) { toast("pull: " + e); }
  };
  $("prune-images").onclick = () => pruneWhat("images", `prune ${t("df.images")} · ${t("df.unused")}`);
  $("prune-volumes").onclick = () => pruneWhat("volumes", `prune ${t("df.volumes")} · ${t("df.unused")}`);
}

listen("pull-progress", ev => {
  const p = ev.payload;
  if (p.conn !== S.activeConn) return;
  const log = $("pull-log");
  log.style.display = "block";
  const lines = log.textContent.split("\n");
  const lid = p.line.split(" ")[0];
  const ix = lines.findIndex(l => lid && l.startsWith(lid + " "));
  if (ix >= 0) lines[ix] = p.line; else lines.push(p.line);
  log.textContent = lines.slice(-25).join("\n");
  log.scrollTop = log.scrollHeight;
});

/* B7 — create container */
function crPreview() {
  const ports = $("cr-ports").value.split(",").map(s => s.trim()).filter(Boolean);
  const vols = $("cr-vols").value.split(",").map(s => s.trim()).filter(Boolean);
  const env = $("cr-env").value.split(",").map(s => s.trim()).filter(Boolean);
  const parts = ["docker run -d"];
  if ($("cr-name").value.trim()) parts.push(`--name ${$("cr-name").value.trim()}`);
  ports.forEach(p => parts.push(`-p ${p}`));
  vols.forEach(v => parts.push(`-v ${v}`));
  env.forEach(e => parts.push(`-e ${e}`));
  if ($("cr-restart").value !== "no") parts.push(`--restart ${$("cr-restart").value}`);
  parts.push($("cr-image").value.trim() || "<образ>");
  if ($("cr-cmd").value.trim()) parts.push($("cr-cmd").value.trim());
  $("cr-preview").textContent = parts.join(" \\\n  ");
}

function wireCreate() {
  $("create-btn").onclick = () => {
    if (!guardRW("guard.create")) return;
    crPreview();
    $("create-modal").classList.add("open");
    setTimeout(() => $("cr-image").focus(), 60);
  };
  ["cr-image", "cr-name", "cr-ports", "cr-vols", "cr-env", "cr-cmd"].forEach(id => $(id).oninput = crPreview);
  $("cr-restart").onchange = crPreview;
  $("cr-go").onclick = async () => {
    const spec = {
      image: $("cr-image").value.trim(),
      name: $("cr-name").value.trim(),
      ports: $("cr-ports").value.split(",").map(s => s.trim()).filter(Boolean),
      volumes: $("cr-vols").value.split(",").map(s => s.trim()).filter(Boolean),
      env: $("cr-env").value.split(",").map(s => s.trim()).filter(Boolean),
      cmd: $("cr-cmd").value.trim(),
      restart: $("cr-restart").value,
      start: $("cr-start").checked,
    };
    if (!spec.image) return toast(t("create.needImage"));
    try {
      await invoke("create_container", { conn: S.activeConn, spec });
      $("create-modal").classList.remove("open");
      toast(t("create.done"), "ok", 3000);
      refreshAll();
    } catch (e) { toast("create: " + e); }
  };
}

/* B8 — build */
function wireBuild() {
  $("build-btn").onclick = () => {
    if (!guardRW("guard.build")) return;
    $("bd-output").style.display = "none";
    $("bd-output").textContent = "";
    $("build-modal").classList.add("open");
    setTimeout(() => $("bd-dir").focus(), 60);
  };
  $("bd-go").onclick = async () => {
    const dir = $("bd-dir").value.trim(), tag = $("bd-tag").value.trim();
    if (!dir || !tag) return toast(t("build.needFields"));
    const out = $("bd-output");
    out.style.display = "block";
    out.textContent = `$ docker build -t ${tag} ${dir}\n`;
    try {
      await invoke("build_image", {
        conn: S.activeConn, contextDir: dir,
        dockerfile: $("bd-file").value.trim() || null, tag,
      });
      refreshAll();
    } catch (e) { toast("build: " + e); }
  };
}

listen("build-output", ev => {
  const p = ev.payload;
  if (p.conn !== S.activeConn) return;
  const out = $("bd-output");
  out.style.display = "block";
  out.textContent += p.line + "\n";
  out.scrollTop = out.scrollHeight;
});

/* compose */
function openComposePane() {
  const st = S.selectedStack;
  const wd = st.rows.find(r => r.workdir)?.workdir ?? "";
  const cfg = (st.rows.find(r => r.config_file)?.config_file ?? "").split(",")[0];
  const prof = activeProfile();
  S.composeCtx = { conn: S.activeConn, project: st.project, workdir: wd, config: cfg, kind: prof.kind };
  $("cm-workdir").textContent = wd ? `${t("compose.workdir")}: ${wd}` : t("compose.noWorkdir");
  const enabled = (prof.kind === "ssh" || prof.kind === "local") && !!wd && !isReadonly();
  ["cm-up", "cm-down", "cm-restart", "cm-pull", "cm-build"].forEach(id => $(id).disabled = !enabled);
  $("cm-edit-compose").disabled = !cfg || prof.kind === "tcp";
  $("cm-edit-env").disabled = !wd || prof.kind === "tcp";
}

async function composeRun(action) {
  const ctx = S.composeCtx;
  if (!ctx || !guardRW("guard.groupAction")) return;
  if (action === "down" && !(await ask({
    title: "compose down",
    text: t("compose.downConfirm", { project: esc(ctx.project) }),
    okLabel: "down",
  }))) return;
  const out = $("cm-output");
  out.style.display = "block";
  out.textContent = "";
  setBusy(true);
  try {
    await invoke("compose_cmd", { conn: ctx.conn ?? S.activeConn, project: ctx.project, workdir: ctx.workdir, action });
  } catch (e) { out.textContent += "✗ " + e + "\n"; setBusy(false); }
}

listen("compose-output", ev => {
  const p = ev.payload;
  const ctx = S.composeCtx;
  if (!ctx || p.conn !== (ctx.conn ?? S.activeConn) || p.project !== ctx.project) return;
  const out = $("cm-output");
  out.style.display = "block";
  out.textContent += p.line + "\n";
  out.scrollTop = out.scrollHeight;
  if (p.done) {
    setBusy(false);
    refreshAll({ quiet: true });
    const ok = !p.line.startsWith("✗");
    tgAlert(`${ok ? "✅" : "⚠"} <b>${ctx.project}</b>\ncompose: ${esc(p.line)}`, "composeDone");
  }
});

function wireCompose() {
  $("cm-up").onclick = () => composeRun("up");
  $("cm-build").onclick = () => composeRun("build");
  $("cm-down").onclick = () => composeRun("down");
  $("cm-restart").onclick = () => composeRun("restart");
  $("cm-pull").onclick = () => composeRun("pull");
  $("cm-edit-compose").onclick = () => openEditor(S.composeCtx.config, "host");
  $("cm-edit-env").onclick = () => {
    const ctx = S.composeCtx;
    openEditor(ctx.workdir.replace(/[\\/]+$/, "") + "/.env", "host");
  };
}

/* inspect + редагування env (як у плагіні JetBrains) */
let envEditing = false, envMasked = true, envOriginal = [];

const SECRET_RE = /(PASS|PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|DSN|AUTH|SALT|SIGNATURE)/i;
// URL з обліковими даними: scheme://user:password@host
const CRED_URL_RE = /^[a-z0-9+.-]+:\/\/[^\/\s:@]+:[^\/\s@]+@/i;

function maskValue(line) {
  const i = line.indexOf("=");
  if (i < 0) return line;
  const k = line.slice(0, i), v = line.slice(i + 1);
  if (!envMasked || !v) return line;
  const dot = c => "•".repeat(Math.min(24, Math.max(6, c)));
  if (SECRET_RE.test(k)) return k + "=" + dot(v.length);
  // ховаємо лише пароль у DSN/URL, решту лишаємо читабельною
  const m = v.match(CRED_URL_RE);
  if (m) {
    const head = m[0];
    const at = head.lastIndexOf("@");
    const colon = head.lastIndexOf(":", at);
    return k + "=" + head.slice(0, colon + 1) + dot(at - colon - 1) + v.slice(head.length - 1);
  }
  return line;
}

async function openInspect() {
  const box = $("inspect");
  box.innerHTML = `<div class="placeholder"><span class="spin"></span></div>`;
  try {
    const j = await invoke("inspect_container", { conn: S.activeConn, id: S.selected.id });
    const cfg = j.Config ?? {}, hc = j.HostConfig ?? {}, st = j.State ?? {};
    const ports = Object.entries(j.NetworkSettings?.Ports ?? {}).map(([k, v]) =>
      [k, (v ?? []).map(b => `${b.HostIp}:${b.HostPort}`).join(", ") || "—"]);
    const mounts = (j.Mounts ?? []).map(m => `${m.Source ?? m.Name ?? "?"} → ${m.Destination} (${m.Type}${m.RW ? "" : ", ro"})`);
    const nets = Object.keys(j.NetworkSettings?.Networks ?? {});
    const kv = pairs => `<div class="kv">${pairs.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("")}</div>`;
    envOriginal = (cfg.Env ?? []).slice();
    envEditing = false;

    box.innerHTML = `
      <h3>${t("insp.general")}</h3>
      ${kv([
        [t("insp.id"), (j.Id ?? "").slice(0, 24)],
        [t("insp.image"), cfg.Image ?? ""],
        [t("insp.created"), j.Created ?? ""],
        [t("insp.state"), `${st.Status ?? ""}${st.Health ? " · health: " + st.Health.Status : ""}`],
        [t("insp.started"), st.StartedAt ?? ""],
        [t("insp.restart"), hc.RestartPolicy?.Name || "no"],
        [t("insp.cmd"), [(cfg.Entrypoint ?? []).join(" "), (cfg.Cmd ?? []).join(" ")].filter(Boolean).join("  ·  ")],
        [t("insp.workdir"), cfg.WorkingDir || "/"],
      ])}
      <h3>${t("insp.ports")}</h3>${ports.length ? kv(ports) : `<span class="hint">${t("insp.none")}</span>`}
      <h3>MOUNTS</h3>${mounts.length ? mounts.map(m => `<div class="v mono">${esc(m)}</div>`).join("") : `<span class="hint">${t("insp.none")}</span>`}
      <h3>${t("insp.networks")}</h3><span>${nets.map(esc).join(", ") || "—"}</span>
      <h3>
        ${t("insp.env")} (${envOriginal.length})
        <button id="env-mask" style="font-size:11px;padding:2px 8px" title="${esc(t("insp.envMask"))}">${ic("eye")}</button>
        <button id="env-edit" style="font-size:11px;padding:2px 8px">${t("insp.envEdit")}</button>
        <span id="env-actions" style="display:none">
          <button id="env-apply" class="primary" style="font-size:11px;padding:2px 8px">${t("insp.envApply")}</button>
          <button id="env-cancel" style="font-size:11px;padding:2px 8px">${t("insp.envCancel")}</button>
        </span>
      </h3>
      <div id="env-hint" class="hint" style="display:none;margin-bottom:6px">${t("insp.envHint")}</div>
      <pre id="env-view">${esc(envOriginal.map(maskValue).join("\n"))}</pre>
      <textarea id="env-edit-area" class="mono" style="display:none;width:100%;height:320px;resize:vertical"></textarea>
      <div id="env-progress" class="hint" style="display:none;margin-top:6px"></div>
      <h3>${t("lim.title")}</h3>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="hint">CPU</label>
        <input id="lim-cpus" style="width:90px" placeholder="0 = ∞" value="${
          hc.NanoCpus ? (hc.NanoCpus / 1e9) : (hc.CpuQuota && hc.CpuPeriod ? (hc.CpuQuota / hc.CpuPeriod) : "")}" />
        <label class="hint">RAM, МБ</label>
        <input id="lim-mem" style="width:110px" placeholder="0 = ∞" value="${hc.Memory ? Math.round(hc.Memory / 1048576) : ""}" />
        <button id="lim-apply" class="primary" style="font-size:11px;padding:3px 10px">${t("lim.apply")}</button>
        <span class="hint">${t("lim.hint")}</span>
      </div>

      <h3>${t("diff.title")} <button id="diff-load" style="font-size:11px;padding:2px 8px">${t("diff.load")}</button></h3>
      <div id="diff-body"></div>

      <h3>${t("insp.raw")} <button id="raw-toggle" style="font-size:11px;padding:2px 8px">${t("insp.show")}</button></h3>
      <pre id="raw-json" style="display:none">${esc(JSON.stringify(j, null, 2))}</pre>`;
    $("lim-apply").onclick = applyLimits;
    $("diff-load").onclick = loadDiff;

    $("raw-toggle").onclick = () => {
      const r = $("raw-json");
      const show = r.style.display === "none";
      r.style.display = show ? "block" : "none";
      $("raw-toggle").textContent = show ? t("insp.hide") : t("insp.show");
    };
    $("env-mask").onclick = () => {
      envMasked = !envMasked;
      $("env-mask").innerHTML = ic(envMasked ? "eye" : "eyeOff");
      if (!envEditing) $("env-view").textContent = envOriginal.map(maskValue).join("\n");
    };
    $("env-edit").onclick = () => startEnvEdit();
    $("env-cancel").onclick = () => cancelEnvEdit();
    $("env-apply").onclick = () => applyEnvEdit();
  } catch (e) { box.innerHTML = errorBox(e); }
}

function startEnvEdit() {
  if (!guardRW("guard.recreate")) return;
  envEditing = true;
  // у режимі редагування показуємо справжні значення
  $("env-edit-area").value = envOriginal.join("\n");
  $("env-edit-area").style.display = "block";
  $("env-view").style.display = "none";
  $("env-hint").style.display = "block";
  $("env-edit").style.display = "none";
  $("env-mask").style.display = "none";
  $("env-actions").style.display = "inline";
  $("env-edit-area").focus();
}

function cancelEnvEdit() {
  envEditing = false;
  $("env-edit-area").style.display = "none";
  $("env-view").style.display = "block";
  $("env-hint").style.display = "none";
  $("env-edit").style.display = "";
  $("env-mask").style.display = "";
  $("env-actions").style.display = "none";
  $("env-progress").style.display = "none";
}

async function applyEnvEdit() {
  const c = S.selected;
  if (!c || !guardRW("guard.recreate")) return;
  const env = $("env-edit-area").value
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
  const bad = env.find(l => !l.includes("="));
  if (bad) return toast(`KEY=value: «${bad.slice(0, 40)}»`, "err", 5000);

  // попереджаємо про дублікати ключів — Docker візьме останній
  const keys = env.map(l => l.slice(0, l.indexOf("=")));
  const dups = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  if (dups.length) toast(`⚠ ${dups.join(", ")} — Docker візьме останнє значення`, "warn", 6000);

  const ok = await ask({
    title: t("insp.envConfirm"),
    text: t("insp.envConfirmText", { name: esc(c.name) }),
    okLabel: t("insp.envConfirmBtn"),
  });
  if (!ok) return;

  const prog = $("env-progress");
  prog.style.display = "block";
  prog.innerHTML = `<span class="spin"></span> …`;
  $("env-apply").disabled = true;
  try {
    const newId = await invoke("recreate_with_env", { conn: S.activeConn, id: c.id, env });
    toast(t("insp.envDone"), "ok", 5000);
    await refreshAll();
    const fresh = S.containers.find(x => x.id === newId) || S.containers.find(x => x.name === c.name);
    if (fresh) { S.selected = fresh; renderTree(); }
    cancelEnvEdit();
    openInspect();
  } catch (e) {
    prog.innerHTML = `${ic("alert")} ${esc(String(e))}`;
    toast(String(e), "err", 9000);
  } finally {
    $("env-apply").disabled = false;
  }
}

listen("recreate-progress", ev => {
  if (ev.payload.conn !== S.activeConn) return;
  const prog = $("env-progress");
  if (prog) { prog.style.display = "block"; prog.innerHTML = `<span class="spin"></span> ${esc(ev.payload.line)}`; }
});

function wireResourcesUI() {
  wirePull(); wireCreate(); wireBuild(); wireCompose();
}
