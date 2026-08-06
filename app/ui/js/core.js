"use strict";
/* Ядро: стан, хелпери, діалоги, тема, персистентність */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = id => document.getElementById(id);

/* ── формати ── */
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + " ГБ";
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + " МБ";
  if (b >= 1024) return (b / 1024).toFixed(0) + " КБ";
  return b + " Б";
}
function fmtAgo(unixSec) {
  const d = Math.floor(Date.now() / 1000 - unixSec);
  if (d < 3600) return Math.floor(d / 60) + " хв тому";
  if (d < 86400) return Math.floor(d / 3600) + " год тому";
  return Math.floor(d / 86400) + " дн тому";
}
function fmtDur(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return (d ? d + "д " : "") + h + "год " + m + "хв";
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
  theme: "dark",
  logBlock: null, logCarry: "", multiBlock: {},   // стан розбору багаторядкових помилок
  cmdHistory: [], termSuggest: true,              // автодоповнення терміналу
  tgAlerts: false,                                // дублювати алерти в Telegram
};

const activeProfile = () => S.profiles.find(p => p.id === S.activeConn);
const isReadonly = () => !!activeProfile()?.readonly;
const isHostView = () => S.view === "server";
function targetKey() {
  if (S.view === "server") return S.activeConn + ":@host";
  if (S.view === "stack") return S.activeConn + ":@stack:" + (S.selectedStack?.project ?? "");
  return S.activeConn + ":" + (S.selected?.id ?? "");
}

/* ── персистентність ── */
function persist() {
  try {
    localStorage.setItem("da-ui", JSON.stringify({
      collapsed: [...S.collapsed], connsCollapsed: S.connsCollapsed,
      lastConn: S.activeConn, theme: S.theme, quick: S.quick,
      snippets: S.snippets, logWrap: S.logWrap, lang: LANG,
      cmdHistory: S.cmdHistory, termSuggest: S.termSuggest, tgAlerts: S.tgAlerts,
    }));
  } catch {}
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem("da-ui") || "{}");
    if (s.collapsed) S.collapsed = new Map(s.collapsed);
    if (typeof s.connsCollapsed === "boolean") S.connsCollapsed = s.connsCollapsed;
    if (typeof s.logWrap === "boolean") S.logWrap = s.logWrap;
    if (s.quick) S.quick = s.quick;
    if (Array.isArray(s.snippets)) S.snippets = s.snippets;
    if (Array.isArray(s.cmdHistory)) S.cmdHistory = s.cmdHistory;
    if (typeof s.termSuggest === "boolean") S.termSuggest = s.termSuggest;
    if (typeof s.tgAlerts === "boolean") S.tgAlerts = s.tgAlerts;
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
  if (btn) btn.textContent = t === "dark" ? "🌙" : "☀️";
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
