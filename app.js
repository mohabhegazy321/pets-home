/* Pets Home — local edition: runs on one phone, no internet or accounts needed. All data is saved on the device (IndexedDB).
   Stock by plates, production, orders, invoices, customers, expenses, counts, reports, audit log. */
(function () {
"use strict";

/* ================== Utilities ================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
const nf = (n, d = 2) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const cur = () => settings().currency || "ج.م";
const money = n => `${nf(n, 2)} ${cur()}`;
const fmtDate = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };
const fmtTime = iso => { if (!iso) return ""; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDT = iso => { if (!iso) return ""; const d = new Date(iso); return `${fmtDate(ymd(d))} ${fmtTime(iso)}`; };
const localDay = iso => ymd(new Date(iso));
const DAYS = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
const dayName = s => DAYS[new Date(s + "T12:00:00").getDay()];
const pnum = v => { const x = parseFloat(String(v ?? "").trim().replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace("٫", ".").replace(",", ".")); return isFinite(x) ? x : NaN; };
const nowISO = () => new Date().toISOString();

/* ================== State & on-device storage ================== */
const APP_VERSION = "local-2";
/* Storage format version. Raise it only together with a migration in MIGRATIONS below — never by changing or dropping saved data. */
const SCHEMA = 1;
const PLAIN = ["meta", "items", "workers", "customers"];
const BUCKETED = ["moves", "orders", "payments", "finance", "counts"];
const COLS = [...PLAIN, ...BUCKETED, "audit"];
const S = {}; COLS.forEach(c => S[c] = new Map());
let ver = 0; const memoCache = {};
function memo(k, fn) { const c = memoCache[k]; if (c && c.v === ver) return c.val; const val = fn(); memoCache[k] = { v: ver, val }; return val; }

let phase = "boot";
const OWNER_ID = "owner";
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const toMap = obj => new Map(Object.entries(obj || {}).map(([id, v]) => [id, Object.assign({}, v, { id })]));
const fromMap = m => { const o = {}; m.forEach((v, id) => { const { id: _, ...rest } = v; o[id] = rest; }); return o; };

/* Everything is saved on this phone: IndexedDB (one entry per collection), localStorage as a fallback.
   Other open copies of the app (e.g. browser tab + installed app) are told to reload what changed. */
const Local = {
  db: null, dirty: new Set(), timer: null, warned: false, chan: null,
  open() {
    return new Promise(res => {
      if (!window.indexedDB) return res(null);
      let req; try { req = indexedDB.open("petshome-local", 1); } catch { return res(null); }
      req.onupgradeneeded = () => { try { req.result.createObjectStore("kv"); } catch {} };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onblocked = () => res(null);
    });
  },
  canWrite: false, snapInfo: null,
  /* Returns { ok, data }. ok=false means the saved data could not be read: the app must not start empty and save over it. */
  async init() {
    this.db = await this.open();
    if (!this.db && window.indexedDB) return { ok: false, data: {} };
    try { this.chan = new BroadcastChannel("petshome-local"); this.chan.onmessage = e => this.reload(e.data && e.data.cols); } catch {}
    return this.read(COLS);
  },
  read(cols) {
    if (!this.db) {
      const out = {}; let ok = true;
      cols.forEach(c => { try { out[c] = JSON.parse(lsGet("petshome:col:" + c) || "{}"); } catch { ok = false; } });
      return Promise.resolve({ ok, data: out });
    }
    return new Promise(res => {
      const out = {}; let tx, ok = true;
      try { tx = this.db.transaction("kv", "readonly"); } catch { return res({ ok: false, data: out }); }
      const st = tx.objectStore("kv");
      cols.forEach(c => { const r = st.get(c); r.onsuccess = () => { out[c] = r.result || {}; }; r.onerror = () => { ok = false; }; });
      tx.oncomplete = () => res({ ok, data: out }); tx.onerror = () => res({ ok: false, data: out }); tx.onabort = () => res({ ok: false, data: out });
    });
  },
  /* Single extra keys (version marker, snapshots) stored next to the collections. */
  getKey(key) {
    if (!this.db) { try { return Promise.resolve(JSON.parse(lsGet("petshome:" + key) || "null")); } catch { return Promise.resolve(null); } }
    return new Promise(res => {
      try { const r = this.db.transaction("kv", "readonly").objectStore("kv").get(key); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); }
      catch { res(null); }
    });
  },
  putKey(key, val) {
    if (!this.db) { try { localStorage.setItem("petshome:" + key, JSON.stringify(val)); return Promise.resolve(true); } catch { return Promise.resolve(false); } }
    return new Promise(res => {
      try { const tx = this.db.transaction("kv", "readwrite"); tx.objectStore("kv").put(val, key); tx.oncomplete = () => res(true); tx.onerror = tx.onabort = () => res(false); }
      catch { res(false); }
    });
  },
  /* Saves a full copy of the farm data on the phone before anything that replaces data (app update, reset, restore). */
  async snapshot(reason, fromVersion) {
    if (S.meta.size === 0 && recordCount() === 0) return false;   // never replace a good snapshot with an empty one
    const data = {}; COLS.forEach(c => data[c] = fromMap(S[c]));
    const info = { reason, at: nowISO(), fromVersion: fromVersion || APP_VERSION, count: recordCount() };
    const ok = await this.putKey("__snapshot", { info, data });
    if (ok) { await this.putKey("__snapshot_info", info); this.snapInfo = info; }
    return ok;
  },
  async reload(cols) {
    if (!Array.isArray(cols) || !cols.length) return;
    const r = await this.read(cols); if (!r.ok) return;
    const data = r.data;
    cols.forEach(c => { if (COLS.includes(c) && !this.dirty.has(c)) S[c] = toMap(data[c]); });
    ver++; scheduleRender();
  },
  mark(col) { this.dirty.add(col); clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 200); },
  flush() {
    clearTimeout(this.timer);
    if (!this.canWrite) return Promise.resolve();
    const cols = [...this.dirty]; this.dirty.clear();
    if (!cols.length) return Promise.resolve();
    const payload = {}; cols.forEach(c => payload[c] = fromMap(S[c]));
    const done = () => { this.warned = false; try { this.chan && this.chan.postMessage({ cols }); } catch {} };
    const fail = err => {
      console.error("save failed", err); cols.forEach(c => this.dirty.add(c));
      if (!this.warned) { this.warned = true; toast("تعذر الحفظ على الموبايل. تأكد من وجود مساحة فارغة، ونزّل نسخة احتياطية."); }
    };
    if (!this.db) {
      try { cols.forEach(c => localStorage.setItem("petshome:col:" + c, JSON.stringify(payload[c]))); done(); } catch (e) { fail(e); }
      return Promise.resolve();
    }
    return new Promise(res => {
      let tx; try { tx = this.db.transaction("kv", "readwrite"); } catch (e) { fail(e); return res(); }
      const st = tx.objectStore("kv"); cols.forEach(c => st.put(payload[c], c));
      tx.oncomplete = () => { done(); res(); };
      tx.onabort = () => { fail(tx.error); res(); };
    });
  }
};
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") Local.flush(); });
window.addEventListener("pagehide", () => Local.flush());

const Store = {
  newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
  put(col, id, data) {
    const clean = JSON.parse(JSON.stringify(data)); delete clean.id;
    const m = new Map(S[col]); m.set(id, Object.assign({}, clean, { id })); S[col] = m; ver++; Local.mark(col); scheduleRender();
    return Promise.resolve();
  },
  remove(col, id) {
    const m = new Map(S[col]); m.delete(id); S[col] = m; ver++; Local.mark(col); scheduleRender();
    return Promise.resolve();
  }
};

/* ================== Domain helpers ================== */
const settings = () => S.meta.get("settings") || { farmName: "Pets Home", currency: "ج.م" };
const items = (all = false) => [...S.items.values()].filter(i => all || i.active !== false).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
const item = id => S.items.get(id);
const itemName = id => item(id)?.name || "صنف محذوف";
const unitOf = id => item(id)?.unit || "";
const workers = (all = false) => [...S.workers.values()].filter(w => all || w.active !== false).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
const ownerName = () => settings().ownerName || "المدير";
const wName = id => !id || id === OWNER_ID ? ownerName() : (S.workers.get(id)?.name || "—");
const customers = () => [...S.customers.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
const custName = id => S.customers.get(id)?.name || "عميل نقدي";
const me = () => ({ id: OWNER_ID, name: ownerName(), role: "manager" });
const isMgr = () => true;
const PERMS = [["production","تسجيل الإنتاج اليومي"],["orders","الأوردرات والفواتير"],["payments","تحصيل من العملاء"],["withdraw","السحب من المخزون"],["finance","المصروفات والإيرادات"],["count","الجرد الفعلي"],["reports","التقارير والحسابات"],["log","سجل العمليات"]];
const can = () => true;
/* "Responsible worker": an optional name picked on each entry (no worker logins in the local edition). */
let pendingBy = null;
const lastBy = () => { const v = lsGet("petshome:lastBy"); return v && (v === OWNER_ID || (S.workers.has(v) && S.workers.get(v).active !== false)) ? v : OWNER_ID; };
function byField(sel) {
  if (!workers().length) return "";
  const cur = sel || lastBy();
  return field("العامل المسؤول", `<select name="by" id="f-by">${opt(OWNER_ID, ownerName(), cur)}${workers(true).filter(w => w.active !== false || w.id === cur).map(w => opt(w.id, w.name, cur)).join("")}</select>`);
}
function byVal(fd) { const v = (fd.get("by") || "").toString() || lastBy(); lsSet("petshome:lastBy", v); pendingBy = v; return v; }

const EXP_CATS = ["خامات","أكل","أدوات","نقل","صيانة","أجور","كهرباء ومياه","إيجار","أخرى"];
const INC_CATS = ["بيع خارج الأوردرات","تحصيل آخر","أخرى"];
const WD_REASONS = ["استخدام داخلي","تالف","نافق","عينات","هدية","أخرى"];
const UNITS = ["كجم","جرام","عدد","لتر"];
const KIND = { opening: "رصيد افتتاحي", production: "إنتاج", sale: "مبيعات", withdraw: "سحب", adjust: "تسوية جرد" };

/* Unified stock ledger: every plate in or out, from moves + orders */
function ledger() {
  return memo("ledger", () => {
    const out = [];
    for (const m of S.moves.values()) {
      const sg = m.type === "withdraw" ? -1 : 1;
      out.push({ src: "move", id: m.id, date: m.date, at: m.at, itemId: m.itemId, kind: m.type, plates: sg * (+m.plates || 0), qty: sg * (+m.qty || 0), by: m.by, note: m.type === "withdraw" ? (m.reason || "") + (m.note ? " — " + m.note : "") : (m.note || "") });
    }
    for (const o of S.orders.values()) {
      if (o.status === "cancelled") continue;
      (o.lines || []).forEach(l => out.push({ src: "order", id: o.id, date: o.date, at: o.at, itemId: l.itemId, kind: "sale", plates: -(+l.plates || 0), qty: -(+l.qty || 0), by: o.by, note: `أوردر ${o.no} — ${custName(o.customerId)}` }));
    }
    out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || "") < (b.at || "") ? -1 : (a.at || "") > (b.at || "") ? 1 : 0);
    return out;
  });
}
function stockSummary(from, to) {
  return memo("ss:" + from + ":" + to, () => {
    const map = new Map();
    const get = id => { if (!map.has(id)) map.set(id, { itemId: id, before: 0, beforeQ: 0, opening: 0, production: 0, sale: 0, withdraw: 0, adjust: 0, openingQ: 0, productionQ: 0, saleQ: 0, withdrawQ: 0, adjustQ: 0, closing: 0, closingQ: 0 }); return map.get(id); };
    items(true).forEach(i => get(i.id));
    for (const e of ledger()) {
      if (to && e.date > to) continue;
      const r = get(e.itemId);
      if (from && e.date < from) { r.before += e.plates; r.beforeQ += e.qty; }
      else if (e.kind === "adjust") { r.adjust += e.plates; r.adjustQ += e.qty; }
      else { r[e.kind] += Math.abs(e.plates); r[e.kind + "Q"] += Math.abs(e.qty); }
      r.closing += e.plates; r.closingQ += e.qty;
    }
    map.forEach(r => Object.keys(r).forEach(k => { if (typeof r[k] === "number") r[k] = r2(r[k]); }));
    return map;
  });
}
const balance = id => stockSummary("", "").get(id) || { closing: 0, closingQ: 0 };

function orderPaid(o) { let p = +o.paidNow || 0; for (const pay of S.payments.values()) if (pay.orderId === o.id) p += +pay.amount || 0; return r2(p); }
function orderPayState(o) { const p = orderPaid(o), t = +o.total || 0; if (t <= 0 || p >= t - 0.005) return "paid"; return p > 0 ? "partial" : "credit"; }
const PAY_LABEL = { paid: ["تم الدفع", "good"], partial: ["متبقي جزء", "warn"], credit: ["آجل", "bad"] };
const ST_LABEL = { prepared: ["تم التجهيز", "plate"], delivered: ["تم التسليم", "acc"], cancelled: ["ملغي", ""] };
function custBalances() {
  return memo("cb", () => {
    const m = new Map(); const g = id => { if (!m.has(id)) m.set(id, { sales: 0, paid: 0, count: 0 }); return m.get(id); };
    for (const o of S.orders.values()) { if (o.status === "cancelled") continue; const r = g(o.customerId || ""); r.sales += +o.total || 0; r.paid += +o.paidNow || 0; r.count++; }
    for (const p of S.payments.values()) g(p.customerId || "").paid += +p.amount || 0;
    m.forEach(r => { r.sales = r2(r.sales); r.paid = r2(r.paid); r.due = r2(r.sales - r.paid); });
    return m;
  });
}
const totalReceivable = () => { let t = 0; custBalances().forEach(r => { if (r.due > 0) t += r.due; }); return r2(t); };
const inRange = (d, f, t) => (!f || d >= f) && (!t || d <= t);
function moneySummary(f, t) {
  return memo("ms:" + f + ":" + t, () => {
    const r = { sales: 0, orders: 0, collectedAtOrder: 0, payments: 0, income: 0, incomeCash: 0, expense: 0, expenseCash: 0, expenseCredit: 0, byCat: {} };
    for (const o of S.orders.values()) if (o.status !== "cancelled" && inRange(o.date, f, t)) { r.sales += +o.total || 0; r.orders++; r.collectedAtOrder += +o.paidNow || 0; }
    for (const p of S.payments.values()) if (inRange(p.date, f, t)) r.payments += +p.amount || 0;
    for (const x of S.finance.values()) if (inRange(x.date, f, t)) {
      const a = +x.amount || 0;
      if (x.kind === "income") { r.income += a; if (x.payType !== "credit") r.incomeCash += a; }
      else { r.expense += a; if (x.payType === "credit") r.expenseCredit += a; else r.expenseCash += a; r.byCat[x.category] = (r.byCat[x.category] || 0) + a; }
    }
    r.net = r2(r.sales + r.income - r.expense);
    return r;
  });
}

/* ================== Audit log ================== */
const FIELD_LABEL = { date: "التاريخ", itemId: "الصنف", plates: "الأطباق", qty: "الكمية", note: "ملاحظة", reason: "السبب", amount: "المبلغ", category: "البند", kind: "النوع", payType: "طريقة الدفع", customerId: "العميل", lines: "الأصناف", total: "الإجمالي", subtotal: "قبل الخصم", paidNow: "المدفوع", status: "الحالة", discount: "الخصم", name: "الاسم", price: "السعر", perPlate: "وزن/عدد الطبق", unit: "الوحدة", role: "الدور", perms: "الصلاحيات", active: "نشط", orderId: "الأوردر", method: "الطريقة", phone: "التليفون", minPlates: "حد التنبيه", priceBasis: "أساس السعر", farmName: "اسم المزرعة", currency: "العملة", by: "العامل المسؤول", ownerName: "اسم المدير" };
function fmtVal(k, v) {
  if (v == null || v === "") return "—";
  if (k === "itemId") return itemName(v);
  if (k === "by") return wName(v);
  if (k === "customerId") return custName(v);
  if (k === "lines") return (v || []).map(l => `${itemName(l.itemId)} ${nf(l.plates)}ط`).join("، ");
  if (k === "status") return (ST_LABEL[v] || [v])[0];
  if (k === "perms") return PERMS.filter(([p]) => v[p]).map(([, l]) => l).join("، ") || "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function diff(a, b) {
  const out = []; const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => { if (["id","at","no","editedAt","editedBy","ownerUid","username","lastBackup","demo","createdAt"].includes(k)) return; if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out.push({ f: k, from: fmtVal(k, a?.[k]), to: fmtVal(k, b?.[k]) }); });
  return out;
}
function audit(action, entity, entityId, summary, before, after) {
  const date = today(); const by = pendingBy || OWNER_ID; pendingBy = null;
  const e = { at: nowISO(), by, action, entity, entityId: entityId || "", summary };
  if (before && after) e.changes = diff(before, after);
  const cur = S.audit.get(date);
  Store.put("audit", date, { date, entries: (cur ? cur.entries || [] : []).concat([e]) });
}
const allAudit = () => memo("audit", () => { const out = []; for (const d of S.audit.values()) (d.entries || []).forEach(e => out.push(e)); return out.sort((a, b) => a.at < b.at ? 1 : -1); });

