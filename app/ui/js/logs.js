"use strict";
/* Логи: стрім контейнера, агреговані логи стека, фільтри рівнів, глибокий пошук */

const maxLogNodes = () => S.cfg.logBuffer || 8000;
let following = true;
let matchTotal = 0;

/* ── розпізнавання багаторядкових помилок ──
   Ідея: у логах є «записи». Новий запис зазвичай починається з часу або
   рівня. Якщо рядок не схожий на початок запису, він належить попередньому —
   так traceback повністю потрапляє у блок помилки, а не лише перший рядок. */

// початок нового запису: ISO-час, [дата], 2026-08-05 17:43, "INFO:", "1:M 18 Jun", nginx-стиль
const NEW_RECORD_RE = new RegExp([
  "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}",          // 2026-08-05 17:43:09
  "^\\[?\\d{2}[/:]\\w{3}[/:]\\d{4}",                  // [05/Aug/2026
  "^\\[\\d{4}-\\d{2}-\\d{2}",                         // [2026-08-05
  "^\\d{2}:\\d{2}:\\d{2}[.,]?\\d*\\s",                // 17:43:09,502
  "^(INFO|WARN|WARNING|ERROR|ERR|DEBUG|TRACE|FATAL|CRITICAL|NOTICE)\\b[:\\s]", // INFO: ...
  "^\\d+:[A-Z]\\s\\d{2}\\s\\w{3}\\s\\d{4}",           // redis: 1:M 18 Jun 2026
  "^\\w{3}\\s+\\d{1,2}\\s\\d{2}:\\d{2}:\\d{2}",       // syslog: Aug  5 17:43:09
  "^time=\"",                                          // logfmt
  "^\\{\"",                                            // json-логи
].join("|"));

// явні маркери початку помилки
const ERR_START_RE = /(\bERROR\b|\bERR\b|\bCRIT(ICAL)?\b|\bFATAL\b|\bTraceback\b|\bpanic:|\[error\]|level=error|\bUnhandled\b)/i;
// продовження помилки, навіть якщо рядок схожий на новий запис
const ERR_CONT_RE = /^(\s+|Traceback|During handling|The above exception|Caused by|\s*File "|\s*at |\s*\^|\.\.\.|[A-Za-z_.]+(Error|Exception)\b)/;
const WARN_RE = /(\bWARN(ING)?\b|\[warn\]|level=warn)/i;
const DBG_RE = /(\bDEBUG\b|\bTRACE\b|level=debug)/;

function logLevel(line) {
  if (ERR_START_RE.test(line)) return "err";
  if (WARN_RE.test(line)) return "warn";
  if (DBG_RE.test(line)) return "dbg";
  return "info";
}

/**
 * Класифікує рядок з урахуванням блоку.
 * @returns {{lvl: string, start: boolean}} start — рядок відкриває новий блок помилки
 */
function classifyLine(line) {
  const isNewRecord = NEW_RECORD_RE.test(line);
  const looksContinuation = ERR_CONT_RE.test(line);

  // всередині блоку: усе, що не починає новий запис (або явно є продовженням) — той самий рівень
  if (S.logBlock && (!isNewRecord || looksContinuation)) {
    return { lvl: S.logBlock, start: false };
  }

  const lvl = logLevel(line);
  S.logBlock = (lvl === "err" || lvl === "warn") ? lvl : null;
  return { lvl, start: lvl === "err" || lvl === "warn" };
}

function resetLogs(msg) {
  $("logs").innerHTML = msg ? `<span class="meta-line">${esc(msg)}</span>\n` : "";
  S.logLines = S.errCount = S.warnCount = 0;
  S.logBlock = null;
  S.logCarry = "";
  logQueue.length = 0;
  updateLevelCounts();
  following = true;
  setFollowIcon();
  $("logs").classList.toggle("nowrap", !S.logWrap);
}

function setFollowIcon() {
  const b = $("log-follow");
  b.dataset.icon = following ? "pause" : "play";
  applyIcons(b.parentElement ?? document);
}

/* Потік приходить довільними шматками — збираємо повні рядки,
   бо блокова класифікація працює саме порядково. */
function feedLog(chunk, opts = {}) {
  S.logCarry = (S.logCarry || "") + chunk;
  let nl;
  while ((nl = S.logCarry.indexOf("\n")) >= 0) {
    const line = S.logCarry.slice(0, nl);
    S.logCarry = S.logCarry.slice(nl + 1);
    appendLog(line + "\n", opts);
  }
  // хвіст без \n лишаємо до наступного шматка (крім дуже довгих рядків)
  if (S.logCarry.length > 8192) {
    appendLog(S.logCarry, opts);
    S.logCarry = "";
  }
}

async function openLogs() {
  const c = S.selected;
  resetLogs(t("logs.connecting"));
  try {
    await invoke("logs_multi_stop");
    await invoke("start_logs", { conn: S.activeConn, id: c.id, tail: $("log-tail").value });
  } catch (e) { toast("Логи: " + e); }
}

/* A2 — агреговані логи compose-стека */
async function openStackLogs() {
  const st = S.selectedStack;
  resetLogs(`${t("logs.stackAgg")} ${st.project} (${st.rows.length} ${t("logs.services")})…`);
  try {
    await invoke("stop_logs");
    await invoke("logs_multi_start", {
      conn: S.activeConn,
      targets: st.rows.map(r => [r.id, r.service || r.name]),
      tail: $("log-tail").value,
    });
  } catch (e) { toast("Логи стека: " + e); }
}

listen("log-state", ev => {
  const p = ev.payload;
  if (p.conn !== S.activeConn || p.cid !== S.selected?.id || S.view !== "container") return;
  if (p.state === "open") {
    resetLogs(`${t("logs.connected")} ${S.selected.state !== "running" ? t("logs.historyOnly") : t("logs.waiting")}`);
  } else if (p.state === "error") {
    appendLog(`[${t("logs.streamErr")}: ${p.msg}]\n`, { meta: true });
  }
});

listen("docker-log", ev => {
  const p = ev.payload;
  if (p.conn !== S.activeConn || p.cid !== S.selected?.id || S.view !== "container") return;
  feedLog(p.line);
});

listen("docker-log-multi", ev => {
  const p = ev.payload;
  if (p.conn !== S.activeConn || S.view !== "stack") return;
  // у зведених логах блоки рахуємо окремо для кожного сервісу
  S.logBlock = S.multiBlock?.[p.label] ?? null;
  feedLog(p.line, { label: p.label, color: p.color, svcKey: p.label });
});

/* Рядки не вставляємо по одному: контейнер із довгою історією віддає їх
   тисячами, і кожен окремий appendChild + scrollTop коштував секунд прокрутки.
   Складаємо все в чергу й раз на кадр додаємо одним фрагментом — уже з кінця. */
const logQueue = [];
let flushScheduled = false;

function appendLog(text, opts = {}) {
  logQueue.push([text, opts]);
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flushLogs);
}

