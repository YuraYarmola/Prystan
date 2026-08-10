"use strict";
/* Ядро: стан, хелпери, діалоги, тема, персистентність */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = id => document.getElementById(id);

/* ── формати ── */
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
/* Одиниці теж перекладаються: інакше англійський інтерфейс показує «ГБ». */
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + " " + t("unit.gb");
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + " " + t("unit.mb");
  if (b >= 1024) return (b / 1024).toFixed(0) + " " + t("unit.kb");
  return b + " " + t("unit.b");
}
function fmtAgo(unixSec) {
  const d = Math.floor(Date.now() / 1000 - unixSec);
  if (d < 3600) return t("unit.agoMin", { n: Math.floor(d / 60) });
  if (d < 86400) return t("unit.agoHour", { n: Math.floor(d / 3600) });
  return t("unit.agoDay", { n: Math.floor(d / 86400) });
}
function fmtDur(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return (d ? d + t("unit.d") + " " : "") + h + t("unit.h") + " " + m + t("unit.m");
}
const te = new TextEncoder(), td = new TextDecoder();
function u8ToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToU8(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const strToB64 = s => u8ToB64(te.encode(s));
const b64ToStr = b => td.decode(b64ToU8(b));

/* ── стан ── */
const S = {
  profiles: [], conns: {}, activeConn: null,
  containers: [], images: [], volumes: [], networks: [],
  view: "welcome",            // welcome | container | stack | server | images | volumes | networks | df | dash
  selected: null, selectedStack: null,
  tab: "logs", srvTab: "stats", stackTab: "logs",
  pending: {}, collapsed: new Map(), connsCollapsed: false,
  quick: "all", bulkMode: false, bulkSel: new Set(),
  filesPath: {}, terms: {}, termActive: {},
  logLines: 0, errCount: 0, warnCount: 0, logFilter: "all", logWrap: true,
  editor: null, editorCtx: null, editorDirty: false,
  mon: {}, monActive: null, monHist: {}, ctrHist: {},
  ctrStats: {},          // cid -> останні CPU/RAM (щоб бейдж не блимав при перемальовці)
  statsFor: null,        // для якого контейнера вже йде стрім статистики
  forwards: [], lastEntries: [], snippets: [],
  fsClip: null, fsSelected: null,        // буфер copy/cut і вибраний файл
  theme: "dark",
  logBlock: null, logCarry: "", multiBlock: {},   // стан розбору багаторядкових помилок
  cmdHistory: [], termSuggest: true,              // автодоповнення терміналу
  tgAlerts: false,                                // дублювати алерти в Telegram
  tgEvents: { ctrDie: true, thresholds: true, connLost: false, composeDone: false },
  loading: false,                                 // йде перше завантаження підключення
  projects: [], project: null, projTab: "files",  // локальні теки проєктів
  duPath: {}, duData: {},                         // аналіз використання диска
  crashing: {},                                   // conn:id -> скільки падінь поспіль
  cursor: -1, treeItems: [],                      // навігація деревом з клавіатури
  topRows: [], topSort: "cpu_pct",                // таблиця навантаження
  update: null,                                   // результат перевірки версії
  cfg: {
    pollFast: 4,          // с — легке опитування списку контейнерів
    pollFull: 30,         // с — повне оновлення
    bgMonitor: 30,        // с — монітор фонових серверів (0 — вимкнути)
    logBuffer: 8000,      // рядків тримаємо в DOM
    defaultShell: "/bin/bash",
    confirmDestructive: true,
    checkUpdates: true,
    editorDock: false,    // редактор збоку, а не поверх усього
    leftWidth: 380,
  },
};

const activeProfile = () => S.profiles.find(p => p.id === S.activeConn);
// Проєкт лежить на цій машині й до профілю сервера стосунку не має:
// read-only на проді не повинен забороняти правити власні файли.
const isReadonly = () => S.view !== "project" && !!activeProfile()?.readonly;
const isHostView = () => S.view === "server";
function targetKey() {
  if (S.view === "project") return "@proj:" + (S.project?.id ?? "");
  if (S.view === "server") return S.activeConn + ":@host";
  if (S.view === "stack") return S.activeConn + ":@stack:" + (S.selectedStack?.project ?? "");
  return S.activeConn + ":" + (S.selected?.id ?? "");
}

/* ── персистентність ── */
function persist() {
  try {
    localStorage.setItem("da-ui", JSON.stringify({
      collapsed: [...S.collapsed], connsCollapsed: S.connsCollapsed, projCollapsed: S.projCollapsed,
      lastConn: S.activeConn, theme: S.theme, quick: S.quick,
      snippets: S.snippets, logWrap: S.logWrap, lang: LANG,
      cmdHistory: S.cmdHistory, termSuggest: S.termSuggest, tgAlerts: S.tgAlerts,
      tgEvents: S.tgEvents, cfg: S.cfg,
    }));
  } catch {}
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem("da-ui") || "{}");
    if (s.collapsed) S.collapsed = new Map(s.collapsed);
    if (typeof s.connsCollapsed === "boolean") S.connsCollapsed = s.connsCollapsed;
    if (typeof s.projCollapsed === "boolean") S.projCollapsed = s.projCollapsed;
    if (typeof s.logWrap === "boolean") S.logWrap = s.logWrap;
    if (s.quick) S.quick = s.quick;
    if (Array.isArray(s.snippets)) S.snippets = s.snippets;
    if (Array.isArray(s.cmdHistory)) S.cmdHistory = s.cmdHistory;
    if (typeof s.termSuggest === "boolean") S.termSuggest = s.termSuggest;
    if (typeof s.tgAlerts === "boolean") S.tgAlerts = s.tgAlerts;
    if (s.tgEvents && typeof s.tgEvents === "object") Object.assign(S.tgEvents, s.tgEvents);
    if (s.cfg && typeof s.cfg === "object") Object.assign(S.cfg, s.cfg);
    setTheme(s.theme || "dark", true);
    setLang(s.lang || (navigator.language || "uk").slice(0, 2).replace("ua", "uk"), true);
    return s.lastConn;
  } catch { return null; }
}