/* ================== UI plumbing ================== */
let route = "dashboard";
let renderPending = false, renderTimer = null;
function scheduleRender(now) { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = null; render(); }, now ? 0 : 40); }
document.addEventListener("focusout", () => { if (renderPending) { renderPending = false; setTimeout(render, 0); } });
let toastTimer;
function toast(msg) {
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3600);
}
const pill = ([label, cls]) => `<span class="pill ${cls || ""}">${esc(label)}</span>`;
const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  stock: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/>',
  production: '<path d="M4 20h16"/><path d="M6 16h12l-1-6H7z"/><path d="M12 4v6M9 7l3-3 3 3"/>',
  orders: '<path d="M6 2h12l2 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z"/><path d="M8 10h8M8 14h5"/>',
  customers: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/><path d="M17 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-6"/>',
  finance: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
  count: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  log: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  admin: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  withdraw: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  pay: '<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  install: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'
};
ICONS.backup = '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>';
const icon = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;
const ROUTES = [
  { id: "dashboard", label: "لوحة التحكم", short: "الرئيسية", ok: () => true },
  { id: "stock", label: "المخزون والحركة", short: "المخزون", ok: () => true },
  { id: "production", label: "الإنتاج اليومي", short: "الإنتاج", ok: () => can("production") },
  { id: "orders", label: "الأوردرات والفواتير", short: "الأوردرات", ok: () => can("orders") || can("payments") },
  { id: "customers", label: "العملاء والحسابات", short: "العملاء", ok: () => can("orders") || can("payments") },
  { id: "finance", label: "المصروفات والإيرادات", short: "المصروفات", ok: () => can("finance") },
  { id: "count", label: "الجرد الفعلي", short: "الجرد", ok: () => can("count") },
  { id: "reports", label: "التقارير", short: "التقارير", ok: () => can("reports") },
  { id: "log", label: "سجل العمليات", short: "السجل", ok: () => can("log") },
  { id: "admin", label: "الإعدادات", short: "الإعدادات", ok: () => true }
];
const routeOf = id => ROUTES.find(r => r.id === id);
function go(r) { const replace = modalOpen && modalHistory; route = r; closeModal(true); try { if (replace) history.replaceState(null, "", "#" + r); else if (location.hash !== "#" + r) history.pushState(null, "", "#" + r); } catch {} render(); window.scrollTo(0, 0); }
let pendingAction = null;
function readHash() {
  const h = location.hash.slice(1);
  if (h.startsWith("act-")) { pendingAction = h.slice(4); try { history.replaceState(null, "", "#dashboard"); } catch {} route = "dashboard"; return; }
  if (routeOf(h)) route = h;
}
readHash();

/* ================== Dialogs (bottom sheets on phones) ================== */
let modalOpen = false, modalHistory = false;
window.addEventListener("popstate", () => {
  if (modalOpen) { modalHistory = false; closeModal(true); return; }
  const h = location.hash.slice(1); if (routeOf(h) && h !== route) { route = h; render(); }
  else if (!h && route !== "dashboard") { route = "dashboard"; render(); }
});
function openModal(title, body, opts = {}) {
  pendingBy = null;
  const root = $("#modal-root");
  root.innerHTML = `<div class="overlay" data-close-bg><div class="modal ${opts.wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <form id="mform" novalidate><header><h2 id="m-title">${esc(title)}</h2><button type="button" class="btn ghost sm" data-close aria-label="إغلاق">✕</button></header>
    <div class="body">${body}<div class="err" id="m-err" hidden></div></div>
    ${opts.noFooter ? "" : `<footer>${opts.onSubmit ? `<button class="btn ${opts.danger ? "danger" : "primary"}" type="submit" id="m-submit">${esc(opts.submitLabel || "حفظ")}</button>` : ""}${opts.extra || ""}<button class="btn" type="button" data-close>${opts.onSubmit ? "إلغاء" : "إغلاق"}</button></footer>`}</form></div></div>`;
  if (!modalOpen) { modalOpen = true; try { history.pushState({ modal: 1 }, "", location.hash || "#" + route); modalHistory = true; } catch {} }
  document.body.style.overflow = "hidden";
  const form = $("#mform");
  root.querySelectorAll("[data-close]").forEach(b => b.onclick = () => closeModal());
  root.querySelector("[data-close-bg]").addEventListener("mousedown", e => { if (e.target.hasAttribute("data-close-bg")) closeModal(); });
  form.addEventListener("submit", async e => {
    e.preventDefault(); if (!opts.onSubmit) return;
    const err = $("#m-err"); err.hidden = true;
    const btn = $("#m-submit"); btn.disabled = true;
    try {
      const res = await opts.onSubmit(new FormData(form), form);
      if (typeof res === "string") { err.textContent = res; err.hidden = false; btn.disabled = false; return; }
      if (typeof res === "function") { res(); return; }
      closeModal(); if (opts.done) toast(opts.done);
    } catch (ex) { console.error(ex); btn.disabled = false; err.textContent = ex && ex.userMessage ? ex.userMessage : "تعذر الحفظ. حاول مرة أخرى."; err.hidden = false; }
  });
  document.addEventListener("keydown", escClose);
  if (!opts.noFocus && window.matchMedia("(min-width:760px)").matches) { const first = form.querySelector("input:not([type=hidden]):not([readonly]),select,textarea"); if (first) first.focus(); }
  return form;
}
function escClose(e) { if (e.key === "Escape") closeModal(); }
function closeModal(fromNav) {
  if (!modalOpen) return;
  $("#modal-root").innerHTML = ""; document.body.style.overflow = ""; document.removeEventListener("keydown", escClose);
  modalOpen = false;
  if (modalHistory && !fromNav) { modalHistory = false; try { history.back(); } catch {} }
  modalHistory = false;
  if (renderPending) { renderPending = false; scheduleRender(); }
}
const fv = (fd, k) => (fd.get(k) ?? "").toString().trim();
const fnum = (fd, k) => pnum(fv(fd, k));
const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(v) === String(sel) ? "selected" : ""}>${esc(label)}</option>`;
const itemOptions = sel => items().map(i => opt(i.id, `${i.name} (${i.unit})`, sel)).join("");
const field = (label, input, cls = "", hint = "") => `<label class="f ${cls}"><span>${esc(label)}</span>${input}${hint ? `<small>${hint}</small>` : ""}</label>`;
const numInput = (name, val, extra = "") => `<input type="text" inputmode="decimal" name="${name}" id="f-${name}" value="${val ?? ""}" autocomplete="off" ${extra}>`;
const dateInput = (name, val) => `<input type="date" name="${name}" id="f-${name}" value="${esc(val || today())}" required>`;
function wirePlates(scope) {
  const it = scope.querySelector("[name=itemId]"), pl = scope.querySelector("[name=plates]"), q = scope.querySelector("[name=qty]"), lab = scope.querySelector("[data-unit]");
  if (!it || !pl || !q) return;
  const auto = () => { const i = item(it.value), p = pnum(pl.value); return i && isFinite(p) ? r2(p * (+i.perPlate || 0)) : NaN; };
  let manual = q.value !== "" && Math.abs(pnum(q.value) - auto()) > 0.01;
  const sync = () => { const i = item(it.value); if (lab) lab.textContent = i ? i.unit : ""; if (!manual && i) { const a = auto(); q.value = isFinite(a) ? a : ""; } };
  it.addEventListener("change", sync); pl.addEventListener("input", sync); q.addEventListener("input", () => manual = q.value !== "");
  sync();
}
function confirmBox(title, text, label, fn) { openModal(title, `<p>${text}</p>`, { onSubmit: fn, submitLabel: label, danger: true, noFocus: true }); }
/* Lists turn into cards on phones: copy each column title onto its cells */
function labelTables(root) {
  $$("table.rtable", root).forEach(t => {
    const heads = $$("thead th", t).map(th => th.textContent.trim());
    $$("tbody tr, tfoot tr", t).forEach(tr => {
      let col = 0;
      Array.from(tr.cells).forEach((td, i) => {
        const span = td.colSpan || 1;
        if (span > 1 || tr.cells.length === 1) td.classList.add("span");
        else if (td.querySelector("button, a.btn")) td.classList.add("act");
        else if (!td.textContent.trim() && !td.querySelector("input,select")) td.classList.add("blank");
        else if (i === 0 && !t.classList.contains("no-title")) td.classList.add("title");
        else if (heads[col]) td.dataset.label = heads[col];
        col += span;
      });
    });
  });
}

/* ================== Rendering ================== */
function render() {
  const app = $("#app");
  const ae = document.activeElement;
  if (ae && app.contains(ae) && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) { renderPending = true; return; }
  if (phase === "readfail") {
    app.innerHTML = `<div class="screen"><div class="card"><div class="logo">Pets Home</div><p>تعذر قراءة بيانات المزرعة من الموبايل. بياناتك لم تُمسح.</p>
      <p class="small muted">اقفل التطبيق تماماً وافتحه تاني. لو المشكلة استمرت، تأكد إن في مساحة فاضية على الموبايل.</p>
      <button type="button" class="btn primary block" onclick="location.reload()">إعادة المحاولة</button></div></div>`;
    return;
  }
  if (phase !== "ready") return screenMsg(app, "جاري فتح Pets Home…");
  if (!S.meta.get("settings")) return renderWelcome(app);
  if (!routeOf(route)?.ok()) route = "dashboard";
  const s = settings(); const r = routeOf(route);
  const tabs = tabsShown();
  app.innerHTML = `<div class="shell">
    <aside class="rail">
      <div class="brand"><span class="name">${esc(s.farmName || "Pets Home")}</span><span class="sub">إدارة المزرعة والمخزون</span></div>
      <nav class="nav" aria-label="الأقسام">${ROUTES.filter(x => x.ok()).map(x => `<a href="#${x.id}" data-go="${x.id}" ${x.id === route ? 'aria-current="page"' : ""}>${icon(x.id)}${x.label}</a>`).join("")}</nav>
      <div class="who"><div><b>${esc(ownerName())}</b> <span class="muted small">البيانات على هذا الجهاز</span></div>
      <div class="actions"><button class="btn sm" data-act="backup">نسخة احتياطية</button>${installPrompt ? `<button class="btn sm" data-act="install">تثبيت التطبيق</button>` : ""}</div></div>
    </aside>
    <div class="col">
      <header class="appbar"><div class="in"><div class="ttl"><span class="farm">${esc(s.farmName || "Pets Home")}</span><span class="page">${esc(r.label)}</span></div>
      <button class="avatar" data-act="more" aria-label="القائمة">${esc(ownerName().trim().charAt(0) || "P")}</button></div></header>
      <main id="main">${s.demo ? `<div class="banner info">أنت تجرّب ببيانات تجريبية. لما تخلص، امسحها من «الإعدادات ← مسح كل البيانات» وابدأ ببياناتك.</div>` : ""}${VIEWS[route]()}</main>
    </div>
    <nav class="tabbar" aria-label="التنقل">
      ${tabs.slice(0, 2).map(tabBtn).join("")}
      <button type="button" class="add" data-act="quick" aria-label="تسجيل جديد"><i>${icon("plus")}</i><span>إضافة</span></button>
      ${tabs[2] ? tabBtn(tabs[2]) : "<span></span>"}
      <button type="button" data-act="more" ${tabs.every(t => t.id !== route) ? 'aria-current="page"' : ""}>${icon("more")}<span>المزيد</span></button>
    </nav></div>`;
  labelTables(app);
  afterRender[route]?.();
  if (pendingAction) { const a = pendingAction; pendingAction = null; const qa = quickActions().find(x => x.id === a); if (qa) setTimeout(qa.run, 50); }
}
function tabsShown() { return ["dashboard", "stock", "orders"].map(routeOf); }
const tabBtn = r => `<button type="button" data-go="${r.id}" ${r.id === route ? 'aria-current="page"' : ""}>${icon(r.id)}<span>${esc(r.short)}</span></button>`;
function quickActions() {
  return [
    { id: "order", label: "أوردر جديد", ic: "orders", run: () => orderForm() },
    { id: "production", label: "تسجيل إنتاج", ic: "production", run: () => moveForm("production") },
    { id: "withdraw", label: "سحب من المخزون", ic: "withdraw", run: () => moveForm("withdraw") },
    { id: "expense", label: "مصروف", ic: "finance", run: () => financeForm("expense") },
    { id: "payment", label: "تحصيل من عميل", ic: "pay", run: () => paymentForm() },
    { id: "count", label: "جرد فعلي", ic: "count", run: () => go("count") }
  ];
}
function showQuick() {
  openModal("تسجيل جديد", `<div class="sheet-grid">${quickActions().map(a => `<button type="button" data-quick="${a.id}">${icon(a.ic)}${esc(a.label)}</button>`).join("")}</div>`, { noFooter: true, noFocus: true });
  $$("[data-quick]").forEach(b => b.onclick = () => { const a = quickActions().find(x => x.id === b.dataset.quick); if (a) a.run(); });
}
function showMore() {
  const tabs = tabsShown().map(r => r.id);
  const rest = ROUTES.filter(r => !tabs.includes(r.id));
  openModal("المزيد", `<div class="sheet-grid">${rest.map(r => `<button type="button" data-go="${r.id}">${icon(r.id)}${esc(r.label)}</button>`).join("")}
    <button type="button" data-act="backup">${icon("backup")}نسخة احتياطية</button>
    ${installPrompt ? `<button type="button" data-act="install">${icon("install")}تثبيت التطبيق</button>` : ""}</div>`, { noFooter: true, noFocus: true });
}
function screenMsg(app, msg) { app.innerHTML = `<div class="screen"><div class="loading">${esc(msg)}</div></div>`; }

/* ---------- First run ---------- */
function renderWelcome(app) {
  app.innerHTML = `<div class="screen"><form class="card" id="welcome" novalidate>
    <div><div class="logo">Pets Home</div><p class="muted">نسخة تجريبية تعمل على هذا الموبايل فقط، بدون إنترنت وبدون حسابات. كل البيانات تُحفظ على الجهاز.</p></div>
    <div class="form">
      ${field("اسم المزرعة", `<input type="text" name="farm" id="w-farm" value="Pets Home">`, "full")}
      ${field("اسمك", `<input type="text" name="name" id="w-name" autocomplete="name">`, "full", "يظهر في سجل العمليات")}
      ${field("العملة", `<input type="text" name="cur" id="w-cur" value="ج.م">`, "full")}
    </div>
    <div class="err" id="w-err" hidden></div>
    <button class="btn primary block" type="submit">ابدأ</button>
    <button class="btn block" type="button" id="w-demo">جرّب ببيانات تجريبية أولاً</button>
    <label class="linkbtn" style="text-align:center">عندي نسخة احتياطية، استرجعها<input type="file" id="w-restore" accept=".json,application/json" hidden></label>
    ${Local.snapInfo && Local.snapInfo.count ? `<button class="btn block" type="button" id="w-snap">استرجاع البيانات السابقة من النسخة التلقائية (${nf(Local.snapInfo.count, 0)} سجل)</button>` : ""}
  </form></div>`;
  const ws = $("#w-snap"); if (ws) ws.onclick = restoreSnapshot;
  $("#welcome").addEventListener("submit", e => {
    e.preventDefault(); const fd = new FormData(e.target); const name = fv(fd, "name");
    if (!name) { const er = $("#w-err"); er.textContent = "اكتب اسمك."; er.hidden = false; return; }
    document.activeElement && document.activeElement.blur();
    Store.put("meta", "settings", { farmName: fv(fd, "farm") || "Pets Home", ownerName: name, currency: fv(fd, "cur") || "ج.م", createdAt: nowISO() });
    audit("إضافة", "settings", "settings", `بدء استخدام التطبيق — ${name}`);
    Local.flush();
  });
  $("#w-demo").onclick = seedDemo;
  $("#w-restore").onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => importBackup(rd.result, true); rd.readAsText(f); e.target.value = ""; };
}
/* Sample farm data so the app can be explored before entering real records. */
function seedDemo() {
  const t = today(), d = n => addDays(t, -n), at = (date, h) => new Date(`${date}T${pad(h)}:${pad(10 + (Object.keys(S).length % 40))}:00`).toISOString();
  Store.put("meta", "settings", { farmName: "Pets Home", ownerName: "المدير", currency: "ج.م", createdAt: nowISO(), demo: true });
  const W = [Store.newId(), Store.newId()];
  Store.put("workers", W[0], { name: "محمود", phone: "", active: true }); Store.put("workers", W[1], { name: "سعيد", phone: "", active: true });
  const I = [Store.newId(), Store.newId(), Store.newId()];
  Store.put("items", I[0], { name: "ميل وورم", unit: "كجم", perPlate: 2, price: 150, priceBasis: "plate", minPlates: 10, active: true });
  Store.put("items", I[1], { name: "سوبر وورم", unit: "كجم", perPlate: 1.5, price: 220, priceBasis: "plate", minPlates: 6, active: true });
  Store.put("items", I[2], { name: "صراصير دوبيا", unit: "عدد", perPlate: 200, price: 1.5, priceBasis: "unit", minPlates: 3, active: true });
  const C = [Store.newId(), Store.newId()];
  Store.put("customers", C[0], { name: "محل النيل للحيوانات", phone: "01001234567", note: "" });
  Store.put("customers", C[1], { name: "مزرعة الأمل", phone: "01112223334", note: "" });
  const mv = (type, i, plates, day, by, extra = {}) => { const it = S.items.get(I[i]); Store.put("moves", Store.newId(), Object.assign({ type, itemId: I[i], plates, qty: r2(plates * it.perPlate), date: d(day), note: "", by, at: at(d(day), 8 + i) }, extra)); };
  mv("opening", 0, 40, 6, OWNER_ID); mv("opening", 1, 15, 6, OWNER_ID); mv("opening", 2, 8, 6, OWNER_ID);
  [5, 4, 3, 2, 1, 0].forEach((n, k) => { mv("production", 0, 6 + (k % 3), n, W[k % 2]); if (k % 2 === 0) mv("production", 1, 3, n, W[1]); });
  mv("production", 2, 2, 3, W[0]);
  mv("withdraw", 1, 1, 2, W[1], { reason: "تالف" });
  const line = (i, plates, price) => { const it = S.items.get(I[i]); const qty = r2(plates * it.perPlate); return { itemId: I[i], plates, qty, price, basis: it.priceBasis, total: r2((it.priceBasis === "unit" ? qty : plates) * price) }; };
  const order = (c, day, lines, paidNow, status, by) => { const total = r2(lines.reduce((a, l) => a + l.total, 0)); const id = Store.newId(); Store.put("orders", id, { customerId: c, date: d(day), status, lines, subtotal: total, discount: 0, total, paidNow, note: "", by, no: newOrderNo(d(day)), at: at(d(day), 13) }); return id; };
  order(C[0], 3, [line(0, 6, 150), line(1, 4, 220)], 1780, "delivered", OWNER_ID);
  const o2 = order(C[1], 1, [line(2, 2, 1.5)], 300, "delivered", W[0]);
  order(C[0], 0, [line(0, 5, 150)], 0, "prepared", OWNER_ID);
  Store.put("payments", Store.newId(), { customerId: C[1], orderId: o2, amount: 100, date: t, method: "نقدي", note: "", by: OWNER_ID, at: at(t, 11) });
  const fin = (kind, category, amount, day, payType, note) => Store.put("finance", Store.newId(), { kind, category, amount, date: d(day), payType, note, by: OWNER_ID, at: at(d(day), 16) });
  fin("expense", "خامات", 600, 4, "cash", "ردة"); fin("expense", "أجور", 1200, 2, "cash", "أجور الأسبوع"); fin("expense", "نقل", 150, 0, "cash", "توصيل أوردر"); fin("expense", "أكل", 400, 1, "credit", "خضار للتغذية");
  audit("إضافة", "demo", "", "تحميل بيانات تجريبية");
  Local.flush(); toast("تم تحميل بيانات تجريبية");
}

/* ---------- Views ---------- */
const VIEWS = {}; const afterRender = {};
function headHtml(title, sub, actions = "") { return `<div class="head"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`; }
const qtyStr = (q, id) => `${nf(q)} ${esc(unitOf(id))}`;
function emptyRow(cols, text) { return `<tr><td colspan="${cols}" class="empty">${text}</td></tr>`; }
function rowActions(kind, id) { if (!isMgr()) return ""; return `<button class="btn sm" data-act="edit-${kind}" data-id="${id}">تعديل</button> <button class="btn sm danger" data-act="del-${kind}" data-id="${id}">حذف</button>`; }

VIEWS.dashboard = () => {
  const t = today(); const ss = stockSummary("", "");
  let plates = 0; const byUnit = {};
  items().forEach(i => { const b = ss.get(i.id); plates += b.closing; byUnit[i.unit] = (byUnit[i.unit] || 0) + b.closingQ; });
  const prodToday = [...S.moves.values()].filter(m => m.type === "production" && m.date === t);
  const prodPlates = prodToday.reduce((a, m) => a + (+m.plates || 0), 0);
  const ordToday = [...S.orders.values()].filter(o => o.date === t && o.status !== "cancelled");
  const ms = moneySummary(t, t);
  const low = items().filter(i => (+i.minPlates || 0) > 0 && ss.get(i.id).closing <= +i.minPlates);
  const recent = allAudit().slice(0, 8);
  const quick = quickActions().slice(0, 4).map((a, i) => `<button class="btn ${i < 2 ? "primary" : ""}" data-qa="${a.id}">${esc(a.label)}</button>`).join("");
  return `${headHtml("لوحة التحكم", `${dayName(t)} ${fmtDate(t)}`, `<span class="rail-only">${quick}</span>`)}
  <section class="kpis" aria-label="ملخص اليوم">
    <div class="kpi plate"><span>الأطباق في الغرفة الآن</span><b class="num">${nf(plates)}</b><small>${Object.entries(byUnit).map(([u, q]) => `${nf(q)} ${esc(u)}`).join(" · ") || "لا يوجد مخزون مسجل"}</small></div>
    <div class="kpi"><span>إنتاج اليوم</span><b class="num">${nf(prodPlates)} طبق</b><small>${prodToday.length} تسجيل</small></div>
    <div class="kpi"><span>أوردرات اليوم</span><b class="num">${ordToday.length}</b><small>${nf(ordToday.reduce((a, o) => a + (o.lines || []).reduce((x, l) => x + (+l.plates || 0), 0), 0))} طبق خارج</small></div>
    <div class="kpi"><span>مبيعات اليوم</span><b class="num">${money(ms.sales)}</b><small>محصّل ${money(ms.collectedAtOrder)}</small></div>
    <div class="kpi"><span>مصروفات اليوم</span><b class="num">${money(ms.expense)}</b><small>${ms.expenseCredit ? "منها آجل " + money(ms.expenseCredit) : "نقدي"}</small></div>
    <div class="kpi"><span>إيرادات أخرى اليوم</span><b class="num">${money(ms.income)}</b><small>تحصيلات عملاء ${money(ms.payments)}</small></div>
    <div class="kpi hero"><span>صافي حركة اليوم</span><b class="num">${money(ms.net)}</b><small>مبيعات + إيرادات − مصروفات</small></div>
    <div class="kpi ${totalReceivable() > 0 ? "bad" : ""}"><span>مستحق على العملاء</span><b class="num">${money(totalReceivable())}</b><small>الآجل والمتبقي</small></div>
  </section>
  ${backupNag()}${low.length ? `<div class="banner">رصيد منخفض: ${low.map(i => `${esc(i.name)} (${nf(ss.get(i.id).closing)} طبق)`).join("، ")}</div>` : ""}
  ${monthPanel()}
  <div class="grid2">
    <section class="panel"><div class="panel-head"><h2>رصيد الغرفة لكل صنف</h2><a href="#stock" data-go="stock" class="small">تفاصيل الحركة</a></div>
      <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">الأطباق</th><th class="n">الكمية</th><th>الحالة</th></tr></thead><tbody>
      ${items().length ? items().map(i => { const b = ss.get(i.id); const lowI = (+i.minPlates || 0) > 0 && b.closing <= +i.minPlates; return `<tr><td>${esc(i.name)}</td><td class="n">${nf(b.closing)}</td><td class="n">${qtyStr(b.closingQ, i.id)}</td><td>${b.closing < 0 ? pill(["رصيد بالسالب", "bad"]) : lowI ? pill(["منخفض", "warn"]) : pill(["متاح", "good"])}</td></tr>`; }).join("") : emptyRow(4, isMgr() ? `لا توجد أصناف بعد. <a href="#admin" data-go="admin">أضف أول صنف</a> ثم سجّل رصيده الافتتاحي.` : "لم يضف المدير أصنافاً بعد.")}
      </tbody></table></div></section>
    <section class="panel"><div class="panel-head"><h2>آخر العمليات</h2>${can("log") ? `<a href="#log" data-go="log" class="small">السجل الكامل</a>` : ""}</div>
      ${recent.length ? `<div class="tbl-wrap"><table class="rtable no-title"><thead><tr><th>الوقت</th><th>العملية</th><th>بواسطة</th></tr></thead><tbody>${recent.map(e => `<tr><td class="nowrap small muted">${fmtDT(e.at)}</td><td class="span">${esc(e.summary)}</td><td class="small muted">${esc(wName(e.by))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ستظهر هنا كل عملية إنتاج أو بيع أو سحب أو صرف فور تسجيلها.</div>`}
    </section>
  </div>`;
};
function backupNag() {
  const s = settings(); if (s.demo || recordCount() < 3) return "";
  const last = s.lastBackup ? new Date(s.lastBackup) : null; const days = last ? Math.floor((Date.now() - last) / 864e5) : null;
  if (last && days < 7) return "";
  return `<div class="banner">${last ? `آخر نسخة احتياطية من ${days} يوم.` : "لم تعمل نسخة احتياطية بعد."} البيانات محفوظة على هذا الموبايل فقط. <button type="button" class="linkbtn" data-act="backup">اعمل نسخة الآن</button></div>`;
}
afterRender.dashboard = () => { $$("[data-qa]").forEach(b => b.onclick = () => quickActions().find(a => a.id === b.dataset.qa)?.run()); };

let stockItemFilter = "", stockRange = 30;
VIEWS.stock = () => {
  const ss = stockSummary("", "");
  const acts = [isMgr() && `<button class="btn" data-act="new-opening">رصيد افتتاحي</button>`, can("withdraw") && `<button class="btn primary" data-act="new-withdraw">سحب من المخزون</button>`].filter(Boolean).join("");
  const from = stockRange ? addDays(today(), -stockRange + 1) : "";
  const rows = ledger().filter(e => (!stockItemFilter || e.itemId === stockItemFilter) && (!from || e.date >= from)).slice().reverse().slice(0, 300);
  return `${headHtml("المخزون والحركة", "الرصيد = أول المدة + الإنتاج − المبيعات − المسحوبات ± تسويات الجرد", acts)}
  <section class="panel"><div class="panel-head"><h2>رصيد كل صنف</h2><span class="hint">بالأطباق</span></div>
    <div class="stack">${items().length ? items().map(i => { const b = ss.get(i.id); return `<div class="logline"><b>${esc(i.name)} <span class="muted small">— الطبق = ${nf(i.perPlate)} ${esc(i.unit)}</span></b>
      <div class="equation"><span class="t">افتتاحي ${nf(b.opening)}</span><span class="op">+</span><span class="t">إنتاج ${nf(b.production)}</span><span class="op">−</span><span class="t">مبيعات ${nf(b.sale)}</span><span class="op">−</span><span class="t">مسحوبات ${nf(b.withdraw)}</span><span class="op">${b.adjust < 0 ? "−" : "+"}</span><span class="t">تسويات ${nf(Math.abs(b.adjust))}</span><span class="op">=</span><span class="res">${nf(b.closing)} طبق · ${qtyStr(b.closingQ, i.id)}</span></div></div>`; }).join("") : `<div class="empty">لا توجد أصناف بعد.</div>`}</div>
  </section>
  <section class="panel"><div class="panel-head"><h2>حركة المخزون</h2></div>
    <div class="filters"><label>الصنف<select id="st-item"><option value="">كل الأصناف</option>${itemOptions(stockItemFilter)}</select></label>
    <label>الفترة<select id="st-range">${opt(7, "آخر 7 أيام", stockRange)}${opt(30, "آخر 30 يوم", stockRange)}${opt(90, "آخر 90 يوم", stockRange)}${opt(0, "كل الحركة", stockRange)}</select></label></div>
    <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th>النوع</th><th>التاريخ</th><th class="n">أطباق</th><th class="n">الكمية</th><th>البيان</th><th>بواسطة</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(e => `<tr><td>${esc(itemName(e.itemId))}</td><td>${pill([KIND[e.kind], e.plates >= 0 ? "good" : "bad"])}</td><td class="nowrap">${fmtDate(e.date)} <span class="muted small">${fmtTime(e.at)}</span></td><td class="n ${e.plates < 0 ? "neg" : "pos"}">${e.plates > 0 ? "+" : ""}${nf(e.plates)}</td><td class="n">${qtyStr(e.qty, e.itemId)}</td><td class="small">${esc(e.note) || "—"}</td><td class="small muted">${esc(wName(e.by))}</td><td class="nowrap">${e.src === "move" ? rowActions("move", e.id) : `<button class="btn sm" data-act="invoice" data-id="${e.id}">الفاتورة</button>`}</td></tr>`).join("") : emptyRow(8, "لا توجد حركة في هذه الفترة.")}
    </tbody></table></div></section>`;
};
afterRender.stock = () => {
  $("#st-item").onchange = e => { stockItemFilter = e.target.value; e.target.blur(); render(); };
  $("#st-range").onchange = e => { stockRange = +e.target.value; e.target.blur(); render(); };
};

let prodDays = 14;
VIEWS.production = () => {
  const from = addDays(today(), -prodDays + 1);
  const list = [...S.moves.values()].filter(m => m.type === "production" && m.date >= from).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (a.at < b.at ? 1 : -1));
  const byDay = {}; list.forEach(m => (byDay[m.date] = byDay[m.date] || []).push(m));
  return `${headHtml("الإنتاج اليومي", "كل طبق يُسجل هنا يُضاف فوراً لرصيد الغرفة", `<button class="btn primary" data-act="new-production">+ تسجيل إنتاج</button>`)}
  <section class="panel"><div class="panel-head"><h2>سجل الإنتاج</h2><div class="filters"><label>الفترة<select id="pr-days">${opt(7, "آخر 7 أيام", prodDays)}${opt(14, "آخر 14 يوم", prodDays)}${opt(31, "آخر 31 يوم", prodDays)}${opt(90, "آخر 90 يوم", prodDays)}</select></label></div></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th>الوقت</th><th class="n">أطباق</th><th class="n">الكمية</th><th>ملاحظة</th><th>بواسطة</th><th></th></tr></thead><tbody>
  ${Object.keys(byDay).length ? Object.entries(byDay).map(([d, ms]) => {
    const tot = ms.reduce((a, m) => a + (+m.plates || 0), 0);
    return `<tr class="group"><td colspan="7"><b>${dayName(d)} ${fmtDate(d)}</b> <span class="muted small">— إجمالي ${nf(tot)} طبق</span></td></tr>` + ms.map(m => `<tr><td>${esc(itemName(m.itemId))}</td><td class="muted small">${fmtTime(m.at)}</td><td class="n">${nf(m.plates)}</td><td class="n">${qtyStr(m.qty, m.itemId)}</td><td class="small">${esc(m.note || "") || "—"}</td><td class="small muted">${esc(wName(m.by))}</td><td class="nowrap">${rowActions("move", m.id)}</td></tr>`).join("");
  }).join("") : emptyRow(7, "لم يُسجل إنتاج في هذه الفترة. اضغط «تسجيل إنتاج» لإضافة أطباق اليوم.")}
  </tbody></table></div></section>`;
};
afterRender.production = () => { $("#pr-days").onchange = e => { prodDays = +e.target.value; e.target.blur(); render(); }; };

