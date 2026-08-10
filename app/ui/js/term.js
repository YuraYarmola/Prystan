"use strict";
/* Термінали: кілька сесій на об'єкт, сніпети, історія, ConPTY для хоста */

const DEFAULT_SNIPPETS = [
  "ls -la", "df -h", "free -m", "top -b -n1 | head -20", "btop", "htop",
  "docker ps", "docker compose ps", "journalctl -n 50 --no-pager",
  "netstat -tulpn | head -30", "tail -f /var/log/syslog",
];

/* базовий словник команд — щоб підказки працювали ще до накопичення історії */
const COMMON_CMDS = [
  "cd /", "cat ", "grep -rn ", "tail -f ", "head -50 ", "less ", "find . -name ",
  "ps aux | grep ", "kill -9 ", "systemctl status ", "systemctl restart ",
  "docker ps -a", "docker logs -f ", "docker exec -it ", "docker compose up -d",
  "docker compose down", "docker compose logs -f", "docker compose restart",
  "docker stats", "docker system df", "docker image prune -a",
  "du -sh * | sort -h", "df -h", "free -m", "uptime", "whoami", "env",
  "redis-cli ping", "psql -U postgres", "python manage.py shell", "npm run dev",
];

/** Історія команд (спільна, зберігається між запусками). */
function rememberCmd(cmd) {
  if (!cmd || cmd.length < 2) return;
  S.cmdHistory = (S.cmdHistory || []).filter(x => x !== cmd);
  S.cmdHistory.unshift(cmd);
  if (S.cmdHistory.length > 300) S.cmdHistory.length = 300;
  persist();
}

/** Найсвіжіша команда з історії/словника, що починається з префікса. */
function suggestFor(prefix) {
  const pool = [...(S.cmdHistory || []), ...S.snippets, ...DEFAULT_SNIPPETS, ...COMMON_CMDS];
  return pool.find(c => c.length > prefix.length && c.startsWith(prefix));
}

/* ══ доповнення шляхів для шелів без readline (dash, ash, busybox) ══
   dash не має доповнення взагалі — Tab просто вставляв символ табуляції.
   Тут ми робимо його самі: рахуємо поточну теку, читаємо її вміст
   і дописуємо спільний префікс, як справжня консоль. */

function normPath(p) {
  const abs = p.startsWith("/");
  const out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
}

function resolveDir(cwd, dirPart) {
  if (!dirPart) return cwd || "/";
  if (dirPart.startsWith("/")) return normPath(dirPart) || "/";
  return normPath((cwd || "/").replace(/\/+$/, "") + "/" + dirPart) || "/";
}