function flushLogs() {
  flushScheduled = false;
  if (!logQueue.length) return;
  const logs = $("logs");
  // якщо прилетіла історія більша за буфер — показуємо саме хвіст
  const cap = maxLogNodes();
  if (logQueue.length > cap) logQueue.splice(0, logQueue.length - cap);
  const frag = document.createDocumentFragment();
  for (const [text, opts] of logQueue) frag.appendChild(buildLogNode(text, opts));
  S.logLines += logQueue.length;
  logQueue.length = 0;
  logs.appendChild(frag);
  while (logs.childNodes.length > cap) logs.removeChild(logs.firstChild);
  updateLevelCounts();
  if (following) {
    // власна прокрутка не повинна виглядати як «користувач гортає вгору»
    autoScroll = true;
    logs.scrollTop = logs.scrollHeight;
    requestAnimationFrame(() => { autoScroll = false; });
  }
}
let autoScroll = false;

function buildLogNode(text, opts = {}) {
  const span = document.createElement("span");
  if (opts.meta) {
    span.className = "meta-line";
    span.textContent = text;
  } else {
    const { lvl, start } = classifyLine(text);
    if (opts.svcKey) (S.multiBlock ||= {})[opts.svcKey] = S.logBlock;
    span.dataset.lvl = lvl;
    span.dataset.raw = text;
    if (start) span.dataset.blockStart = "1";
    if (opts.label !== undefined) {
      span.dataset.svc = opts.label;
      const tag = document.createElement("span");
      tag.className = "svc c" + (opts.color ?? 0);
      tag.textContent = opts.label.padEnd(14).slice(0, 14) + " | ";
      span.appendChild(tag);
      span.appendChild(document.createTextNode(text));
    } else {
      span.textContent = text;
    }
    if (lvl === "err") { span.classList.add("lvl-err"); if (start) S.errCount++; }
    if (lvl === "warn") { span.classList.add("lvl-warn"); if (start) S.warnCount++; }
    if (lvl === "dbg") span.classList.add("lvl-dbg");
    applyFiltersTo(span);
  }
  return span;
}

function updateLevelCounts() {
  $("cnt-err").textContent = S.errCount;
  $("cnt-warn").textContent = S.warnCount;
}