function moveForm(type, existing) {
  if (!items().length) { toast(isMgr() ? "أضف صنفاً أولاً من «الإعدادات»." : "لا توجد أصناف بعد. اطلب من المدير إضافتها."); return; }
  const m = existing || {};
  const titles = { production: "تسجيل إنتاج", opening: "رصيد افتتاحي", withdraw: "سحب من المخزون", adjust: "تسوية جرد" };
  const body = `<div class="form">
    ${field("الصنف", `<select name="itemId" id="f-itemId" required>${itemOptions(m.itemId)}</select>`, "full")}
    ${field(type === "adjust" ? "عدد الأطباق (موجب زيادة / سالب عجز)" : "عدد الأطباق", numInput("plates", m.plates, "required"))}
    ${field("الكمية", numInput("qty", m.qty), "", `بالـ<span data-unit></span> — تُحسب تلقائياً ويمكن تعديلها`)}
    ${field("التاريخ", dateInput("date", m.date))}
    ${byField(m.by)}
    ${type === "withdraw" ? field("سبب السحب", `<select name="reason" id="f-reason">${WD_REASONS.map(r => opt(r, r, m.reason)).join("")}</select>`) : ""}
    ${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(m.note || "")}">`, "full")}
    ${type === "withdraw" && !existing ? `<div class="f full small muted" id="wd-bal"></div>` : ""}</div>`;
  const form = openModal((existing ? "تعديل: " : "") + titles[type], body, {
    submitLabel: existing ? "حفظ التعديل" : "تسجيل", done: existing ? "تم حفظ التعديل" : "تم التسجيل وتحديث المخزون",
    onSubmit: async fd => {
      const plates = fnum(fd, "plates"); let qty = fnum(fd, "qty");
      if (!fv(fd, "itemId")) return "اختر الصنف.";
      if (!isFinite(plates) || (type !== "adjust" && plates <= 0)) return "اكتب عدد أطباق أكبر من صفر.";
      if (!isFinite(qty)) qty = r2(plates * (+item(fv(fd, "itemId")).perPlate || 0));
      const data = { type, itemId: fv(fd, "itemId"), plates: r2(plates), qty: r2(qty), date: fv(fd, "date") || today(), note: fv(fd, "note"), by: byVal(fd) };
      if (type === "withdraw") data.reason = fv(fd, "reason");
      const word = { production: "إنتاج", opening: "رصيد افتتاحي", withdraw: "سحب", adjust: "تسوية" }[type];
      const sum = `${word}: ${nf(data.plates)} طبق ${itemName(data.itemId)} (${nf(data.qty)} ${unitOf(data.itemId)})${data.reason ? " — " + data.reason : ""}`;
      if (existing) {
        const next = Object.assign({}, existing, data, { editedAt: nowISO(), editedBy: me().id });
        await Store.put("moves", existing.id, next); audit("تعديل", "move", existing.id, "تعديل " + sum, existing, next);
      } else {
        const id = Store.newId();
        await Store.put("moves", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "move", id, sum);
      }
    }
  });
  wirePlates(form);
  const wb = $("#wd-bal"); if (wb) { const upd = () => { const id = form.querySelector("[name=itemId]").value; const b = balance(id); wb.textContent = `الرصيد الحالي: ${nf(b.closing)} طبق (${nf(b.closingQ)} ${unitOf(id)})`; }; form.querySelector("[name=itemId]").addEventListener("change", upd); upd(); }
}

let ordFilter = "open", ordDays = 30, ordSearch = "";
VIEWS.orders = () => {
  const from = ordDays ? addDays(today(), -ordDays + 1) : "";
  let list = [...S.orders.values()].filter(o => !from || o.date >= from);
  if (ordFilter === "open") list = list.filter(o => o.status !== "cancelled" && (o.status !== "delivered" || orderPayState(o) !== "paid"));
  else if (ordFilter === "due") list = list.filter(o => o.status !== "cancelled" && orderPayState(o) !== "paid");
  else if (ordFilter !== "all") list = list.filter(o => o.status === ordFilter);
  if (ordSearch) list = list.filter(o => (o.no || "").includes(ordSearch) || custName(o.customerId).includes(ordSearch));
  list.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (a.at < b.at ? 1 : -1));
  let tot = 0, paid = 0; list.forEach(o => { if (o.status !== "cancelled") { tot += +o.total || 0; paid += orderPaid(o); } });
  const segs = [["open", "مفتوحة"], ["due", "عليها حساب"], ["prepared", "تم التجهيز"], ["delivered", "تم التسليم"], ["cancelled", "ملغاة"], ["all", "الكل"]];
  return `${headHtml("الأوردرات والفواتير", "كل أوردر يخصم أطباقه من الغرفة تلقائياً ويصدر له فاتورة", [can("orders") && `<button class="btn primary" data-act="new-order">+ أوردر جديد</button>`, can("payments") && `<button class="btn" data-act="new-payment">تحصيل</button>`].filter(Boolean).join(""))}
  <section class="panel">
    <div class="seg" role="group" aria-label="حالة الأوردر">${segs.map(([k, l]) => `<button type="button" data-ordf="${k}" aria-pressed="${k === ordFilter}">${l}</button>`).join("")}</div>
    <div class="filters"><label>الفترة<select id="or-days">${opt(7, "آخر 7 أيام", ordDays)}${opt(30, "آخر 30 يوم", ordDays)}${opt(90, "آخر 90 يوم", ordDays)}${opt(0, "كل الأوردرات", ordDays)}</select></label>
    <label>بحث<input type="search" id="or-q" placeholder="رقم أو اسم عميل" value="${esc(ordSearch)}"></label></div>
    <div class="tbl-wrap"><table class="rtable"><thead><tr><th>العميل</th><th>رقم</th><th>التاريخ</th><th class="n">أطباق</th><th class="n">الإجمالي</th><th class="n">المدفوع</th><th class="n">المتبقي</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(o => { const p = orderPaid(o); const st = orderPayState(o); const cancelled = o.status === "cancelled";
      return `<tr ${cancelled ? 'style="opacity:.55"' : ""}><td>${esc(custName(o.customerId))}</td><td class="nowrap"><b>${esc(o.no)}</b></td><td class="nowrap">${fmtDate(o.date)}</td><td class="n">${nf((o.lines || []).reduce((a, l) => a + (+l.plates || 0), 0))}</td><td class="n">${nf(o.total)}</td><td class="n">${nf(p)}</td><td class="n ${o.total - p > 0.005 && !cancelled ? "neg" : ""}">${nf(cancelled ? 0 : r2(o.total - p))}</td><td><span class="pills">${pill(ST_LABEL[o.status] || ["—"])}${cancelled ? "" : pill(PAY_LABEL[st])}</span></td>
      <td class="nowrap"><button class="btn sm" data-act="invoice" data-id="${o.id}">الفاتورة</button>${!cancelled && o.status === "prepared" && can("orders") ? ` <button class="btn sm" data-act="deliver" data-id="${o.id}">تم التسليم</button>` : ""}${!cancelled && st !== "paid" && can("payments") ? ` <button class="btn sm" data-act="pay-order" data-id="${o.id}">تحصيل</button>` : ""}${isMgr() && !cancelled ? ` <button class="btn sm" data-act="edit-order" data-id="${o.id}">تعديل</button> <button class="btn sm danger" data-act="cancel-order" data-id="${o.id}">إلغاء</button>` : ""}</td></tr>`; }).join("") : emptyRow(9, "لا توجد أوردرات بهذا الفلتر.")}
    </tbody>${list.length ? `<tfoot><tr><td colspan="4">الإجمالي (${list.filter(o => o.status !== "cancelled").length} أوردر)</td><td class="n" data-label="الإجمالي">${nf(tot)}</td><td class="n" data-label="المدفوع">${nf(paid)}</td><td class="n" data-label="المتبقي">${nf(r2(tot - paid))}</td><td colspan="2"></td></tr></tfoot>` : ""}</table></div>
  </section>`;
};
function wireSearch(sel, set) {
  let t; const el = $(sel); if (!el) return;
  el.oninput = e => { clearTimeout(t); t = setTimeout(() => { set(e.target.value.trim()); const pos = e.target.selectionStart; e.target.blur(); render(); const q = $(sel); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch {} } }, 400); };
}
afterRender.orders = () => {
  $$("[data-ordf]").forEach(b => b.onclick = () => { ordFilter = b.dataset.ordf; render(); });
  $("#or-days").onchange = e => { ordDays = +e.target.value; e.target.blur(); render(); };
  wireSearch("#or-q", v => ordSearch = v);
};
function newOrderNo(date) { const d = (date || today()).replace(/-/g, "").slice(2); let n = 1; S.orders.forEach(o => { if ((o.no || "").startsWith(d + "-")) n++; }); return `${d}-${pad(n)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`; }
function lineHtml(l = {}, idx) {
  const i = item(l.itemId) || items()[0] || {};
  return `<div class="line" data-line="${idx}">
    <label>الصنف<select name="itemId">${itemOptions(l.itemId || i.id)}</select></label>
    <label>أطباق<input type="text" inputmode="decimal" name="plates" value="${l.plates ?? ""}" autocomplete="off"></label>
    <label>الكمية <span data-unit></span><input type="text" inputmode="decimal" name="qty" value="${l.qty ?? ""}" autocomplete="off"></label>
    <label><span data-pricelab>السعر</span><input type="text" inputmode="decimal" name="price" value="${l.price ?? ""}" autocomplete="off"></label>
    <div class="tot num" data-tot>0</div>
    <button type="button" class="btn sm ghost" data-rmline aria-label="حذف السطر">✕</button>
    <div class="stockwarn" data-warn></div></div>`;
}
function orderForm(existing) {
  if (!items().length) { toast(isMgr() ? "أضف صنفاً أولاً من «الإعدادات»." : "لا توجد أصناف بعد."); return; }
  const o = existing || { lines: [{}], status: "prepared", date: today() };
  const body = `<div class="form">
    ${field("العميل", `<select name="customerId" id="f-customerId">${opt("", "عميل نقدي / بدون اسم", o.customerId)}${customers().map(c => opt(c.id, c.name, o.customerId)).join("")}${opt("__new", "+ عميل جديد…", "")}</select>`)}
    <label class="f" id="newcust" hidden><span>اسم العميل الجديد</span><input type="text" name="newCust" id="f-newCust"></label>
    ${field("التاريخ", dateInput("date", o.date))}
    ${byField(o.by)}
    ${field("حالة التجهيز", `<select name="status" id="f-status">${opt("prepared", "تم التجهيز", o.status)}${opt("delivered", "تم التسليم", o.status)}</select>`)}
    <div class="f full"><span class="small muted" style="font-weight:600">الأصناف</span><div class="lines" id="lines">${(o.lines || [{}]).map((l, i) => lineHtml(l, i)).join("")}</div><button type="button" class="btn sm" id="addline" style="align-self:flex-start">+ صنف آخر</button></div>
    ${field("خصم", numInput("discount", o.discount || ""))}
    ${field("المدفوع الآن", numInput("paidNow", existing ? o.paidNow : ""), "", "اتركه فارغاً لو البيع آجل بالكامل")}
    ${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(o.note || "")}">`, "full")}
    <div class="f full"><div class="sum-box"><div><span>إجمالي الأصناف</span><b class="num" id="s-sub">0</b></div><div class="big"><span>بعد الخصم</span><b class="num" id="s-tot">0</b></div><div><span>المتبقي على العميل</span><b class="num" id="s-rem">0</b></div></div></div></div>`;
  const form = openModal(existing ? `تعديل أوردر ${o.no}` : "أوردر جديد", body, {
    wide: true, submitLabel: existing ? "حفظ التعديل" : "حفظ وإصدار الفاتورة",
    onSubmit: async fd => {
      const lines = [];
      for (const el of $$("[data-line]", form)) {
        const itemId = el.querySelector("[name=itemId]").value, plates = pnum(el.querySelector("[name=plates]").value), price = pnum(el.querySelector("[name=price]").value);
        let qty = pnum(el.querySelector("[name=qty]").value);
        if (!itemId && !isFinite(plates)) continue;
        if (!isFinite(plates) || plates <= 0) return `اكتب عدد الأطباق لصنف ${itemName(itemId)}.`;
        if (!isFinite(price) || price < 0) return `اكتب سعر صنف ${itemName(itemId)}.`;
        const it = item(itemId); if (!isFinite(qty)) qty = plates * (+it.perPlate || 0);
        const basis = it.priceBasis || "plate";
        lines.push({ itemId, plates: r2(plates), qty: r2(qty), price: r2(price), basis, total: r2((basis === "unit" ? qty : plates) * price) });
      }
      if (!lines.length) return "أضف صنفاً واحداً على الأقل.";
      let customerId = fv(fd, "customerId");
      if (customerId === "__new" && !fv(fd, "newCust")) return "اكتب اسم العميل الجديد.";
      const sub = r2(lines.reduce((a, l) => a + l.total, 0)); const discount = r2(fnum(fd, "discount") || 0); const total = r2(sub - discount);
      const paidNow = r2(fnum(fd, "paidNow") || 0);
      if (total < 0) return "الخصم أكبر من إجمالي الأوردر.";
      if (paidNow > total + 0.005) return "المدفوع أكبر من إجمالي الأوردر.";
      if (customerId === "__new") {
        const nm = fv(fd, "newCust");
        customerId = Store.newId(); await Store.put("customers", customerId, { name: nm, phone: "", note: "", at: nowISO(), by: me().id }); audit("إضافة", "customer", customerId, `إضافة عميل ${nm}`);
      }
      const data = { customerId, date: fv(fd, "date") || today(), status: fv(fd, "status"), lines, subtotal: sub, discount, total, paidNow, note: fv(fd, "note"), by: byVal(fd) };
      const desc = lines.map(l => `${nf(l.plates)} طبق ${itemName(l.itemId)}`).join(" + ");
      if (existing) {
        const next = Object.assign({}, existing, data, { editedAt: nowISO(), editedBy: me().id });
        await Store.put("orders", existing.id, next); audit("تعديل", "order", existing.id, `تعديل أوردر ${existing.no} — ${custName(customerId)}`, existing, next);
        toast("تم حفظ التعديل");
      } else {
        const id = Store.newId(); const no = newOrderNo(data.date);
        await Store.put("orders", id, Object.assign(data, { no, at: nowISO() }));
        audit("إضافة", "order", id, `أوردر ${no} — ${custName(customerId)}: ${desc} بإجمالي ${money(total)}${paidNow ? "، مدفوع " + money(paidNow) : "، آجل"}`);
        return () => showInvoice(id);
      }
    }
  });
  const cs = form.querySelector("[name=customerId]"); cs.onchange = () => { $("#newcust").hidden = cs.value !== "__new"; if (cs.value === "__new") $("#f-newCust").focus(); };
  const recalc = () => {
    let sub = 0; const need = {};
    $$("[data-line]", form).forEach(el => {
      const it = item(el.querySelector("[name=itemId]").value); const pl = pnum(el.querySelector("[name=plates]").value) || 0;
      const q = pnum(el.querySelector("[name=qty]").value) || 0; const pr = pnum(el.querySelector("[name=price]").value) || 0;
      const basis = it?.priceBasis || "plate"; const t = r2((basis === "unit" ? q : pl) * pr); sub += t;
      el.querySelector("[data-tot]").textContent = nf(t);
      el.querySelector("[data-pricelab]").textContent = basis === "unit" ? `سعر الـ${it?.unit || "وحدة"}` : "سعر الطبق";
      if (it) need[it.id] = (need[it.id] || 0) + pl;
    });
    $$("[data-line]", form).forEach(el => {
      const id = el.querySelector("[name=itemId]").value; let avail = balance(id).closing;
      if (existing && existing.status !== "cancelled") (existing.lines || []).forEach(l => { if (l.itemId === id) avail += +l.plates || 0; });
      el.querySelector("[data-warn]").textContent = need[id] > avail + 0.0001 ? `الرصيد المسجل ${nf(avail)} طبق فقط. سيصبح المخزون بالسالب، راجع تسجيل الإنتاج.` : "";
    });
    const disc = pnum(form.querySelector("[name=discount]").value) || 0; const paid = pnum(form.querySelector("[name=paidNow]").value) || 0;
    $("#s-sub").textContent = money(sub); $("#s-tot").textContent = money(sub - disc); $("#s-rem").textContent = money(sub - disc - paid);
  };
  const wireLine = el => {
    const sel = el.querySelector("[name=itemId]"), price = el.querySelector("[name=price]");
    const setPrice = () => { const it = item(sel.value); if (it && price.dataset.touched !== "1") price.value = it.price ?? ""; };
    if (!price.value) setPrice(); else price.dataset.touched = "1";
    price.addEventListener("input", () => price.dataset.touched = "1");
    sel.addEventListener("change", () => { price.dataset.touched = ""; setPrice(); recalc(); });
    wirePlates(el);
    el.querySelector("[data-rmline]").onclick = () => { if ($$("[data-line]", form).length > 1) { el.remove(); recalc(); } };
  };
  $$("[data-line]", form).forEach(wireLine);
  $("#addline").onclick = () => { const n = $$("[data-line]", form).length; $("#lines").insertAdjacentHTML("beforeend", lineHtml({}, n)); const el = $("#lines").lastElementChild; wireLine(el); recalc(); el.querySelector("[name=plates]").focus(); };
  form.addEventListener("input", recalc); recalc();
}
function invoiceText(o) {
  const s = settings(); const p = orderPaid(o);
  return [`${s.farmName || "Pets Home"} — فاتورة بيع`, `رقم: ${o.no}`, `التاريخ: ${fmtDate(o.date)}`, `العميل: ${custName(o.customerId)}`, "—".repeat(14),
    ...(o.lines || []).map(l => `${itemName(l.itemId)}: ${nf(l.plates)} طبق (${nf(l.qty)} ${unitOf(l.itemId)}) × ${nf(l.price)} = ${nf(l.total)}`),
    "—".repeat(14), o.discount ? `خصم: ${nf(o.discount)}` : null, `الإجمالي: ${money(o.total)}`, `المدفوع: ${money(p)}`, `المتبقي: ${money(r2(o.total - p))}`].filter(Boolean).join("\n");
}
function invoiceHtml(o) {
  const s = settings(); const p = orderPaid(o);
  return `<div class="invoice"><div class="inv-top"><div><div class="farm">${esc(s.farmName || "Pets Home")}</div><div class="muted small">فاتورة بيع</div></div><div class="small"><div>رقم الفاتورة: <b>${esc(o.no)}</b></div><div>التاريخ: ${fmtDate(o.date)}</div><div>العميل: <b>${esc(custName(o.customerId))}</b></div></div></div>
  <div class="tbl-wrap"><table><thead><tr><th>الصنف</th><th class="n">أطباق</th><th class="n">السعر</th><th class="n">القيمة</th></tr></thead><tbody>
  ${(o.lines || []).map(l => `<tr><td>${esc(itemName(l.itemId))}<div class="small muted">${qtyStr(l.qty, l.itemId)}</div></td><td class="n">${nf(l.plates)}</td><td class="n">${nf(l.price)} <span class="muted small">/${l.basis === "unit" ? esc(unitOf(l.itemId)) : "طبق"}</span></td><td class="n">${nf(l.total)}</td></tr>`).join("")}</tbody></table></div>
  <div class="sum-box">${o.discount ? `<div><span>إجمالي الأصناف</span><b>${money(o.subtotal)}</b></div><div><span>خصم</span><b>${money(o.discount)}</b></div>` : ""}<div class="big"><span>الإجمالي</span><b>${money(o.total)}</b></div><div><span>المدفوع</span><b>${money(p)}</b></div><div><span>المتبقي</span><b>${money(r2(o.total - p))}</b></div></div>
  <div class="small muted">الحالة: ${(ST_LABEL[o.status] || ["—"])[0]}${o.status !== "cancelled" ? " · " + PAY_LABEL[orderPayState(o)][0] : ""} · سجّلها ${esc(wName(o.by))} ${fmtDT(o.at)}</div></div>`;
}
function showInvoice(id) {
  const o = S.orders.get(id); if (!o) return;
  const share = !!navigator.share;
  openModal(`فاتورة ${o.no}`, invoiceHtml(o), { wide: true, noFocus: true, extra: `${share ? `<button type="button" class="btn primary" id="inv-share">مشاركة (واتساب…)</button>` : ""}<button type="button" class="btn ${share ? "" : "primary"}" id="inv-copy">نسخ</button><button type="button" class="btn" id="inv-print">طباعة / PDF</button>` });
  const sh = $("#inv-share"); if (sh) sh.onclick = () => navigator.share({ title: `فاتورة ${o.no}`, text: invoiceText(o) }).catch(() => {});
  $("#inv-copy").onclick = () => copyText(invoiceText(o), "تم نسخ الفاتورة");
  $("#inv-print").onclick = () => { document.body.classList.add("printing"); setTimeout(() => { window.print(); setTimeout(() => document.body.classList.remove("printing"), 500); }, 50); };
}
async function copyText(text, ok) {
  try { await navigator.clipboard.writeText(text); toast(ok); }
  catch { openModal("انسخ النص", `<textarea id="cp" rows="12" readonly>${esc(text)}</textarea><p class="small muted">حدد النص وانسخه يدوياً.</p>`, { noFocus: true }); const t = $("#cp"); t.focus(); t.select(); }
}
function shareOrCopy(title, text, ok) { if (navigator.share) navigator.share({ title, text }).catch(() => {}); else copyText(text, ok); }
function saveFile(name, data, mime) {
  try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast("تم تنزيل الملف"); }
  catch { toast("تعذر تنزيل الملف."); }
}

function paymentForm(preset = {}, existing) {
  const p = existing || preset;
  const all = customers();
  if (!all.length) { toast("لا يوجد عملاء مسجلون بعد."); return; }
  const due = all.filter(c => (custBalances().get(c.id)?.due || 0) > 0 || c.id === p.customerId);
  const ordersOf = cid => [...S.orders.values()].filter(o => o.customerId === cid && o.status !== "cancelled" && (orderPayState(o) !== "paid" || o.id === p.orderId)).sort((a, b) => a.date < b.date ? -1 : 1);
  const body = `<div class="form">
    ${field("العميل", `<select name="customerId" id="f-customerId" required>${(due.length ? due : all).map(c => opt(c.id, `${c.name} — عليه ${nf(custBalances().get(c.id)?.due || 0)}`, p.customerId)).join("")}</select>`, "full")}
    ${field("على أوردر محدد (اختياري)", `<select name="orderId" id="f-orderId"></select>`, "full")}
    ${field("المبلغ", numInput("amount", p.amount, "required"))}
    ${field("التاريخ", dateInput("date", p.date))}
    ${byField(p.by)}
    ${field("طريقة الدفع", `<select name="method" id="f-method">${["نقدي", "تحويل / محفظة", "شيك"].map(x => opt(x, x, p.method)).join("")}</select>`)}
    ${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(p.note || "")}">`)}</div>`;
  const form = openModal(existing ? "تعديل تحصيل" : "تحصيل من عميل", body, {
    submitLabel: existing ? "حفظ التعديل" : "تسجيل التحصيل", done: existing ? "تم حفظ التعديل" : "تم تسجيل التحصيل",
    onSubmit: async fd => {
      const amount = fnum(fd, "amount"); if (!isFinite(amount) || amount <= 0) return "اكتب مبلغاً أكبر من صفر.";
      const data = { customerId: fv(fd, "customerId"), orderId: fv(fd, "orderId"), amount: r2(amount), date: fv(fd, "date") || today(), method: fv(fd, "method"), note: fv(fd, "note"), by: byVal(fd) };
      if (data.orderId) { const o = S.orders.get(data.orderId); const rem = r2(o.total - orderPaid(o) + (existing?.orderId === o.id ? +existing.amount : 0)); if (amount > rem + 0.005) return `المتبقي على هذا الأوردر ${money(rem)} فقط. اختر «دفعة على الحساب» لتسجيل مبلغ أكبر.`; }
      const sum = `تحصيل ${money(data.amount)} من ${custName(data.customerId)}${data.orderId ? " على أوردر " + S.orders.get(data.orderId).no : ""} (${data.method})`;
      if (existing) { const next = Object.assign({}, existing, data, { editedAt: nowISO(), editedBy: me().id }); await Store.put("payments", existing.id, next); audit("تعديل", "payment", existing.id, "تعديل " + sum, existing, next); }
      else { const id = Store.newId(); await Store.put("payments", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "payment", id, sum); }
    }
  });
  const cs = form.querySelector("[name=customerId]"), os = form.querySelector("[name=orderId]");
  const fill = () => { os.innerHTML = opt("", "دفعة على الحساب بدون أوردر", p.orderId) + ordersOf(cs.value).map(o => opt(o.id, `${o.no} — ${fmtDate(o.date)} — متبقي ${nf(r2(o.total - orderPaid(o)))}`, p.orderId)).join(""); };
  cs.onchange = fill; fill();
}