/* ── тема ── */
function setTheme(t, silent) {
  S.theme = t;
  document.documentElement.setAttribute("data-theme", t);
  const btn = $("theme-btn");
  if (btn) {
    btn.dataset.icon = t === "dark" ? "moon" : "sun";
    applyIcons(btn.parentElement ?? document);
  }
  if (!silent) persist();
  // перемалювати термінали під нову тему
  for (const list of Object.values(S.terms)) {
    for (const s of list) s.term.options.theme = termTheme();
  }
}

/* ── тости ── */
function toast(msg, kind = "err", ms = 5000) {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  $("toast-wrap").appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ── діалог ── */
function ask({ title, text, input = null, okLabel = null }) {
  return new Promise(resolve => {
    $("ask-title").textContent = title;
    $("ask-text").innerHTML = text;
    const inp = $("ask-input");
    inp.style.display = input === null ? "none" : "block";
    inp.value = input || "";
    $("ask-yes").textContent = okLabel ?? t("common.ok");
    $("ask-no").textContent = t("common.cancel");
    $("ask-modal").classList.add("open");
    if (input !== null) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = v => { $("ask-modal").classList.remove("open"); cleanup(); resolve(v); };
    const onYes = () => done(input === null ? true : inp.value);
    const onNo = () => done(null);
    const onKey = e => {
      if (e.key === "Enter") { e.stopPropagation(); onYes(); }
      if (e.key === "Escape") { e.stopPropagation(); onNo(); }
    };
    function cleanup() {
      $("ask-yes").removeEventListener("click", onYes);
      $("ask-no").removeEventListener("click", onNo);
      document.removeEventListener("keydown", onKey, true);
    }
    $("ask-yes").addEventListener("click", onYes);
    $("ask-no").addEventListener("click", onNo);
    document.addEventListener("keydown", onKey, true);
  });
}

/* C8 — охорона для змінюючих дій на read-only профілях */
function guardRW(whatKey = "guard.containerAction") {
  if (isReadonly()) {
    toast(t("common.blocked", { name: activeProfile().name, what: t(whatKey) }), "warn", 4000);
    return false;
  }
  return true;
}

/* ── контекстне меню ──
   items: [{ label, icon, run, danger, disabled, hint }] або "-" як роздільник */
function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  for (const it of items) {
    if (it === "-") {
      const hr = document.createElement("div");
      hr.className = "ctxsep";
      menu.appendChild(hr);
      continue;
    }
    const el = document.createElement("div");
    el.className = "ctxitem" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "");
    el.innerHTML = `<span class="ci">${ic(it.icon ?? "")}</span><span class="cl">${esc(it.label)}</span>` +
      (it.hint ? `<span class="ch">${esc(it.hint)}</span>` : "");
    if (!it.disabled) {
      el.onclick = e => { e.stopPropagation(); hideContextMenu(); it.run(); };
    }
    menu.appendChild(el);
  }
  document.body.appendChild(menu);

  // тримаємо меню в межах вікна
  const r = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = Math.min(y, window.innerHeight - r.height - 8);
  menu.style.left = Math.max(4, left) + "px";
  menu.style.top = Math.max(4, top) + "px";

  ctxOpen = true;
}