function applyFiltersTo(node) {
  const q = $("log-search").value;
  const raw = node.dataset.raw ?? node.textContent;
  node.dataset.raw = raw;
  const svc = node.dataset.svc;
  const lvl = node.dataset.lvl || "info";
  const lvlOk = S.logFilter === "all" ||
    (S.logFilter === "err" && lvl === "err") ||
    (S.logFilter === "warn" && (lvl === "err" || lvl === "warn"));
  if (!lvlOk) { node.classList.add("hidden"); return; }
  if (!q) {
    if (node.querySelector("mark")) rebuild(node, raw, svc, null);
    node.classList.remove("hidden");
    return;
  }
  if (raw.toLowerCase().indexOf(q.toLowerCase()) < 0) { node.classList.add("hidden"); return; }
  node.classList.remove("hidden");
  rebuild(node, raw, svc, q);
}

function rebuild(node, raw, svc, q) {
  node.innerHTML = "";
  if (svc !== undefined) {
    const tag = document.createElement("span");
    tag.className = "svc";
    tag.textContent = svc.padEnd(14).slice(0, 14) + " | ";
    node.appendChild(tag);
  }
  if (!q) { node.appendChild(document.createTextNode(raw)); return; }
  let rest = raw; const ql = q.toLowerCase();
  while (true) {
    const i = rest.toLowerCase().indexOf(ql);
    if (i < 0) { node.appendChild(document.createTextNode(rest)); break; }
    node.appendChild(document.createTextNode(rest.slice(0, i)));
    const m = document.createElement("mark");
    m.textContent = rest.slice(i, i + q.length);
    node.appendChild(m);
    rest = rest.slice(i + q.length);
    matchTotal++;
  }
}

function applyFiltersAll() {
  matchTotal = 0;
  const t0 = performance.now();
  for (const n of $("logs").childNodes) if (n.dataset && !n.classList.contains("meta-line")) applyFiltersTo(n);
  const q = $("log-search").value;
  $("log-matches").textContent = q ? `${matchTotal} · ${(performance.now() - t0).toFixed(0)} ms` : "";
  updateLevelCounts();
}

/* A1 — пошук по всій історії на сервері */
function openDeepSearch() {
  const target = S.view === "stack" ? S.selectedStack?.rows?.[0] : S.selected;
  if (!target) return toast(t("welcome.text"));
  $("deep-target").textContent = "· " + (S.view === "stack" ? S.selectedStack.rows[0].name + " (" + t("deep.firstService") + ")" : target.name);
  $("deep-modal").dataset.cid = target.id;
  $("deep-results").innerHTML = "";
  $("deep-stat").textContent = "";
  $("deep-modal").classList.add("open");
  setTimeout(() => $("deep-q").focus(), 60);
}

async function runDeepSearch() {
  const q = $("deep-q").value;
  if (!q) return;
  const cid = $("deep-modal").dataset.cid;
  const since = $("deep-since").value ? Math.floor(Date.now() / 1000) - parseInt($("deep-since").value) : null;
  $("deep-stat").innerHTML = `<span class="spin"></span> ${t("deep.searching")}`;
  $("deep-results").innerHTML = "";
  try {
    const r = await invoke("logs_search", {
      conn: S.activeConn, id: cid, query: q,
      regex: $("deep-re").checked, caseSensitive: $("deep-cs").checked,
      since, limit: 2000,
    });
    $("deep-stat").textContent =
      t("deep.result", { hits: r.hits.length, scanned: r.scanned, ms: r.took_ms }) + (r.truncated ? " · " + t("deep.truncated") : "");
    const box = $("deep-results");
    if (!r.hits.length) { box.innerHTML = `<div class="placeholder">${t("deep.none")}</div>`; return; }
    const frag = document.createDocumentFragment();
    for (const h of r.hits) {
      const d = document.createElement("div");
      d.className = "hit";
      const ln = document.createElement("span");
      ln.className = "ln";
      ln.textContent = "#" + h.index;
      d.appendChild(ln);
      // підсвітка збігу
      if (!$("deep-re").checked) {
        let rest = h.line; const ql = q.toLowerCase();
        while (true) {
          const i = ($("deep-cs").checked ? rest : rest.toLowerCase()).indexOf($("deep-cs").checked ? q : ql);
          if (i < 0) { d.appendChild(document.createTextNode(rest)); break; }
          d.appendChild(document.createTextNode(rest.slice(0, i)));
          const m = document.createElement("mark");
          m.textContent = rest.slice(i, i + q.length);
          d.appendChild(m);
          rest = rest.slice(i + q.length);
        }
      } else {
        d.appendChild(document.createTextNode(h.line));
      }
      frag.appendChild(d);
    }
    box.appendChild(frag);
  } catch (e) {
    $("deep-stat").textContent = "";
    toast("Пошук: " + e);
  }
}