let custSearch = "";
VIEWS.customers = () => {
  const cb = custBalances();
  let list = customers(); if (custSearch) list = list.filter(c => (c.name || "").includes(custSearch) || (c.phone || "").includes(custSearch));
  const cash = cb.get("");
  return `${headHtml("العملاء والحسابات", `المستحق على العملاء: <b class="money">${money(totalReceivable())}</b>`, [can("orders") && `<button class="btn primary" data-act="new-customer">+ عميل جديد</button>`, can("payments") && `<button class="btn" data-act="new-payment">تحصيل</button>`].filter(Boolean).join(""))}
  <section class="panel"><div class="filters"><label>بحث<input type="search" id="cu-q" placeholder="اسم أو تليفون" value="${esc(custSearch)}"></label></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>العميل</th><th>التليفون</th><th class="n">أوردرات</th><th class="n">المشتريات</th><th class="n">المدفوع</th><th class="n">المتبقي عليه</th><th></th></tr></thead><tbody>
  ${list.length ? list.map(c => { const r = cb.get(c.id) || { sales: 0, paid: 0, due: 0, count: 0 }; return `<tr><td><b>${esc(c.name)}</b>${c.note ? ` <span class="small muted">${esc(c.note)}</span>` : ""}</td><td class="nowrap" dir="ltr" style="text-align:start">${esc(c.phone || "—")}</td><td class="n">${r.count}</td><td class="n">${nf(r.sales)}</td><td class="n">${nf(r.paid)}</td><td class="n ${r.due > 0.005 ? "neg" : ""}"><b>${nf(r.due)}</b></td>
  <td class="nowrap"><button class="btn sm" data-act="statement" data-id="${c.id}">كشف حساب</button>${r.due > 0.005 && can("payments") ? ` <button class="btn sm" data-act="pay-cust" data-id="${c.id}">تحصيل</button>` : ""}${c.phone ? ` <a class="btn sm" href="tel:${esc(c.phone)}">اتصال</a>` : ""}${isMgr() || can("orders") ? ` <button class="btn sm" data-act="edit-customer" data-id="${c.id}">تعديل</button>` : ""}</td></tr>`; }).join("") : emptyRow(7, "لا يوجد عملاء بعد. يمكنك إضافة العميل من هنا أو أثناء تسجيل الأوردر.")}
  ${cash && !custSearch ? `<tr><td class="muted">مبيعات نقدية بدون اسم</td><td>—</td><td class="n">${cash.count}</td><td class="n">${nf(cash.sales)}</td><td class="n">${nf(cash.paid)}</td><td class="n">${nf(cash.due)}</td><td></td></tr>` : ""}
  </tbody></table></div></section>`;
};
afterRender.customers = () => wireSearch("#cu-q", v => custSearch = v);
function customerForm(existing) {
  const c = existing || {};
  openModal(existing ? "تعديل بيانات عميل" : "عميل جديد", `<div class="form">${field("الاسم", `<input type="text" name="name" id="f-name" value="${esc(c.name || "")}" required>`, "full")}${field("التليفون", `<input type="tel" name="phone" id="f-phone" dir="ltr" value="${esc(c.phone || "")}">`)}${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(c.note || "")}">`)}</div>`, {
    done: "تم الحفظ",
    onSubmit: async fd => {
      const name = fv(fd, "name"); if (!name) return "اكتب اسم العميل.";
      const data = { name, phone: fv(fd, "phone"), note: fv(fd, "note") };
      if (existing) { const next = Object.assign({}, existing, data); await Store.put("customers", existing.id, next); audit("تعديل", "customer", existing.id, `تعديل بيانات عميل ${name}`, existing, next); }
      else { const id = Store.newId(); await Store.put("customers", id, Object.assign(data, { at: nowISO(), by: me().id })); audit("إضافة", "customer", id, `إضافة عميل ${name}`); }
    }
  });
}
function statementRows(cid, from, to) {
  const rows = [];
  for (const o of S.orders.values()) if ((o.customerId || "") === cid && o.status !== "cancelled") {
    rows.push({ date: o.date, at: o.at, desc: `أوردر ${o.no}: ` + (o.lines || []).map(l => `${nf(l.plates)} طبق ${itemName(l.itemId)}`).join("، "), debit: +o.total || 0, credit: 0 });
    if (+o.paidNow) rows.push({ date: o.date, at: o.at + "1", desc: `مدفوع مع أوردر ${o.no}`, debit: 0, credit: +o.paidNow });
  }
  for (const p of S.payments.values()) if ((p.customerId || "") === cid) rows.push({ pid: p.id, date: p.date, at: p.at, desc: `تحصيل (${p.method || "نقدي"})${p.orderId && S.orders.get(p.orderId) ? " على أوردر " + S.orders.get(p.orderId).no : ""}${p.note ? " — " + p.note : ""}`, debit: 0, credit: +p.amount || 0 });
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || "") < (b.at || "") ? -1 : 1);
  let bal = 0, opening = 0; const out = [];
  rows.forEach(r => { bal = r2(bal + r.debit - r.credit); if (from && r.date < from) opening = bal; else if (!to || r.date <= to) out.push(Object.assign(r, { bal })); });
  return { opening, rows: out, closing: out.length ? out[out.length - 1].bal : opening };
}
function statementHtml(cid, from, to) {
  const st = statementRows(cid, from, to); let d = 0, c = 0; st.rows.forEach(r => { d += r.debit; c += r.credit; });
  const mg = isMgr();
  return `<div class="tbl-wrap"><table class="rtable"><thead><tr><th>البيان</th><th>التاريخ</th><th class="n">عليه</th><th class="n">له</th><th class="n">الرصيد</th>${mg ? "<th></th>" : ""}</tr></thead><tbody>
  ${from ? `<tr><td class="muted">رصيد سابق</td><td>${fmtDate(from)}</td><td></td><td></td><td class="n"><b>${nf(st.opening)}</b></td>${mg ? "<td></td>" : ""}</tr>` : ""}
  ${st.rows.length ? st.rows.map(r => `<tr><td>${esc(r.desc)}</td><td class="nowrap">${fmtDate(r.date)}</td><td class="n">${r.debit ? nf(r.debit) : "—"}</td><td class="n">${r.credit ? nf(r.credit) : "—"}</td><td class="n">${nf(r.bal)}</td>${mg ? `<td class="nowrap">${r.pid ? rowActions("pay", r.pid) : ""}</td>` : ""}</tr>`).join("") : emptyRow(mg ? 6 : 5, "لا توجد حركة في هذه الفترة.")}
  </tbody><tfoot><tr><td colspan="2">الإجمالي</td><td class="n" data-label="عليه">${nf(d)}</td><td class="n" data-label="له">${nf(c)}</td><td class="n ${st.closing > 0.005 ? "neg" : ""}" data-label="الرصيد">${nf(st.closing)}</td>${mg ? "<td></td>" : ""}</tr></tfoot></table></div>
  <p class="small muted">الرصيد الموجب = مبلغ متبقي على العميل.</p>`;
}
function statementText(cid, from, to) {
  const st = statementRows(cid, from, to);
  return [`${settings().farmName} — كشف حساب ${custName(cid)}`, from ? `رصيد سابق: ${nf(st.opening)}` : null, ...st.rows.map(r => `${fmtDate(r.date)} | ${r.desc} | ${r.debit ? "+" + nf(r.debit) : "-" + nf(r.credit)} | الرصيد ${nf(r.bal)}`), `المتبقي: ${money(st.closing)}`].filter(Boolean).join("\n");
}

let finKind = "all", finDays = 31;
VIEWS.finance = () => {
  const from = finDays ? addDays(today(), -finDays + 1) : "";
  const list = [...S.finance.values()].filter(x => (!from || x.date >= from) && (finKind === "all" || x.kind === finKind || (finKind === "credit" && x.payType === "credit"))).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (a.at < b.at ? 1 : -1));
  const ms = moneySummary(from, "");
  const cats = Object.entries(ms.byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...cats.map(c => c[1]));
  return `${headHtml("المصروفات والإيرادات", "كل مصروفات المزرعة مقسمة على بنود، نقدي أو آجل", `<button class="btn primary" data-act="new-expense">+ مصروف</button><button class="btn" data-act="new-income">+ إيراد آخر</button>`)}
  <div class="kpis"><div class="kpi"><span>مصروفات الفترة</span><b class="num">${money(ms.expense)}</b><small>منها آجل ${money(ms.expenseCredit)}</small></div><div class="kpi"><span>إيرادات أخرى</span><b class="num">${money(ms.income)}</b><small>غير المبيعات</small></div><div class="kpi"><span>مبيعات الفترة</span><b class="num">${money(ms.sales)}</b><small>${ms.orders} أوردر</small></div><div class="kpi hero"><span>الصافي</span><b class="num">${money(ms.net)}</b><small>مبيعات + إيرادات − مصروفات</small></div></div>
  <div class="grid-side">
  <section class="panel"><div class="seg" role="group" aria-label="النوع">${[["all", "الكل"], ["expense", "مصروفات"], ["income", "إيرادات"], ["credit", "آجل"]].map(([k, l]) => `<button type="button" data-fink="${k}" aria-pressed="${k === finKind}">${l}</button>`).join("")}</div>
  <div class="filters"><label>الفترة<select id="fi-days">${opt(1, "اليوم", finDays)}${opt(7, "آخر 7 أيام", finDays)}${opt(31, "آخر 31 يوم", finDays)}${opt(90, "آخر 90 يوم", finDays)}${opt(0, "الكل", finDays)}</select></label></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>البند</th><th class="n">المبلغ</th><th>التاريخ</th><th>الدفع</th><th>البيان</th><th>بواسطة</th><th></th></tr></thead><tbody>
  ${list.length ? list.map(x => `<tr><td>${esc(x.category)} ${x.kind === "income" ? pill(["إيراد", "good"]) : ""}</td><td class="n ${x.kind === "income" ? "pos" : "neg"}">${x.kind === "income" ? "+" : "−"}${nf(x.amount)}</td><td class="nowrap">${fmtDate(x.date)}</td><td>${x.payType === "credit" ? pill(["آجل", "warn"]) : "نقدي"}</td><td class="small">${esc(x.note || "") || "—"}</td><td class="small muted">${esc(wName(x.by))}</td><td class="nowrap">${rowActions("fin", x.id)}</td></tr>`).join("") : emptyRow(7, "لا توجد مصروفات أو إيرادات في هذه الفترة.")}
  </tbody></table></div></section>
  <section class="panel"><h2>المصروفات حسب البند</h2>${cats.length ? cats.map(([c, v]) => `<div class="logline"><div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(c)}</span><b class="num">${nf(v)}</b></div><div class="bar"><i style="width:${(v / maxCat * 100).toFixed(1)}%"></i></div></div>`).join("") : `<div class="empty">لا مصروفات في الفترة.</div>`}</section></div>`;
};
afterRender.finance = () => { $$("[data-fink]").forEach(b => b.onclick = () => { finKind = b.dataset.fink; render(); }); $("#fi-days").onchange = e => { finDays = +e.target.value; e.target.blur(); render(); }; };
function financeForm(kind, existing) {
  const x = existing || {}; const cats = kind === "income" ? INC_CATS : EXP_CATS;
  openModal((existing ? "تعديل " : "") + (kind === "income" ? "إيراد آخر" : "مصروف"), `<div class="form">
    ${field("البند", `<select name="category" id="f-category">${cats.map(c => opt(c, c, x.category)).join("")}${x.category && !cats.includes(x.category) ? opt(x.category, x.category, x.category) : ""}</select>`)}
    ${field("المبلغ", numInput("amount", x.amount, "required"))}
    ${field("التاريخ", dateInput("date", x.date))}
    ${byField(x.by)}
    ${field("الدفع", `<select name="payType" id="f-payType">${opt("cash", "نقدي", x.payType)}${opt("credit", "آجل", x.payType)}</select>`)}
    ${field("البيان", `<input type="text" name="note" id="f-note" value="${esc(x.note || "")}" placeholder="مثال: 3 شكاير ردة">`, "full")}</div>`, {
    done: existing ? "تم حفظ التعديل" : "تم التسجيل",
    onSubmit: async fd => {
      const amount = fnum(fd, "amount"); if (!isFinite(amount) || amount <= 0) return "اكتب مبلغاً أكبر من صفر.";
      const data = { kind, category: fv(fd, "category"), amount: r2(amount), date: fv(fd, "date") || today(), payType: fv(fd, "payType"), note: fv(fd, "note"), by: byVal(fd) };
      const sum = `${kind === "income" ? "إيراد" : "مصروف"} ${data.category}: ${money(data.amount)}${data.payType === "credit" ? " (آجل)" : ""}${data.note ? " — " + data.note : ""}`;
      if (existing) { const next = Object.assign({}, existing, data, { editedAt: nowISO(), editedBy: me().id }); await Store.put("finance", existing.id, next); audit("تعديل", "finance", existing.id, "تعديل " + sum, existing, next); }
      else { const id = Store.newId(); await Store.put("finance", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "finance", id, sum); }
    }
  });
}

const countDraft = {};
VIEWS.count = () => {
  const ss = stockSummary("", "");
  const hist = [...S.counts.values()].sort((a, b) => a.at < b.at ? 1 : -1).slice(0, 20);
  const diffHtml = d => d == null || isNaN(d) ? "—" : d === 0 ? pill(["مطابق", "good"]) : d < 0 ? `<span class="neg">عجز ${nf(-d)}</span>` : `<span class="pos">زيادة ${nf(d)}</span>`;
  return `${headHtml("الجرد الفعلي", "اكتب عدد الأطباق الموجود فعلاً في الغرفة، والسيستم يظهر العجز أو الزيادة")}
  <section class="panel"><div class="panel-head"><h2>جرد اليوم ${fmtDate(today())}</h2><span class="hint">اترك الخانة فارغة للأصناف التي لم تُعد</span></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">رصيد السيستم</th><th>الموجود فعلاً</th><th class="n">الفرق</th></tr></thead><tbody>
  ${items().length ? items().map(i => { const sys = ss.get(i.id).closing; const v = countDraft[i.id] ?? ""; const d = v === "" ? null : r2(pnum(v) - sys);
    return `<tr><td>${esc(i.name)}</td><td class="n">${nf(sys)} طبق</td><td><input type="text" inputmode="decimal" id="cnt-${i.id}" data-cnt="${i.id}" value="${esc(v)}" placeholder="أطباق" aria-label="العدد الفعلي ${esc(i.name)}" autocomplete="off"></td><td class="n" data-cdiff="${i.id}">${diffHtml(d)}</td></tr>`; }).join("") : emptyRow(4, "لا توجد أصناف.")}
  </tbody></table></div>
  ${workers().length ? `<div class="filters"><label>العامل المسؤول عن الجرد<select id="cnt-by">${opt(OWNER_ID, ownerName(), lastBy())}${workers().map(w => opt(w.id, w.name, lastBy())).join("")}</select></label></div>` : ""}
  <label class="check"><input type="checkbox" id="cnt-apply" ${isMgr() ? "checked" : "disabled"}> اعتماد الفروق وتسوية رصيد السيستم${isMgr() ? "" : " (للمدير فقط)"}</label>
  <div class="actions"><button class="btn primary" data-act="save-count">حفظ الجرد</button><button class="btn" data-act="clear-count">مسح الخانات</button></div></section>
  <section class="panel"><h2>جرد سابق</h2><div class="tbl-wrap"><table class="rtable"><thead><tr><th>التاريخ</th><th>النتيجة</th><th>بواسطة</th><th>اعتماد</th></tr></thead><tbody>
  ${hist.length ? hist.map(c => `<tr><td class="nowrap">${fmtDT(c.at)}</td><td class="small">${(c.lines || []).map(l => `${esc(itemName(l.itemId))}: ${diffHtml(l.diff)}`).join(" · ")}</td><td class="small muted">${esc(wName(c.by))}</td><td>${c.applied ? pill(["تمت التسوية", "acc"]) : pill(["للمراجعة", "warn"])}</td></tr>`).join("") : emptyRow(4, "لم يُسجل جرد فعلي بعد.")}
  </tbody></table></div></section>`;
};
afterRender.count = () => {
  const ss = stockSummary("", "");
  const cb = $("#cnt-by"); if (cb) cb.onchange = () => { lsSet("petshome:lastBy", cb.value); cb.blur(); };
  $$("[data-cnt]").forEach(inp => inp.oninput = () => {
    const id = inp.dataset.cnt; countDraft[id] = inp.value; const sys = ss.get(id).closing; const v = pnum(inp.value);
    const cell = $(`[data-cdiff="${id}"]`); if (inp.value === "" || isNaN(v)) { cell.textContent = "—"; return; }
    const d = r2(v - sys); cell.innerHTML = d === 0 ? pill(["مطابق", "good"]) : d < 0 ? `<span class="neg">عجز ${nf(-d)}</span>` : `<span class="pos">زيادة ${nf(d)}</span>`;
    cell.dataset.label = "الفرق";
  });
};
function saveCount() {
  const ss = stockSummary("", ""); const lines = [];
  for (const i of items()) { const v = pnum(countDraft[i.id]); if (countDraft[i.id] === "" || countDraft[i.id] == null || isNaN(v)) continue; const sys = r2(ss.get(i.id).closing); lines.push({ itemId: i.id, system: sys, actual: r2(v), diff: r2(v - sys) }); }
  if (!lines.length) return toast("اكتب العدد الفعلي لصنف واحد على الأقل.");
  const apply = isMgr() && $("#cnt-apply")?.checked;
  const id = Store.newId(); const at = nowISO();
  Store.put("counts", id, { date: today(), lines, applied: !!apply, by: lastBy(), at });
  for (const l of lines) if (apply && l.diff !== 0) {
    const per = +item(l.itemId).perPlate || 0;
    Store.put("moves", Store.newId(), { type: "adjust", itemId: l.itemId, plates: l.diff, qty: r2(l.diff * per), date: today(), note: `تسوية جرد فعلي (${l.diff < 0 ? "عجز" : "زيادة"})`, refType: "count", refId: id, by: lastBy(), at });
  }
  pendingBy = lastBy();
  audit("إضافة", "count", id, `جرد فعلي: ${lines.map(l => `${itemName(l.itemId)} ${l.diff === 0 ? "مطابق" : l.diff < 0 ? "عجز " + nf(-l.diff) : "زيادة " + nf(l.diff)}`).join("، ")}${apply ? " — تم اعتماد التسوية" : ""}`);
  Object.keys(countDraft).forEach(k => delete countDraft[k]);
  toast(apply ? "تم حفظ الجرد وتسوية الأرصدة" : "تم حفظ الجرد"); render();
}

let rp = { preset: "today", from: today(), to: today(), tab: "monthly", cust: "", month: today().slice(0, 7) };
function setPreset(p) {
  const t = today(); rp.preset = p;
  if (p === "today") { rp.from = t; rp.to = t; }
  else if (p === "week") { const d = new Date(t + "T12:00:00"); const back = (d.getDay() + 1) % 7; rp.from = addDays(t, -back); rp.to = t; }
  else if (p === "month") { rp.from = t.slice(0, 8) + "01"; rp.to = t; }
  else if (p === "lastmonth") { const d = new Date(t.slice(0, 8) + "01T12:00:00"); d.setDate(0); rp.to = ymd(d); rp.from = rp.to.slice(0, 8) + "01"; }
}
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const curMonth = () => today().slice(0, 7);
const monthLabel = ym => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const monthRange = ym => { const [y, m] = ym.split("-").map(Number); return { from: `${ym}-01`, to: `${ym}-${pad(new Date(y, m, 0).getDate())}` }; };
const prevMonth = ym => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; };
const pct = v => v == null ? "—" : nf(v, 1) + "٪";
/* Months that have any record, newest first (the current month is always included). */
function dataMonths() {
  return memo("months", () => {
    const set = new Set([curMonth()]);
    for (const c of ["orders", "finance", "payments", "moves"]) for (const r of S[c].values()) if (r.date && r.date.slice(0, 7) <= curMonth()) set.add(r.date.slice(0, 7));
    return [...set].sort().reverse();
  });
}
const saleValue = (itemId, plates, qty) => { const it = item(itemId); if (!it) return 0; return r2((it.priceBasis === "unit" ? qty : plates) * (+it.price || 0)); };
/* Profit for one calendar month: sales + other income − expenses, each counted on its own date (credit included). */
function monthReport(ym) {
  return memo("mr:" + ym, () => {
    const { from, to } = monthRange(ym); const ms = moneySummary(from, to);
    const revenue = r2(ms.sales + ms.income), net = ms.net;
    let owed = 0, discounts = 0; const byItem = {};
    for (const o of S.orders.values()) if (o.status !== "cancelled" && inRange(o.date, from, to)) {
      owed += Math.max(0, (+o.total || 0) - orderPaid(o)); discounts += +o.discount || 0;
      (o.lines || []).forEach(l => { const r = byItem[l.itemId] = byItem[l.itemId] || { plates: 0, qty: 0, value: 0 }; r.plates += +l.plates || 0; r.qty += +l.qty || 0; r.value += +l.total || 0; });
    }
    let prodPlates = 0, wdPlates = 0, wdValue = 0;
    for (const m of S.moves.values()) if (inRange(m.date, from, to)) {
      if (m.type === "production") prodPlates += +m.plates || 0;
      if (m.type === "withdraw") { wdPlates += +m.plates || 0; wdValue += saleValue(m.itemId, +m.plates || 0, +m.qty || 0); }
    }
    const ss = stockSummary("", to); let stockValue = 0;
    items(true).forEach(i => { const b = ss.get(i.id); if (b && b.closing > 0) stockValue += saleValue(i.id, b.closing, b.closingQ); });
    return { ym, from, to, ms, revenue, net, margin: revenue > 0 ? net / revenue * 100 : null, owed: r2(owed), discounts: r2(discounts), byItem,
      prodPlates: r2(prodPlates), wdPlates: r2(wdPlates), wdValue: r2(wdValue), stockValue: r2(stockValue),
      cashIn: r2(ms.collectedAtOrder + ms.payments + ms.incomeCash), cashOut: r2(ms.expenseCash), done: to < today() };
  });
}
function monthText(ym) {
  const R = monthReport(ym), ms = R.ms, pm = prevMonth(ym), P = monthReport(pm), hasPrev = dataMonths().includes(pm);
  return [`${settings().farmName || "Pets Home"} — ${R.done ? "أرباح شهر" : "أرباح الشهر حتى اليوم —"} ${monthLabel(ym)}`, "—".repeat(14),
    `المبيعات: ${money(ms.sales)} (${ms.orders} أوردر)`, ms.income ? `إيرادات أخرى: ${money(ms.income)}` : null,
    `المصروفات: ${money(ms.expense)}`, ...Object.entries(ms.byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `  • ${c}: ${money(v)}`),
    "—".repeat(14), `${R.net >= 0 ? "صافي الربح" : "صافي الخسارة"}: ${money(Math.abs(R.net))}${R.margin == null ? "" : ` (هامش ${pct(R.margin)})`}`,
    hasPrev ? `مقارنة بـ${monthLabel(pm)}: ${R.net - P.net >= 0 ? "+" : "−"}${money(Math.abs(r2(R.net - P.net)))}` : null,
    `محصّل في الشهر: ${money(R.cashIn)} · متبقي على العملاء من مبيعات الشهر: ${money(R.owed)}`].filter(Boolean).join("\n");
}
/* Dashboard panel: this month so far, last month's final result, and a notice in the first week of a new month. */
function monthPanel() {
  const cm = curMonth(), pm = prevMonth(cm), R = monthReport(cm), P = monthReport(pm);
  const prevHas = dataMonths().includes(pm), newMonth = +today().slice(8, 10) <= 7 && prevHas;
  return `<section class="panel"><div class="panel-head"><h2>أرباح الشهر</h2><button type="button" class="linkbtn small" data-act="month-report" data-id="${cm}">التقرير الكامل</button></div>
    ${newMonth ? `<div class="banner info">انتهى شهر ${monthLabel(pm)}: ${P.net >= 0 ? "صافي الربح" : "صافي الخسارة"} <b class="num">${money(Math.abs(P.net))}</b>. <button type="button" class="linkbtn" data-act="month-report" data-id="${pm}">عرض تقرير الشهر</button></div>` : ""}
    <div class="kpis two">
      <div class="kpi hero"><span>${monthLabel(cm)} حتى اليوم</span><b class="num">${money(R.net)}</b><small>إيرادات ${money(R.revenue)} − مصروفات ${money(R.ms.expense)}</small></div>
      ${prevHas ? `<div class="kpi"><span>${monthLabel(pm)} (مكتمل)</span><b class="num ${P.net < 0 ? "neg" : ""}">${money(P.net)}</b><small>هامش الربح ${pct(P.margin)}</small></div>`
        : `<div class="kpi"><span>هامش الربح</span><b class="num">${pct(R.margin)}</b><small>من الإيرادات</small></div>`}
    </div></section>`;
}
const RTABS = [["monthly", "الأرباح الشهرية"], ["stock", "حركة المخزون"], ["production", "الإنتاج"], ["sales", "المبيعات"], ["expenses", "المصروفات"], ["pnl", "الأرباح والخسائر"], ["statement", "كشف حساب عميل"], ["cash", "حركة الخزنة"]];
VIEWS.reports = () => `${headHtml("التقارير والحسابات", rp.tab === "monthly" ? `أرباح شهر ${monthLabel(rp.month)}` : `من ${fmtDate(rp.from)} إلى ${fmtDate(rp.to)}`)}
  <section class="panel">
    ${rp.tab === "monthly" ? "" : `<div class="seg" role="group" aria-label="الفترة">${[["today", "اليوم"], ["week", "الأسبوع"], ["month", "الشهر"], ["lastmonth", "الشهر الماضي"], ["custom", "مخصص"]].map(([k, l]) => `<button type="button" data-rpp="${k}" aria-pressed="${k === rp.preset}">${l}</button>`).join("")}</div>
    ${rp.preset === "custom" ? `<div class="filters"><label>من<input type="date" id="rp-from" value="${rp.from}"></label><label>إلى<input type="date" id="rp-to" value="${rp.to}"></label></div>` : ""}`}
    <div class="seg" role="tablist" aria-label="التقرير">${RTABS.map(([k, l]) => `<button type="button" data-rpt="${k}" aria-pressed="${k === rp.tab}">${l}</button>`).join("")}</div></section>
  <section class="panel">${REPORTS[rp.tab]()}</section>`;
afterRender.reports = () => {
  $$("[data-rpp]").forEach(b => b.onclick = () => { if (b.dataset.rpp === "custom") rp.preset = "custom"; else setPreset(b.dataset.rpp); render(); });
  $$("[data-rpt]").forEach(b => b.onclick = () => { rp.tab = b.dataset.rpt; render(); });
  const f = $("#rp-from"), t = $("#rp-to"); if (f) { f.onchange = () => { rp.from = f.value || today(); f.blur(); render(); }; t.onchange = () => { rp.to = t.value || today(); t.blur(); render(); }; }
  const cs = $("#rp-cust"); if (cs) cs.onchange = () => { rp.cust = cs.value; cs.blur(); render(); };
  const mm = $("#mr-month"); if (mm) mm.onchange = () => { rp.month = mm.value; mm.blur(); render(); };
  $$("[data-mr]").forEach(b => b.onclick = () => { rp.month = b.dataset.mr; render(); window.scrollTo(0, 0); });
  const msh = $("#mr-share"); if (msh) msh.onclick = () => shareOrCopy("أرباح الشهر", monthText(rp.month), "تم نسخ تقرير الشهر");
  const cp = $("#rp-copy"); if (cp) cp.onclick = () => shareOrCopy("كشف حساب", statementText(rp.cust, rp.from, rp.to), "تم نسخ كشف الحساب");
  const sel = $(".seg[role=tablist] [aria-pressed=true]"); if (sel) try { sel.scrollIntoView({ inline: "nearest", block: "nearest" }); } catch {}
};
const REPORTS = {
  monthly() {
    const months = dataMonths(); if (!months.includes(rp.month)) rp.month = months[0];
    const R = monthReport(rp.month), ms = R.ms, pm = prevMonth(rp.month), P = monthReport(pm), hasPrev = months.includes(pm);
    const delta = r2(R.net - P.net);
    const rows = Object.entries(R.byItem).sort((a, b) => b[1].value - a[1].value);
    const linesTotal = rows.reduce((a, [, r]) => a + r.value, 0);
    return `<div class="panel-head"><h2>${R.done ? "أرباح شهر" : "أرباح الشهر حتى اليوم —"} ${monthLabel(R.ym)}</h2>${R.done ? pill(["شهر مكتمل", "good"]) : pill([`الشهر جاري، يكتمل ${fmtDate(R.to)}`, "warn"])}</div>
    <div class="filters"><label>الشهر<select id="mr-month">${months.map(m => opt(m, monthLabel(m) + (m === curMonth() ? " (الحالي)" : ""), rp.month)).join("")}</select></label>
      <button type="button" class="btn" id="mr-share">${navigator.share ? "مشاركة التقرير" : "نسخ التقرير"}</button></div>
    <div class="kpis">
      <div class="kpi hero"><span>${R.net >= 0 ? "صافي الربح" : "صافي الخسارة"}</span><b class="num">${money(Math.abs(R.net))}</b><small>${hasPrev ? `${delta >= 0 ? "▲" : "▼"} ${money(Math.abs(delta))} عن ${monthLabel(pm)}` : (R.done ? "شهر مكتمل" : "حتى اليوم")}</small></div>
      <div class="kpi"><span>إجمالي الإيرادات</span><b class="num">${money(R.revenue)}</b><small>${ms.orders} أوردر</small></div>
      <div class="kpi"><span>إجمالي المصروفات</span><b class="num">${money(ms.expense)}</b><small>${ms.expenseCredit ? "منها آجل " + money(ms.expenseCredit) : "كلها نقدي"}</small></div>
      <div class="kpi"><span>هامش الربح</span><b class="num">${pct(R.margin)}</b><small>من الإيرادات</small></div>
    </div>
    <div class="grid2">
      <div class="stack"><h3>حساب الربح</h3><div class="sum-box">
        <div><span>المبيعات</span><b class="num">${money(ms.sales)}</b></div>
        <div><span>+ إيرادات أخرى</span><b class="num">${money(ms.income)}</b></div>
        <div class="big"><span>= إجمالي الإيرادات</span><b class="num">${money(R.revenue)}</b></div>
        ${Object.entries(ms.byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="small"><span>− ${esc(c)}</span><span class="num">${money(v)}</span></div>`).join("") || `<div class="small"><span>لا مصروفات مسجلة في الشهر</span><span></span></div>`}
        <div class="big"><span>− إجمالي المصروفات</span><b class="num">${money(ms.expense)}</b></div>
        <div class="big"><span>= ${R.net >= 0 ? "صافي الربح" : "صافي الخسارة"}</span><b class="num ${R.net >= 0 ? "pos" : "neg"}">${money(Math.abs(R.net))}</b></div></div>
        ${hasPrev ? `<h3>مقارنة بـ${monthLabel(pm)}</h3><div class="sum-box">
          <div class="small"><span></span><span class="muted">${MONTHS[+pm.slice(5, 7) - 1]} · ${MONTHS[+R.ym.slice(5, 7) - 1]}</span></div>
          <div class="small"><span>الإيرادات</span><span class="num">${nf(P.revenue)} · ${nf(R.revenue)}</span></div>
          <div class="small"><span>المصروفات</span><span class="num">${nf(P.ms.expense)} · ${nf(ms.expense)}</span></div>
          <div class="big"><span>صافي الربح</span><b class="num">${nf(P.net)} · ${nf(R.net)}</b></div>
          <div class="small"><span>الفرق في الربح</span><span class="num ${delta >= 0 ? "pos" : "neg"}">${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}</span></div></div>` : ""}
      </div>
      <div class="stack"><h3>الفلوس الفعلية في الشهر</h3><div class="sum-box">
        <div><span>دخل الخزنة (محصّل)</span><b class="num pos">${money(R.cashIn)}</b></div>
        <div><span>خرج من الخزنة</span><b class="num neg">${money(R.cashOut)}</b></div>
        <div class="big"><span>صافي النقدية</span><b class="num">${money(r2(R.cashIn - R.cashOut))}</b></div>
        <div class="small"><span>متبقي على العملاء من مبيعات الشهر</span><span class="num">${money(R.owed)}</span></div>
        ${ms.expenseCredit ? `<div class="small"><span>مصروفات آجلة لم تُدفع</span><span class="num">${money(ms.expenseCredit)}</span></div>` : ""}</div>
        <h3>معلومات إضافية</h3><div class="sum-box">
        <div class="small"><span>أطباق منتجة في الشهر</span><span class="num">${nf(R.prodPlates)}</span></div>
        <div class="small"><span>مسحوبات وتالف (بسعر البيع)</span><span class="num">${nf(R.wdPlates)} طبق · ${money(R.wdValue)}</span></div>
        <div class="small"><span>قيمة المخزون ${R.done ? "آخر الشهر" : "الآن"} (بسعر البيع)</span><span class="num">${money(R.stockValue)}</span></div></div>
      </div>
    </div>
    <h3>المبيعات حسب الصنف</h3><div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">أطباق</th><th class="n">القيمة</th><th class="n">من المبيعات</th></tr></thead><tbody>
    ${rows.length ? rows.map(([id, r]) => `<tr><td>${esc(itemName(id))}</td><td class="n">${nf(r.plates)}</td><td class="n">${nf(r.value)}</td><td class="n">${pct(linesTotal ? r.value / linesTotal * 100 : null)}</td></tr>`).join("") : emptyRow(4, "لا مبيعات في هذا الشهر.")}
    </tbody>${R.discounts ? `<tfoot><tr><td colspan="2">خصومات على الأوردرات</td><td class="n" data-label="القيمة">−${nf(R.discounts)}</td><td></td></tr></tfoot>` : ""}</table></div>
    <h3>كل الشهور</h3><div class="tbl-wrap"><table class="rtable"><thead><tr><th>الشهر</th><th class="n">الإيرادات</th><th class="n">المصروفات</th><th class="n">صافي الربح</th><th class="n">الهامش</th><th></th></tr></thead><tbody>
    ${months.map(m => { const x = monthReport(m); return `<tr><td>${monthLabel(m)}${m === curMonth() ? ` <span class="small muted">(جاري)</span>` : ""}</td><td class="n">${nf(x.revenue)}</td><td class="n">${nf(x.ms.expense)}</td><td class="n ${x.net >= 0 ? "pos" : "neg"}"><b>${nf(x.net)}</b></td><td class="n">${pct(x.margin)}</td><td>${m === rp.month ? pill(["معروض", "acc"]) : `<button type="button" class="btn sm" data-mr="${m}">عرض</button>`}</td></tr>`; }).join("")}
    </tbody></table></div>
    <p class="small muted">الربح = المبيعات + الإيرادات الأخرى − المصروفات، وكل عملية محسوبة في شهرها حتى لو آجلة ولم تُدفع بعد. عشان الربح يطلع صح، سجّل كل تكاليف الإنتاج (خامات، أكل، أجور، كهرباء…) كمصروفات.</p>`;
  },
  stock() {
    const ss = stockSummary(rp.from, rp.to);
    const rows = items(true).filter(i => i.active !== false || ss.get(i.id).closing !== 0);
    return `<h2>حركة المخزون بالأطباق</h2><div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">أول المدة</th><th class="n">+ افتتاحي</th><th class="n">+ إنتاج</th><th class="n">− مبيعات</th><th class="n">− مسحوبات</th><th class="n">± تسويات</th><th class="n">آخر المدة</th><th class="n">الكمية</th></tr></thead><tbody>
    ${rows.length ? rows.map(i => { const b = ss.get(i.id); return `<tr><td>${esc(i.name)}</td><td class="n">${nf(b.before)}</td><td class="n">${nf(b.opening)}</td><td class="n">${nf(b.production)}</td><td class="n">${nf(b.sale)}</td><td class="n">${nf(b.withdraw)}</td><td class="n">${nf(b.adjust)}</td><td class="n"><b>${nf(b.closing)}</b></td><td class="n">${qtyStr(b.closingQ, i.id)}</td></tr>`; }).join("") : emptyRow(9, "لا توجد أصناف.")}
    </tbody></table></div><p class="small muted">آخر المدة = أول المدة + افتتاحي + إنتاج − مبيعات − مسحوبات ± تسويات الجرد.</p>`;
  },
  production() {
    const list = [...S.moves.values()].filter(m => m.type === "production" && inRange(m.date, rp.from, rp.to));
    const byItem = {}; list.forEach(m => { const r = byItem[m.itemId] = byItem[m.itemId] || { p: 0, q: 0, n: 0 }; r.p += +m.plates || 0; r.q += +m.qty || 0; r.n++; });
    const byDay = {}; list.forEach(m => byDay[m.date] = (byDay[m.date] || 0) + (+m.plates || 0));
    return `<h2>الإنتاج والإضافات</h2><div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">مرات التسجيل</th><th class="n">أطباق</th><th class="n">الكمية</th></tr></thead><tbody>
    ${Object.keys(byItem).length ? Object.entries(byItem).map(([id, r]) => `<tr><td>${esc(itemName(id))}</td><td class="n">${r.n}</td><td class="n">${nf(r.p)}</td><td class="n">${qtyStr(r.q, id)}</td></tr>`).join("") : emptyRow(4, "لا يوجد إنتاج في الفترة.")}</tbody>
    ${list.length ? `<tfoot><tr><td>الإجمالي</td><td class="n" data-label="مرات التسجيل">${list.length}</td><td class="n" data-label="أطباق">${nf(list.reduce((a, m) => a + (+m.plates || 0), 0))}</td><td></td></tr></tfoot>` : ""}</table></div>
    ${Object.keys(byDay).length > 1 ? `<h3>حسب اليوم</h3><div class="tbl-wrap"><table><tbody>${Object.entries(byDay).sort().map(([d, p]) => `<tr><td>${dayName(d)} ${fmtDate(d)}</td><td class="n">${nf(p)} طبق</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  },
  sales() {
    const os = [...S.orders.values()].filter(o => o.status !== "cancelled" && inRange(o.date, rp.from, rp.to));
    const byItem = {}, byCust = {};
    os.forEach(o => { (o.lines || []).forEach(l => { const r = byItem[l.itemId] = byItem[l.itemId] || { p: 0, q: 0, v: 0 }; r.p += +l.plates; r.q += +l.qty; r.v += +l.total; }); const c = byCust[o.customerId || ""] = byCust[o.customerId || ""] || { n: 0, v: 0, paid: 0 }; c.n++; c.v += +o.total; c.paid += orderPaid(o); });
    const ms = moneySummary(rp.from, rp.to);
    return `<div class="kpis"><div class="kpi"><span>عدد الأوردرات</span><b class="num">${ms.orders}</b></div><div class="kpi"><span>إجمالي المبيعات</span><b class="num">${money(ms.sales)}</b></div><div class="kpi"><span>محصّل مع الأوردرات</span><b class="num">${money(ms.collectedAtOrder)}</b></div><div class="kpi"><span>تحصيلات لاحقة</span><b class="num">${money(ms.payments)}</b></div></div>
    <h2>حسب الصنف</h2><div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">أطباق</th><th class="n">الكمية</th><th class="n">القيمة</th></tr></thead><tbody>${Object.keys(byItem).length ? Object.entries(byItem).map(([id, r]) => `<tr><td>${esc(itemName(id))}</td><td class="n">${nf(r.p)}</td><td class="n">${qtyStr(r.q, id)}</td><td class="n">${nf(r.v)}</td></tr>`).join("") : emptyRow(4, "لا مبيعات في الفترة.")}</tbody></table></div>
    <h2>حسب العميل</h2><div class="tbl-wrap"><table class="rtable"><thead><tr><th>العميل</th><th class="n">أوردرات</th><th class="n">القيمة</th><th class="n">المدفوع</th><th class="n">المتبقي</th></tr></thead><tbody>${Object.keys(byCust).length ? Object.entries(byCust).sort((a, b) => b[1].v - a[1].v).map(([id, r]) => `<tr><td>${esc(custName(id))}</td><td class="n">${r.n}</td><td class="n">${nf(r.v)}</td><td class="n">${nf(r.paid)}</td><td class="n">${nf(r2(r.v - r.paid))}</td></tr>`).join("") : emptyRow(5, "—")}</tbody></table></div>`;
  },
  expenses() {
    const list = [...S.finance.values()].filter(x => x.kind !== "income" && inRange(x.date, rp.from, rp.to)).sort((a, b) => a.date < b.date ? -1 : 1);
    const cats = {}; list.forEach(x => (cats[x.category] = cats[x.category] || []).push(x));
    const sum = xs => xs.reduce((s, x) => s + +x.amount, 0);
    return `<h2>المصروفات حسب البند — ${money(sum(list))}</h2>${Object.keys(cats).length ? Object.entries(cats).sort((a, b) => sum(b[1]) - sum(a[1])).map(([c, xs]) => `<div class="tbl-wrap"><table class="rtable no-title"><thead><tr><th>${esc(c)}</th><th>البيان</th><th>الدفع</th><th class="n">${nf(sum(xs))}</th></tr></thead><tbody>${xs.map(x => `<tr><td class="nowrap" data-label="التاريخ">${fmtDate(x.date)}</td><td>${esc(x.note || "—")}</td><td>${x.payType === "credit" ? pill(["آجل", "warn"]) : "نقدي"}</td><td class="n" data-label="المبلغ">${nf(x.amount)}</td></tr>`).join("")}</tbody></table></div>`).join("") : `<div class="empty">لا مصروفات في الفترة.</div>`}`;
  },
  pnl() {
    const ms = moneySummary(rp.from, rp.to);
    return `<h2>الأرباح والخسائر</h2><div class="sum-box" style="max-width:520px">
      <div><span>المبيعات</span><b class="num">${money(ms.sales)}</b></div><div><span>إيرادات أخرى</span><b class="num">${money(ms.income)}</b></div>
      <div class="big"><span>إجمالي الإيرادات</span><b class="num">${money(ms.sales + ms.income)}</b></div>
      ${Object.entries(ms.byCat).map(([c, v]) => `<div class="small"><span>− ${esc(c)}</span><span class="num">${money(v)}</span></div>`).join("")}
      <div class="big"><span>إجمالي المصروفات</span><b class="num">${money(ms.expense)}</b></div>
      <div class="big"><span>${ms.net >= 0 ? "صافي الربح" : "صافي الخسارة"}</span><b class="num ${ms.net >= 0 ? "pos" : "neg"}">${money(Math.abs(ms.net))}</b></div></div>
      <p class="small muted">المبيعات والمصروفات الآجلة محسوبة في فترتها حتى لو لم تُدفع بعد. تكلفة الإنتاج تظهر في بنود المصروفات (خامات، أكل، أجور…).</p>`;
  },
  statement() {
    const cs = customers(); if (rp.cust !== "" && !S.customers.get(rp.cust)) rp.cust = ""; if (!rp.cust && cs[0] && rp.custInit !== true) { rp.cust = cs[0].id; rp.custInit = true; }
    return `<div class="panel-head"><h2>كشف حساب عميل</h2></div><div class="filters"><label>العميل<select id="rp-cust">${cs.map(c => opt(c.id, c.name, rp.cust)).join("")}${opt("", "مبيعات نقدية بدون اسم", rp.cust)}</select></label><button type="button" class="btn sm" id="rp-copy">${navigator.share ? "مشاركة الكشف" : "نسخ الكشف"}</button></div>${statementHtml(rp.cust, rp.from, rp.to)}`;
  },
  cash() {
    const rows = [];
    for (const o of S.orders.values()) if (o.status !== "cancelled" && +o.paidNow) rows.push({ date: o.date, at: o.at, desc: `مدفوع مع أوردر ${o.no} — ${custName(o.customerId)}`, inn: +o.paidNow, out: 0 });
    for (const p of S.payments.values()) rows.push({ date: p.date, at: p.at, desc: `تحصيل من ${custName(p.customerId)} (${p.method || "نقدي"})`, inn: +p.amount, out: 0 });
    for (const x of S.finance.values()) if (x.payType !== "credit") rows.push({ date: x.date, at: x.at, desc: `${x.kind === "income" ? "إيراد" : "مصروف"} ${x.category}${x.note ? " — " + x.note : ""}`, inn: x.kind === "income" ? +x.amount : 0, out: x.kind === "income" ? 0 : +x.amount });
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || "") < (b.at || "") ? -1 : 1);
    let bal = 0, opening = 0, ti = 0, to = 0; const out = [];
    rows.forEach(r => { bal = r2(bal + r.inn - r.out); if (r.date < rp.from) opening = bal; else if (r.date <= rp.to) { ti += r.inn; to += r.out; out.push(Object.assign(r, { bal })); } });
    return `<h2>حركة الخزنة</h2><div class="tbl-wrap"><table class="rtable"><thead><tr><th>البيان</th><th>التاريخ</th><th class="n">داخل</th><th class="n">خارج</th><th class="n">الرصيد</th></tr></thead><tbody>
    <tr><td class="muted">رصيد أول المدة</td><td>${fmtDate(rp.from)}</td><td></td><td></td><td class="n"><b>${nf(opening)}</b></td></tr>
    ${out.length ? out.map(r => `<tr><td>${esc(r.desc)}</td><td class="nowrap">${fmtDate(r.date)}</td><td class="n pos">${r.inn ? nf(r.inn) : "—"}</td><td class="n neg">${r.out ? nf(r.out) : "—"}</td><td class="n">${nf(r.bal)}</td></tr>`).join("") : emptyRow(5, "لا حركة نقدية في الفترة.")}
    </tbody><tfoot><tr><td colspan="2">الإجمالي</td><td class="n" data-label="داخل">${nf(ti)}</td><td class="n" data-label="خارج">${nf(to)}</td><td class="n" data-label="الرصيد">${nf(r2(opening + ti - to))}</td></tr></tfoot></table></div>
    <p class="small muted">لا تشمل المبيعات والمصروفات الآجلة حتى يتم دفعها.</p>`;
  }
};

let lg = { from: addDays(today(), -6), to: today(), worker: "", q: "" };
VIEWS.log = () => {
  let list = allAudit().filter(e => { const d = localDay(e.at); return d >= lg.from && d <= lg.to; });
  if (lg.worker) list = list.filter(e => (e.by || OWNER_ID) === lg.worker);
  if (lg.q) list = list.filter(e => (e.summary || "").includes(lg.q));
  return `${headHtml("سجل العمليات", "كل عملية محفوظة بوقتها والعامل المسؤول. التعديلات تظهر بالقيمة القديمة والجديدة.")}
  <section class="panel"><div class="filters"><label>من<input type="date" id="lg-from" value="${lg.from}"></label><label>إلى<input type="date" id="lg-to" value="${lg.to}"></label>
  <label>العامل<select id="lg-w">${opt("", "الكل", lg.worker)}${opt(OWNER_ID, ownerName(), lg.worker)}${workers(true).map(w => opt(w.id, w.name, lg.worker)).join("")}</select></label>
  <label>بحث<input type="search" id="lg-q" placeholder="عميل، صنف، رقم أوردر" value="${esc(lg.q)}"></label></div>
  <div class="tbl-wrap"><table class="rtable no-title"><thead><tr><th>الوقت</th><th>العملية</th><th>التفاصيل</th><th>المسؤول</th></tr></thead><tbody>
  ${list.length ? list.slice(0, 500).map(e => `<tr><td class="nowrap small">${fmtDT(e.at)}</td><td>${pill([e.action, e.action === "حذف" || e.action === "إلغاء" ? "bad" : e.action === "تعديل" ? "warn" : "acc"])}</td><td class="span"><div class="logline"><span>${esc(e.summary)}</span>${(e.changes || []).length ? `<span class="changes">${e.changes.map(c => `${esc(FIELD_LABEL[c.f] || c.f)}: <del>${esc(c.from)}</del> ← <ins>${esc(c.to)}</ins>`).join(" · ")}</span>` : ""}</div></td><td class="small">${esc(wName(e.by))}</td></tr>`).join("") : emptyRow(4, "لا عمليات مطابقة.")}
  </tbody></table></div>${list.length > 500 ? `<p class="small muted">يظهر أحدث 500 عملية. ضيّق الفترة لعرض الباقي.</p>` : ""}</section>`;
};
afterRender.log = () => {
  $("#lg-from").onchange = e => { lg.from = e.target.value || lg.from; e.target.blur(); render(); };
  $("#lg-to").onchange = e => { lg.to = e.target.value || lg.to; e.target.blur(); render(); };
  $("#lg-w").onchange = e => { lg.worker = e.target.value; e.target.blur(); render(); };
  wireSearch("#lg-q", v => lg.q = v);
};

VIEWS.admin = () => {
  const ss = stockSummary("", ""); const s = settings();
  return `${headHtml("الإعدادات", "الأصناف وأوزان الأطباق والأسعار، العمال، والنسخ الاحتياطي")}
  <section class="panel"><div class="panel-head"><h2>الأصناف</h2><button class="btn primary" data-act="new-item">+ صنف جديد</button></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">الطبق =</th><th class="n">السعر</th><th class="n">تنبيه عند</th><th class="n">الرصيد</th><th>الحالة</th><th></th></tr></thead><tbody>
  ${items(true).length ? items(true).map(i => `<tr><td><b>${esc(i.name)}</b></td><td class="n">${nf(i.perPlate)} ${esc(i.unit)}</td><td class="n">${nf(i.price)} / ${i.priceBasis === "unit" ? esc(i.unit) : "طبق"}</td><td class="n">${+i.minPlates ? nf(i.minPlates) + " طبق" : "—"}</td><td class="n">${nf(ss.get(i.id)?.closing || 0)} طبق</td><td>${i.active === false ? pill(["موقوف"]) : pill(["نشط", "good"])}</td><td class="nowrap"><button class="btn sm" data-act="edit-item" data-id="${i.id}">تعديل</button></td></tr>`).join("") : emptyRow(7, "أضف أصناف المزرعة مع وزن أو عدد الطبق الواحد وسعره.")}
  </tbody></table></div><p class="small muted">بعد إضافة الصنف، سجّل الموجود حالياً في الغرفة من «المخزون ← رصيد افتتاحي».</p></section>
  <section class="panel"><div class="panel-head"><h2>العمال</h2><button class="btn primary" data-act="new-worker">+ عامل</button></div>
  <p class="small muted">أسماء العمال تظهر في خانة «العامل المسؤول» عند تسجيل الإنتاج والسحب والأوردرات والمصروفات. حسابات دخول العمال تأتي مع النسخة الأونلاين.</p>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الاسم</th><th>التليفون</th><th>الحالة</th><th></th></tr></thead><tbody>
  ${workers(true).length ? workers(true).map(w => `<tr><td><b>${esc(w.name)}</b></td><td dir="ltr" style="text-align:start">${esc(w.phone || "—")}</td><td>${w.active === false ? pill(["موقوف"]) : pill(["نشط", "good"])}</td><td class="nowrap"><button class="btn sm" data-act="edit-worker" data-id="${w.id}">تعديل</button> <button class="btn sm" data-act="worker-log" data-id="${w.id}">حركاته</button></td></tr>`).join("") : emptyRow(4, "لم تضف عمالاً بعد. أضفهم لو عايز تسجل مين المسؤول عن كل عملية.")}
  </tbody></table></div></section>
  <div class="grid2">
  <section class="panel"><h2>بيانات المزرعة</h2><form id="set-form" class="form">${field("اسم المزرعة", `<input type="text" name="farmName" id="set-farm" value="${esc(s.farmName || "")}">`)}${field("اسمك", `<input type="text" name="ownerName" id="set-owner" value="${esc(s.ownerName || "")}">`)}${field("العملة", `<input type="text" name="currency" id="set-cur" value="${esc(s.currency || "")}">`)}<div class="f full"><button class="btn primary" type="submit" style="align-self:flex-start">حفظ</button></div></form></section>
  <section class="panel"><h2>البيانات والنسخ الاحتياطي</h2><p class="small muted">كل البيانات محفوظة على هذا الموبايل فقط. آخر نسخة احتياطية: <b>${s.lastBackup ? fmtDT(s.lastBackup) : "لم تُعمل بعد"}</b></p>
  <div class="actions"><button class="btn primary" data-act="backup">نسخة احتياطية / استرجاع</button><button class="btn danger" data-act="reset">مسح كل البيانات</button></div></section></div>
  <p class="small muted">Pets Home — نسخة محلية تجريبية (${APP_VERSION})</p>`;
};
afterRender.admin = () => {
  $("#set-form").onsubmit = e => {
    e.preventDefault(); const fd = new FormData(e.target); const before = settings();
    const next = Object.assign({}, before, { farmName: fv(fd, "farmName") || "Pets Home", ownerName: fv(fd, "ownerName") || before.ownerName || "المدير", currency: fv(fd, "currency") || "ج.م" }); delete next.id;
    Store.put("meta", "settings", next); audit("تعديل", "settings", "settings", "تعديل بيانات المزرعة", before, next); document.activeElement?.blur(); toast("تم الحفظ");
  };
};
function itemForm(existing) {
  const i = existing || { unit: "كجم", priceBasis: "plate", active: true };
  openModal(existing ? `تعديل صنف ${i.name}` : "صنف جديد", `<div class="form">
    ${field("اسم الصنف", `<input type="text" name="name" id="f-name" value="${esc(i.name || "")}" required>`, "full")}
    ${field("وحدة القياس", `<select name="unit" id="f-unit">${UNITS.map(u => opt(u, u, i.unit)).join("")}</select>`)}
    ${field("الطبق الواحد =", numInput("perPlate", i.perPlate, "required"), "", "وزن أو عدد الطبق الواحد بالوحدة المختارة")}
    ${field("سعر البيع", numInput("price", i.price))}
    ${field("السعر على", `<select name="priceBasis" id="f-priceBasis">${opt("plate", "الطبق", i.priceBasis)}${opt("unit", "الوحدة (كجم/عدد…)", i.priceBasis)}</select>`)}
    ${field("تنبيه رصيد منخفض عند (أطباق)", numInput("minPlates", i.minPlates))}
    <label class="check f"><input type="checkbox" name="active" id="f-active" ${i.active !== false ? "checked" : ""}> الصنف نشط</label></div>`, {
    done: "تم الحفظ",
    onSubmit: async fd => {
      const name = fv(fd, "name"); const per = fnum(fd, "perPlate");
      if (!name) return "اكتب اسم الصنف."; if (!isFinite(per) || per <= 0) return "اكتب وزن أو عدد الطبق الواحد.";
      const data = { name, unit: fv(fd, "unit"), perPlate: r2(per), price: r2(fnum(fd, "price") || 0), priceBasis: fv(fd, "priceBasis"), minPlates: r2(fnum(fd, "minPlates") || 0), active: fd.get("active") === "on" };
      if (existing) { const next = Object.assign({}, existing, data); await Store.put("items", existing.id, next); audit("تعديل", "item", existing.id, `تعديل صنف ${name}`, existing, next); }
      else { const id = Store.newId(); await Store.put("items", id, Object.assign(data, { at: nowISO(), by: me().id })); audit("إضافة", "item", id, `إضافة صنف ${name} (الطبق = ${data.perPlate} ${data.unit})`); }
    }
  });
}
function workerForm(existing) {
  const w = existing || { active: true };
  openModal(existing ? `تعديل ${w.name}` : "عامل جديد", `<div class="form">
    ${field("الاسم", `<input type="text" name="name" id="f-name" value="${esc(w.name || "")}" required>`)}
    ${field("التليفون", `<input type="tel" name="phone" id="f-phone" dir="ltr" value="${esc(w.phone || "")}">`)}
    <label class="check f full"><input type="checkbox" name="active" id="f-active" ${w.active !== false ? "checked" : ""}> يظهر في قائمة «العامل المسؤول»</label></div>`, {
    done: "تم الحفظ",
    onSubmit: async fd => {
      const name = fv(fd, "name"); if (!name) return "اكتب اسم العامل.";
      const data = { name, phone: fv(fd, "phone"), active: fd.get("active") === "on" };
      if (existing) { const next = Object.assign({}, existing, data); await Store.put("workers", existing.id, next); audit("تعديل", "worker", existing.id, `تعديل بيانات العامل ${name}`, existing, next); }
      else { const id = Store.newId(); await Store.put("workers", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "worker", id, `إضافة عامل ${name}`); }
    }
  });
}
const recordCount = () => COLS.filter(c => c !== "meta" && c !== "audit").reduce((a, c) => a + S[c].size, 0);
function backupData() {
  const o = { app: "petshome", version: 3, edition: "local", exportedAt: nowISO(), data: {} };
  COLS.forEach(c => o.data[c] = fromMap(S[c]));
  return o;
}
const backupName = () => `PetsHome-backup-${today()}.json`;
function markBackedUp() { const s = Object.assign({}, settings(), { lastBackup: nowISO() }); delete s.id; Store.put("meta", "settings", s); Local.flush(); }
function backupSheet() {
  const s = settings();
  const file = () => new File([JSON.stringify(backupData())], backupName(), { type: "application/json" });
  let canShareFile = false; try { canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file()] })); } catch {}
  openModal("نسخة احتياطية", `<div class="stack">
    <p>كل بيانات المزرعة محفوظة على هذا الموبايل فقط. لو اتمسح التطبيق أو ضاع الموبايل، النسخة الاحتياطية هي اللي بترجّع البيانات.</p>
    <div class="sum-box"><div><span>آخر نسخة احتياطية</span><b>${s.lastBackup ? fmtDT(s.lastBackup) : "لم تُعمل بعد"}</b></div><div><span>عدد السجلات</span><b>${nf(recordCount(), 0)}</b></div></div>
    <p class="small muted">احفظ النسخة في Google Drive أو ابعتها لنفسك على واتساب مرة في الأسبوع على الأقل. نفس الملف ده هو اللي هينقل بياناتك للنسخة الأونلاين بعدين.</p>
    <div class="actions">${canShareFile ? `<button type="button" class="btn primary" id="bk-share">حفظ في Drive / واتساب</button>` : ""}<button type="button" class="btn ${canShareFile ? "" : "primary"}" id="bk-dl">تنزيل الملف</button>
    <label class="btn">استرجاع نسخة<input type="file" id="bk-imp" accept=".json,application/json" hidden></label></div>
    ${Local.snapInfo ? `<h3>نسخة تلقائية على الموبايل</h3><div class="sum-box"><div class="small"><span>${esc(Local.snapInfo.reason)}</span><span>${fmtDT(Local.snapInfo.at)}</span></div><div class="small"><span>عدد السجلات</span><span class="num">${nf(Local.snapInfo.count, 0)}</span></div></div>
      <p class="small muted">التطبيق بيحفظ نسخة تلقائية قبل كل تحديث وقبل أي مسح أو استرجاع.</p><div class="actions"><button type="button" class="btn" id="bk-snap">استرجاع النسخة التلقائية</button></div>` : ""}</div>`, { noFocus: true });
  const sn = $("#bk-snap"); if (sn) sn.onclick = restoreSnapshot;
  const sh = $("#bk-share");
  if (sh) sh.onclick = async () => {
    try { await navigator.share({ files: [file()], title: "Pets Home backup" }); markBackedUp(); closeModal(); toast("تم حفظ النسخة الاحتياطية"); }
    catch (e) { if (!e || e.name !== "AbortError") toast("تعذرت المشاركة. استخدم «تنزيل الملف»."); }
  };
  $("#bk-dl").onclick = () => { saveFile(backupName(), JSON.stringify(backupData()), "application/json"); markBackedUp(); closeModal(); };
  $("#bk-imp").onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => importBackup(rd.result, false); rd.readAsText(f); e.target.value = ""; };
}
async function restoreSnapshot() {
  const snap = await Local.getKey("__snapshot");
  if (!snap || !snap.data) return toast("لا توجد نسخة تلقائية.");
  openModal("استرجاع النسخة التلقائية", `<p>هترجع البيانات زي ما كانت <b>${esc(snap.info.reason)}</b> (${fmtDT(snap.info.at)}).</p><p class="small muted">البيانات الحالية هتتحفظ كنسخة تلقائية جديدة، فتقدر ترجعلها لو احتجت.</p>`, {
    submitLabel: "استرجاع", noFocus: true,
    onSubmit: async () => {
      await Local.snapshot("قبل استرجاع النسخة التلقائية");
      COLS.forEach(c => { S[c] = toMap(snap.data[c]); Local.mark(c); }); ver++;
      audit("استرجاع", "snapshot", "", `استرجاع النسخة التلقائية (${snap.info.reason})`);
      await Local.flush(); toast("تم الاسترجاع");
    }
  });
}
function importBackup(text, fresh) {
  let o; try { o = JSON.parse(text); } catch { return toast("الملف ليس نسخة احتياطية صالحة."); }
  if (!o || o.app !== "petshome" || !o.data) return toast("الملف ليس نسخة احتياطية من Pets Home.");
  const cols = COLS.filter(c => o.data[c]);
  const n = cols.filter(c => c !== "meta" && c !== "audit").reduce((a, c) => a + Object.keys(o.data[c] || {}).length, 0);
  const apply = async replace => {
    if (replace && recordCount() > 0) await Local.snapshot("قبل استرجاع نسخة احتياطية");
    cols.forEach(c => {
      const m = replace ? new Map() : new Map(S[c]);
      Object.entries(o.data[c] || {}).forEach(([id, v]) => m.set(id, Object.assign({}, v, { id })));
      S[c] = m; Local.mark(c);
    });
    if (replace) COLS.filter(c => !cols.includes(c)).forEach(c => { S[c] = new Map(); Local.mark(c); });
    ver++;
    if (!S.meta.get("settings")) Store.put("meta", "settings", { farmName: "Pets Home", ownerName: "المدير", currency: "ج.م", createdAt: nowISO() });
    audit("استرجاع", "backup", "", `استرجاع نسخة احتياطية بتاريخ ${fmtDT(o.exportedAt)} (${n} سجل)${replace ? " — استبدال كامل" : " — دمج"}`);
    Local.flush(); closeModal(); toast("تم الاسترجاع"); render();
  };
  if (fresh) return apply(true);
  openModal("استرجاع نسخة احتياطية", `<p>النسخة بتاريخ <b>${fmtDT(o.exportedAt)}</b> وفيها ${nf(n, 0)} سجل.</p><p class="small muted">«استبدال» يمسح البيانات الحالية ويضع بيانات النسخة مكانها. «دمج» يضيف سجلات النسخة للبيانات الحالية.</p>`,
    { noFocus: true, extra: `<button type="button" class="btn danger" id="imp-replace">استبدال كل البيانات</button><button type="button" class="btn" id="imp-merge">دمج</button>` });
  $("#imp-replace").onclick = () => apply(true); $("#imp-merge").onclick = () => apply(false);
}
function resetAll() {
  openModal("مسح كل البيانات", `<p>هيتم مسح كل الأصناف والأوردرات والمصروفات والعملاء والسجل من هذا الموبايل نهائياً.</p><p class="small muted">لو محتاج البيانات دي بعدين، اعمل نسخة احتياطية الأول.</p><div class="form">${field("للتأكيد اكتب: مسح", `<input type="text" name="confirm" id="f-confirm" autocomplete="off">`, "full")}</div>`, {
    danger: true, submitLabel: "مسح نهائي", noFocus: true,
    onSubmit: async fd => {
      if (fv(fd, "confirm") !== "مسح") return "اكتب كلمة «مسح» للتأكيد.";
      await Local.snapshot("قبل مسح كل البيانات");
      COLS.forEach(c => { S[c] = new Map(); Local.mark(c); }); ver++; await Local.flush();
      route = "dashboard"; lsSet("petshome:lastBy", null);
    }
  });
}

/* ================== Install prompt ================== */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; scheduleRender(); });
window.addEventListener("appinstalled", () => { installPrompt = null; toast("تم تثبيت التطبيق"); scheduleRender(); });

/* ================== Event delegation ================== */
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if (g) { e.preventDefault(); go(g.dataset.go); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = b.dataset.id; const act = b.dataset.act;
  const H = {
    "backup": backupSheet, "reset": resetAll,
    "install": () => { if (installPrompt) { installPrompt.prompt(); installPrompt.userChoice.finally(() => { installPrompt = null; scheduleRender(); }); } },
    "quick": showQuick, "more": showMore,
    "new-production": () => moveForm("production"), "new-opening": () => moveForm("opening"), "new-withdraw": () => moveForm("withdraw"),
    "edit-move": () => { const m = S.moves.get(id); if (m) moveForm(m.type, m); },
    "del-move": () => { const m = S.moves.get(id); if (!m) return; confirmBox("حذف حركة مخزون", `حذف ${KIND[m.type]} ${nf(m.plates)} طبق ${esc(itemName(m.itemId))} بتاريخ ${fmtDate(m.date)}؟ سيتعدل الرصيد فوراً، ويبقى الحذف مسجلاً في سجل العمليات.`, "حذف", () => { Store.remove("moves", id); audit("حذف", "move", id, `حذف ${KIND[m.type]}: ${nf(m.plates)} طبق ${itemName(m.itemId)} بتاريخ ${fmtDate(m.date)} (سجّلها ${wName(m.by)})`); }); },
    "new-order": () => orderForm(), "edit-order": () => { const o = S.orders.get(id); if (o) orderForm(o); },
    "invoice": () => showInvoice(id),
    "deliver": () => { const o = S.orders.get(id); if (!o) return; const next = Object.assign({}, o, { status: "delivered" }); Store.put("orders", id, next); audit("تعديل", "order", id, `تسليم أوردر ${o.no} — ${custName(o.customerId)}`, o, next); toast("تم تسجيل التسليم"); },
    "cancel-order": () => { const o = S.orders.get(id); if (!o) return; confirmBox("إلغاء أوردر", `إلغاء أوردر ${esc(o.no)} للعميل ${esc(custName(o.customerId))}؟ ستعود أطباقه لرصيد الغرفة ويُلغى من حساب العميل.`, "إلغاء الأوردر", () => { const next = Object.assign({}, o, { status: "cancelled" }); Store.put("orders", id, next); audit("إلغاء", "order", id, `إلغاء أوردر ${o.no} — ${custName(o.customerId)} بإجمالي ${money(o.total)}`, o, next); }); },
    "new-payment": () => paymentForm(),
    "pay-order": () => { const o = S.orders.get(id); if (o) paymentForm({ customerId: o.customerId, orderId: o.id, amount: r2(o.total - orderPaid(o)) }); },
    "pay-cust": () => paymentForm({ customerId: id, amount: custBalances().get(id)?.due }),
    "edit-pay": () => { const p = S.payments.get(id); if (p) paymentForm({}, p); },
    "del-pay": () => { const p = S.payments.get(id); if (!p) return; confirmBox("حذف تحصيل", `حذف تحصيل ${money(p.amount)} من ${esc(custName(p.customerId))} بتاريخ ${fmtDate(p.date)}؟ سيرجع المبلغ على حساب العميل.`, "حذف", () => { Store.remove("payments", id); audit("حذف", "payment", id, `حذف تحصيل ${money(p.amount)} من ${custName(p.customerId)} بتاريخ ${fmtDate(p.date)} (سجّله ${wName(p.by)})`); }); },
    "new-customer": () => customerForm(), "edit-customer": () => { const c = S.customers.get(id); if (c) customerForm(c); },
    "statement": () => { openModal(`كشف حساب ${custName(id)}`, statementHtml(id, "", ""), { wide: true, noFocus: true, extra: `<button type="button" class="btn primary" id="st-share">${navigator.share ? "مشاركة الكشف" : "نسخ الكشف"}</button>` }); labelTables($("#modal-root")); $("#st-share").onclick = () => shareOrCopy("كشف حساب", statementText(id, "", ""), "تم نسخ كشف الحساب"); },
    "new-expense": () => financeForm("expense"), "new-income": () => financeForm("income"),
    "edit-fin": () => { const x = S.finance.get(id); if (x) financeForm(x.kind || "expense", x); },
    "del-fin": () => { const x = S.finance.get(id); if (!x) return; confirmBox("حذف", `حذف ${x.kind === "income" ? "إيراد" : "مصروف"} ${esc(x.category)} بمبلغ ${money(x.amount)}؟`, "حذف", () => { Store.remove("finance", id); audit("حذف", "finance", id, `حذف ${x.kind === "income" ? "إيراد" : "مصروف"} ${x.category} ${money(x.amount)} بتاريخ ${fmtDate(x.date)} (سجّله ${wName(x.by)})`); }); },
    "save-count": saveCount, "clear-count": () => { Object.keys(countDraft).forEach(k => delete countDraft[k]); render(); },
    "new-item": () => itemForm(), "edit-item": () => { const i = S.items.get(id); if (i) itemForm(i); },
    "new-worker": () => workerForm(), "edit-worker": () => { const w = S.workers.get(id); if (w) workerForm(w); },
    "month-report": () => { rp.tab = "monthly"; rp.month = id; go("reports"); },
    "worker-log": () => { lg.worker = id; lg.from = addDays(today(), -29); lg.to = today(); go("log"); },
    "export": backupSheet
  };
  if (H[act]) { e.preventDefault(); H[act](); }
});

/* ================== Boot ================== */
/* Data migrations: each upgrades saved data from schema (to - 1) to `to` without losing anything.
   Example: { to: 2, run: () => { S.items.forEach((v, id) => { if (v.newField == null) Store.put("items", id, Object.assign({}, v, { newField: 0 })); }); } } */
const MIGRATIONS = [];
async function boot() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch {}
  let r;
  try { r = await Local.init(); } catch (e) { console.error(e); r = { ok: false, data: {} }; }
  if (!r.ok) { phase = "readfail"; render(); return; }
  COLS.forEach(c => S[c] = toMap(r.data[c]));
  ver++;
  Local.canWrite = true;
  const marker = await Local.getKey("__meta");
  Local.snapInfo = await Local.getKey("__snapshot_info");
  const hasData = S.meta.size > 0 || recordCount() > 0;
  if (hasData && (!marker || marker.appVersion !== APP_VERSION)) {
    await Local.snapshot(`قبل التحديث إلى ${APP_VERSION}`, marker ? marker.appVersion : "local-1");
  }
  const from = marker && marker.schema ? marker.schema : 1;
  MIGRATIONS.filter(m => m.to > from && m.to <= SCHEMA).sort((a, b) => a.to - b.to).forEach(m => m.run());
  await Local.flush();
  await Local.putKey("__meta", { schema: SCHEMA, appVersion: APP_VERSION, updatedAt: nowISO() });
  phase = "ready"; render();
}
window.PH = { version: APP_VERSION, _debug: { S, Store, Local, go, me, balance, custBalances, orderPayState, moneySummary, allAudit, setPreset, rp, render, saveCount, countDraft, moveForm, orderForm, paymentForm, financeForm, workerForm, closeModal, stockSummary, seedDemo, backupData, importBackup, lastBy, monthReport, dataMonths, monthText } };
boot();
})();