/* Меню закривають слухачі, поставлені один раз на весь час життя застосунку.
   Раніше кожне відкриття вішало одноразові — і якщо меню закривалося не через
   них (клік по пункту, stopPropagation у панелі), вони лишалися звисати й
   гасили вже наступне меню. Тепер накопичувати нічого: слухачі одні й ті самі,
   а стан тримає один прапорець.
   Перехоплюємо саме pointerdown у фазі захоплення — тоді ніякий
   stopPropagation нижче по дереву не заважає меню закритись. */
let ctxOpen = false;

function hideContextMenu() {
  ctxOpen = false;
  document.querySelectorAll(".ctxmenu").forEach(m => m.remove());
}

document.addEventListener("pointerdown", e => {
  if (!ctxOpen) return;
  if (e.target instanceof Element && e.target.closest(".ctxmenu")) return; // клік по пункту
  hideContextMenu();
}, true);
document.addEventListener("keydown", e => {
  if (ctxOpen && e.key === "Escape") { e.stopPropagation(); hideContextMenu(); }
}, true);
window.addEventListener("blur", hideContextMenu);
window.addEventListener("resize", hideContextMenu);

/* ── стани завантаження ──
   Кожна довга операція має показувати, що вона триває: без цього
   застосунок виглядає зависшим саме тоді, коли він найбільше працює. */
function loadingBox(msg) {
  return `<div class="placeholder"><span class="spin"></span> ${esc(msg ?? t("common.loading"))}</div>`;
}
function errorBox(e) {
  return `<div class="placeholder">${ic("alert")} ${esc(String(e))}</div>`;
}
function skeleton(n = 7) {
  return `<div class="skel">${"<i></i>".repeat(n)}</div>`;
}
/** Смужка прогресу під шапкою — для фонових операцій без власного місця. */
function setBusy(on) {
  $("loadbar")?.classList.toggle("on", !!on);
}

/* ── буфер обміну ──
   navigator.clipboard доступний лише сфокусованому вікну й не всюди дозволений,
   тому лишаємо запасний шлях через приховане поле. */
async function copyText(text, quiet) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    if (!quiet) toast(t("common.copied"), "ok", 1500);
    return true;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  if (!quiet) toast(ok ? t("common.copied") : t("common.copyFailed"), ok ? "ok" : "warn", ok ? 1500 : 4000);
  return ok;
}

/**
 * Прочитати буфер обміну через систему.
 * navigator.clipboard.readText() тут не годиться: WebView2 питає дозвіл і до
 * відповіді промис висить, тож інтерфейс просто завмирає.
 * @returns {Promise<string|null>} null — прочитати не вдалося
 */
async function readClipboard() {
  try { return await invoke("clipboard_read"); }
  catch { return null; }
}

/* ── дрібні утиліти ── */
const joinPath = (a, b) => (a === "/" ? "" : a) + "/" + b;
const parentPath = p => p.split("/").slice(0, -1).join("/") || "/";

function sparkline(values, max) {
  if (!values || values.length < 2) return "";
  const w = 200, h = 28;
  const top = max || Math.max(...values, 1);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / top) * h).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path class="fill" d="M0,${h} L${pts.join(" L")} L${w},${h} Z"></path>
    <path d="M${pts.join(" L")}"></path></svg>`;
}

function pushHist(store, key, value, cap = 40) {
  if (!store[key]) store[key] = [];
  store[key].push(value);
  if (store[key].length > cap) store[key].shift();
  return store[key];
}