/**
 * Уся помилка цілком — від рядка, що відкрив блок, до кінця traceback.
 * Межі блоку вже пораховані при розборі логу, тож копіювати мишею 40 рядків
 * більше не треба.
 * @returns {string} порожній рядок, якщо клікнули не по помилці
 */
function errorBlockAt(node) {
  const lvl = node.dataset.lvl;
  if (lvl !== "err" && lvl !== "warn") return "";
  let start = node;
  while (start && !start.dataset.blockStart) {
    const prev = start.previousElementSibling;
    if (!prev || prev.dataset.lvl !== lvl) break;
    start = prev;
  }
  const out = [];
  for (let n = start; n; n = n.nextElementSibling) {
    if (n !== start && (n.dataset.blockStart || n.dataset.lvl !== lvl)) break;
    out.push(n.dataset.raw ?? n.textContent);
  }
  return out.join("").trimEnd();
}

function wireLogsUI() {
  $("log-search").oninput = applyFiltersAll;
  $("log-level").querySelectorAll("button").forEach(b => b.onclick = () => {
    S.logFilter = b.dataset.lvl;
    $("log-level").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    applyFiltersAll();
  });
  $("log-tail").onchange = () => {
    if (S.view === "container" && S.tab === "logs") openLogs();
    if (S.view === "stack" && S.stackTab === "logs") openStackLogs();
  };
  $("log-follow").onclick = () => {
    following = !following;
    setFollowIcon();
    if (following) $("logs").scrollTop = $("logs").scrollHeight;
  };
  $("log-wrap").onclick = () => {
    S.logWrap = !S.logWrap;
    $("logs").classList.toggle("nowrap", !S.logWrap);
    $("log-wrap").classList.toggle("primary", !S.logWrap);
    persist();
  };
  $("log-clear").onclick = () => { resetLogs(""); };
  $("log-export").onclick = () => {
    const text = [...$("logs").childNodes].map(n => n.dataset?.raw ?? n.textContent).join("");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = (S.selectedStack?.project || S.selected?.name || "logs") + ".log";
    a.click();
  };
  $("log-deep").onclick = openDeepSearch;
  $("deep-go").onclick = runDeepSearch;
  $("deep-q").onkeydown = e => { if (e.key === "Enter") runDeepSearch(); };
  /* У логах найчастіше потрібно саме скопіювати — рядок або весь буфер. */
  $("logs").addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    const sel = String(window.getSelection?.() ?? "").trim();
    const node = e.target instanceof Element ? e.target.closest("#logs > span") : null;
    const line = node?.dataset?.raw ?? node?.textContent ?? "";
    const all = () => [...$("logs").childNodes].map(n => n.dataset?.raw ?? n.textContent).join("");
    const block = node ? errorBlockAt(node) : "";
    showContextMenu(e.clientX, e.clientY, [
      { icon: "copy", label: t("ctx.copy"), hint: "Ctrl+C", disabled: !sel, run: () => copyText(sel) },
      { icon: "file", label: t("ctx.copyLine"), disabled: !line, run: () => copyText(line.trimEnd()) },
      { icon: "alert", label: t("ctx.copyBlock"), disabled: !block, run: () => copyText(block) },
      { icon: "clipboard", label: t("ctx.copyAll"), run: () => copyText(all()) },
      "-",
      { icon: "search", label: t("logs.deep"), run: openDeepSearch },
      { icon: "download", label: t("logs.export"), run: () => $("log-export").click() },
      { icon: "eraser", label: t("logs.clear"), run: () => resetLogs("") },
    ]);
  });

  $("logs").onscroll = () => {
    if (autoScroll) return;
    const el = $("logs");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    if (!atBottom && following) { following = false; setFollowIcon(); }
  };
}

/* стріми статистики контейнера — сюди ж, бо показуються в шапці логів */
function statsHtml(s) {
  return `CPU <b>${s.cpu_pct.toFixed(1)}%</b> · RAM <b>${fmtBytes(s.mem_usage)}</b>${s.mem_limit ? " / " + fmtBytes(s.mem_limit) : ""}`;
}

listen("docker-stats", ev => {
  const p = ev.payload;
  if (p.conn !== S.activeConn) return;
  S.ctrStats[p.cid] = p;                       // кешуємо — переживає перемальовку шапки
  if (p.cid !== S.selected?.id) return;
  const el = $("livestats");
  if (!el) return;
  const hist = pushHist(S.ctrHist, p.cid, p.cpu_pct);
  el.innerHTML = statsHtml(p);
  el.title = `пік CPU: ${Math.max(...hist).toFixed(1)}%`;
});