function commonPrefix(list) {
  if (!list.length) return "";
  let p = list[0];
  for (const s of list.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}

/** Оновлення поточної теки з набраної команди (для доповнення відносних шляхів). */
function trackCwd(sess, cmd) {
  const simple = cmd.match(/^\s*cd\s+([^\s;&|<>]+)\s*$/);
  if (simple) {
    let target = simple[1].replace(/^["']|["']$/g, "");
    if (target === "~" || target.startsWith("~/")) { sess.cwdKnown = false; return; }
    sess.cwd = resolveDir(sess.cwd, target);
    sess.cwdKnown = true;
    return;
  }
  if (/^\s*cd\s*$/.test(cmd)) { sess.cwdKnown = false; return; }   // cd без аргументів → home
  if (/\bcd\b/.test(cmd)) sess.cwdKnown = false;                    // складна форма — не вгадуємо
}

function showCandidates(list) {
  const box = $("term-complete");
  if (!list.length) { box.classList.remove("open"); return; }
  box.innerHTML = `<div class="chead">${list.length} ${t("term.candidates")}</div>` +
    list.slice(0, 200).map(e =>
      `<span class="cand ${e.is_dir ? "dir" : ""}">${esc(e.name)}${e.is_dir ? "/" : ""}</span>`).join("");
  box.classList.add("open");
}
function hideCandidates() { $("term-complete").classList.remove("open"); }

async function tabComplete(sess) {
  if (!sess.cwdKnown) {
    toast(t("term.cwdUnknown"), "warn", 3500);
    return;
  }
  const token = (sess.buf.match(/[^\s]*$/) || [""])[0];
  const slash = token.lastIndexOf("/");
  const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
  const prefix = slash >= 0 ? token.slice(slash + 1) : token;
  const dir = resolveDir(sess.cwd, dirPart);

  let entries;
  try {
    entries = isFsHost()
      ? await invoke("host_fs_list", { conn: fsConn(), path: dir })
      : await invoke("fs_list", { conn: S.activeConn, id: S.selected.id, path: dir });
  } catch (e) { return; }

  const cands = entries.filter(e => e.name.startsWith(prefix));
  if (!cands.length) { hideCandidates(); return; }

  const common = commonPrefix(cands.map(e => e.name));
  let insert = common.slice(prefix.length);
  if (cands.length === 1) insert += cands[0].is_dir ? "/" : " ";

  if (insert) {
    sess.buf += insert;
    sess.send(insert);
    hideCandidates();
  } else {
    showCandidates(cands);   // спільного префікса немає — показуємо варіанти
  }
}

/** Вставка з меню. Якщо читати буфер не дозволено — підказуємо Ctrl+V. */
async function pasteIntoTerm(sess) {
  const txt = await readClipboard();
  if (txt === null) {
    sess.term.focus();
    toast(t("term.pasteHint"), "warn", 5000);
    return;
  }
  if (txt) sess.term.paste(txt);
  sess.term.focus();
}

function termTheme() {
  const light = S.theme === "light";
  return light
    ? { background: "#ffffff", foreground: "#1c2330", cursor: "#1f6feb", selectionBackground: "#cfe3ff" }
    : { background: "#0b0d11", foreground: "#d7dce5", cursor: "#4f9cf9", selectionBackground: "#264f78" };
}

const termList = key => (S.terms[key] ||= []);
const activeSess = () => {
  const list = S.terms[targetKey()];
  if (!list?.length) return null;
  return list[S.termActive[targetKey()] ?? 0] ?? list[0];
};

/** Куди відкривати консоль: у контейнер, на сервер по SSH чи локально в теці. */
const termMode = () => (S.view === "project" ? "local" : isHostView() ? "host" : "container");

async function openTerm() {
  const key = targetKey();
  const list = termList(key);
  if (!list.length) await newTermSession();
  else showSess(S.termActive[key] ?? 0);
  $("term-shell").style.display = termMode() === "container" ? "" : "none";
  renderTermTabs();
}

function showSess(idx) {
  const key = targetKey();
  const list = termList(key);
  if (!list[idx]) return;
  S.termActive[key] = idx;
  // ховаємо всі сесії всіх об'єктів
  for (const l of Object.values(S.terms)) for (const s of l) s.div.style.display = "none";
  const sess = list[idx];
  sess.div.style.display = "block";
  $("term-overlay").style.display = sess.dead ? "flex" : "none";
  setTimeout(() => { sess.fit.fit(); doResize(sess); sess.term.focus(); }, 30);
  renderTermTabs();
}

function renderTermTabs() {
  const key = targetKey();
  const list = termList(key);
  const box = $("term-tabs");
  box.innerHTML = "";
  list.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "ttab" + (i === (S.termActive[key] ?? 0) ? " on" : "");
    el.innerHTML = `${s.dead ? ic("x", "sm") : ""}<span>${esc(s.title)}</span>` +
      `<span class="cl" title="${esc(t("editor.close"))}">${ic("x", "sm")}</span>`;
    el.onclick = e => {
      if (e.target.closest(".cl")) { closeSess(i); return; }
      showSess(i);
    };
    box.appendChild(el);
  });
}

async function closeSess(idx) {
  const key = targetKey();
  const list = termList(key);
  const s = list[idx];
  if (!s) return;
  try { await invoke(s.host ? "host_term_close" : "term_close", { sid: s.sid }); } catch {}
  s.term.dispose();
  s.div.remove();
  list.splice(idx, 1);
  S.termActive[key] = Math.max(0, Math.min(list.length - 1, (S.termActive[key] ?? 0)));
  if (list.length) showSess(S.termActive[key]);
  else { $("term-overlay").style.display = "none"; renderTermTabs(); }
}

function doResize(sess) {
  if (!sess) return;
  sess.fit.fit();
  const cmd = sess.host ? "host_term_resize" : "term_resize";
  invoke(cmd, { sid: sess.sid, cols: sess.term.cols, rows: sess.term.rows }).catch(() => {});
}

async function newTermSession() {
  const key = targetKey();
  const mode = termMode();
  // локальна консоль і ssh обидві живуть у ConPTY — команди в них спільні
  const host = mode !== "container";
  const list = termList(key);
  if (list.length >= 6) return toast(t("term.maxSessions"), "warn", 3000);

  const div = document.createElement("div");
  div.style.cssText = "width:100%;height:100%";
  for (const l of Object.values(S.terms)) for (const s of l) s.div.style.display = "none";
  $("term-container").appendChild(div);
  $("term-overlay").style.display = "none";

  const term = new Terminal({
    fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 13,
    theme: termTheme(), cursorBlink: true, scrollback: 8000, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit); term.loadAddon(search);
  term.open(div);
  fit.fit();

  let sid;
  try {
    if (mode === "local") {
      sid = await invoke("local_term_open", { cwd: curPath(), cols: term.cols, rows: term.rows });
    } else if (host) {
      sid = await invoke("host_term_open", { conn: S.activeConn, cols: term.cols, rows: term.rows });
    } else {
      sid = await invoke("term_open", { conn: S.activeConn, id: S.selected.id, shell: $("term-shell").value });
    }
  } catch (e) {
    if (!host && $("term-shell").value !== "/bin/sh") {
      toast(t("term.fallback", { shell: $("term-shell").value }), "warn", 3000);
      $("term-shell").value = "/bin/sh";
      try { sid = await invoke("term_open", { conn: S.activeConn, id: S.selected.id, shell: "/bin/sh" }); }
      catch (e2) { toast("Термінал: " + e2); term.dispose(); div.remove(); return null; }
    } else { toast("Термінал: " + e); term.dispose(); div.remove(); return null; }
  }

  const usedShell = mode === "container" ? $("term-shell").value : "/bin/bash";
  const titles = { local: t("proj.localShell"), host: "ssh", container: usedShell.split("/").pop() };
  const sess = {
    sid, term, fit, search, div, host, mode, dead: false,
    title: `${titles[mode]} ${list.length + 1}`,
    lastCmd: "",
    // bash/zsh і PowerShell доповнюють самі; для решти робимо своє
    nativeComplete: mode === "local" || /bash|zsh/.test(usedShell),
    cwd: "/",
    cwdKnown: true,
  };
  list.push(sess);

  // exec стартує в WorkingDir образу — беремо його, щоб відносні шляхи доповнювались правильно
  if (mode === "container") {
    invoke("inspect_container", { conn: S.activeConn, id: S.selected.id })
      .then(j => { sess.cwd = j?.Config?.WorkingDir || "/"; })
      .catch(() => {});
  } else if (mode === "local") {
    sess.cwd = curPath();
  } else {
    sess.cwd = "/root";
  }
  S.termActive[key] = list.length - 1;

  const inputCmd = host ? "host_term_input" : "term_input";
  const send = d => invoke(inputCmd, { sid, dataB64: strToB64(d) }).catch(() => {});
  sess.send = send;
  sess.buf = "";
  sess.ghost = "";

  /* ── автодоповнення в стилі PowerShell (PSReadLine) ──
     Пропозиція з історії малюється приглушеним текстом праворуч від курсора;
     → або End приймає її, Tab віддається справжньому shell для доповнення шляхів. */
  const clearGhost = () => {
    if (!sess.ghost) return;
    term.write("\x1b[K");            // стерти від курсора до кінця рядка
    sess.ghost = "";
  };
  const showGhost = () => {
    if (!S.termSuggest || sess.dead) return;
    clearGhost();
    const buf = sess.buf;
    if (buf.length < 2) return;
    const hit = suggestFor(buf);
    if (!hit) return;
    const rest = hit.slice(buf.length);
    if (!rest) return;
    sess.ghost = rest;
    term.write(`\x1b[2m${rest}\x1b[0m\x1b[${rest.length}D`);
  };
  sess.showGhost = showGhost;
  sess.clearGhost = clearGhost;

  term.onData(data => {
    // → або End приймають підказку
    if (sess.ghost && ["\x1b[C", "\x1bOC", "\x1b[F", "\x1bOF"].includes(data)) {
      const rest = sess.ghost;
      sess.ghost = "";
      term.write("\x1b[K");
      sess.buf += rest;
      send(rest);
      return;
    }
    clearGhost();

    hideCandidates();

    if (data === "\r" || data === "\n") {
      const cmd = sess.buf.trim();
      if (cmd) { sess.lastCmd = cmd; rememberCmd(cmd); trackCwd(sess, cmd); }
      sess.buf = "";
      send(data);
      return;
    }
    if (data === "\x7f" || data === "\b") {           // backspace
      sess.buf = sess.buf.slice(0, -1);
      send(data);
      setTimeout(showGhost, 40);
      return;
    }
    if (data === "\t") {
      if (sess.nativeComplete) {
        sess.buf = "";        // bash/zsh перемалюють рядок самі
        send(data);
      } else {
        tabComplete(sess);    // dash/ash доповнення не мають — робимо самі
      }
      return;
    }
    if (data.charCodeAt(0) < 32 || data.startsWith("\x1b")) {
      // ↑/↓ дістають команду з історії shell — наш буфер більше не відповідає рядку
      if (data === "\x1b[A" || data === "\x1b[B") sess.histNav = true;
      sess.buf = "";                                    // Ctrl-*, стрілки — стан рядка невідомий
      send(data);
      return;
    }
    sess.buf += data;
    send(data);
    setTimeout(showGhost, 40);
  });

  /* ── копіювання та вставка ──
     xterm припиняє обробку клавіші лише якщо обробник повернув false — і саме
     тоді НЕ гасить подію. Тому Ctrl+V ми просто віддаємо браузеру: його власна
     вставка не потребує жодних дозволів, а xterm ловить подію paste сам.
     Ctrl+C копіює тільки коли є виділення: без нього це сигнал перервати. */
  term.attachCustomKeyEventHandler(ev => {
    if (ev.type !== "keydown") return true;
    // Tab не повинен переводити фокус з терміналу — віддаємо його shell
    if (ev.key === "Tab") { ev.preventDefault(); return true; }
    if (ev.ctrlKey && ev.code === "KeyV") return false;          // нативна вставка
    if (ev.ctrlKey && ev.code === "KeyC") {
      const sel = term.getSelection();
      if (!sel) return true;                                      // ^C у shell
      copyText(sel, true);
      term.clearSelection();
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyA") { term.selectAll(); return false; }
    return true;
  });

  div.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    const sel = term.getSelection();
    showContextMenu(e.clientX, e.clientY, [
      {
        icon: "copy", label: t("ctx.copy"), hint: "Ctrl+C", disabled: !sel,
        run: () => { copyText(sel); term.clearSelection(); },
      },
      { icon: "clipboard", label: t("ctx.paste"), hint: "Ctrl+V", run: () => pasteIntoTerm(sess) },
      "-",
      { icon: "list", label: t("ctx.selectAll"), hint: "Ctrl+Shift+A", run: () => term.selectAll() },
      { icon: "eraser", label: t("ctx.clearScreen"), run: () => term.clear() },
    ]);
  });

  if (!S._termRO) {
    S._termRO = new ResizeObserver(() => requestAnimationFrame(() => doResize(activeSess())));
    S._termRO.observe($("term-wrap"));
  }
  setTimeout(() => doResize(sess), 120);
  term.focus();
  renderTermTabs();
  return sess;
}

listen("term-output", ev => {
  const p = ev.payload;
  for (const list of Object.values(S.terms)) {
    const s = list.find(x => x.sid === p.sid);
    if (s) { s.term.write(b64ToU8(p.data_b64)); return; }
  }
});
listen("term-closed", ev => {
  for (const [key, list] of Object.entries(S.terms)) {
    const s = list.find(x => x.sid === ev.payload.sid);
    if (!s) continue;
    s.dead = true;
    const onTermTab = (S.view === "container" && S.tab === "term") ||
      (S.view === "server" && S.srvTab === "term") ||
      (S.view === "project" && S.projTab === "term");
    if (key === targetKey() && onTermTab && activeSess() === s) $("term-overlay").style.display = "flex";
    renderTermTabs();
    return;
  }
});

function renderSnippets() {
  const sel = $("term-snippets");
  const all = [...DEFAULT_SNIPPETS, ...S.snippets];
  sel.innerHTML = `<option value="">${t("term.snippets")}</option>` +
    all.map(s => `<option value="${esc(s)}">${esc(s.slice(0, 40))}</option>`).join("");
}

function wireTermUI() {
  $("term-new").onclick = () => newTermSession();
  $("term-restart").onclick = () => newTermSession();
  $("term-search").oninput = () => {
    const s = activeSess();
    if (s) s.search.findNext($("term-search").value, { incremental: true });
  };
  $("term-search").onkeydown = e => {
    const s = activeSess();
    if (s && e.key === "Enter") s.search.findNext($("term-search").value);
  };
  $("term-shell").value = S.cfg.defaultShell;
  renderSnippets();
  $("term-snippets").onchange = e => {
    const cmd = e.target.value;
    e.target.value = "";
    const s = activeSess();
    if (!cmd || !s) return;
    s.term.paste(cmd);
    s.term.focus();
  };
  $("term-suggest").classList.toggle("primary", S.termSuggest);
  $("term-suggest").onclick = () => {
    S.termSuggest = !S.termSuggest;
    $("term-suggest").classList.toggle("primary", S.termSuggest);
    if (!S.termSuggest) activeSess()?.clearGhost?.();
    persist();
  };
  $("term-snip-save").onclick = async () => {
    const s = activeSess();
    const cmd = await ask({ title: t("term.snipTitle"), text: t("term.snipText"), input: s?.lastCmd || "", okLabel: t("conn.save") });
    if (!cmd) return;
    if (!S.snippets.includes(cmd)) S.snippets.push(cmd);
    persist();
    renderSnippets();
    toast(t("term.snipSaved"), "ok", 2500);
  };
}
