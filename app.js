/* Pets Home — farm management app.
   Local mode: all data on the phone (IndexedDB). Cloud mode (firebase-config.js filled): sign-in with the farm account,
   data in Firestore with an offline copy, synced between devices.
   Stock by plates, production, orders, invoices, customers, expenses, payroll, counts, reports, audit log. */
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
const cur = () => "ج.م";   // always Egyptian pounds
const sgn = t => "\u2066" + t + "\u2069";   // isolate a signed number so the sign stays on its left in Arabic text
const money = n => `${+n < 0 ? sgn("-" + nf(-n, 2)) : nf(n, 2)} ${cur()}`;
const fmtDate = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };
const fmtTime = iso => { if (!iso) return ""; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDT = iso => { if (!iso) return ""; const d = new Date(iso); return `${fmtDate(ymd(d))} ${fmtTime(iso)}`; };
const localDay = iso => ymd(new Date(iso));
const DAYS = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
const dayName = s => DAYS[new Date(s + "T12:00:00").getDay()];
const pnum = v => { const x = parseFloat(String(v ?? "").trim().replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace("٫", ".").replace(",", ".")); return isFinite(x) ? x : NaN; };
const nowISO = () => new Date().toISOString();

/* ================== State & on-device storage ================== */
const APP_VERSION = "v4";
/* Storage format version. Raise it only together with a migration in MIGRATIONS below — never by changing or dropping saved data. */
const SCHEMA = 1;
const PLAIN = ["meta", "items", "workers", "customers", "suppliers"];
const BUCKETED = ["moves", "orders", "payments", "finance", "counts", "payroll"];
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
    if (MODE === "cloud" || !Array.isArray(cols) || !cols.length) return;
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

/* ================== Cloud (Firebase) ==================
   Used when firebase-config.js holds real settings. Firestore keeps its own offline copy on the phone,
   so the app keeps working without internet and uploads when the connection returns.
   Layout: meta/items/workers/customers → one document per record; moves/orders/payments/finance/counts/payroll →
   ledger/<type>_<YYYY-MM> documents with each record under r.<id>; audit/<YYYY-MM-DD> → { date, entries[] }. */
let MODE = "local";
let B = null;               // cloud backend (backend.js)
let authUser;               // undefined = not known yet, null = signed out
let cloudBooted = false;
let localPending = null;    // records saved on this phone before cloud mode, waiting to be uploaded
const AUDIT_WINDOW = 60;
const recBucket = {};
const cloudConfigured = () => { const c = window.PETSHOME_FIREBASE; return !!(c && c.apiKey && !String(c.apiKey).startsWith("PASTE")); };
function cloudFail(e) {
  console.error(e);
  toast(e && e.code === "permission-denied" ? "لم يُحفظ: الحساب ده ليس له صلاحية على بيانات المزرعة." : "تعذر الحفظ على السحابة. هيتحفظ تلقائياً لما النت يرجع.");
}
const Cloud = {
  started: false, ready: new Set(), timedOut: false, unsubs: [], timer: null, error: null,
  start() {
    if (this.started) return; this.started = true; this.ready.clear(); this.timedOut = false; this.error = null;
    this.timer = setTimeout(() => { this.timedOut = true; scheduleRender(); }, 12000);
    /* An employee only listens to what their login may read (see firestore.rules); the manager listens to everything. */
    const worker = isWorker(), sales = can("orders") || can("payments");
    const plain = worker ? ["meta", "items", ...(sales ? ["customers"] : []), ...(can("finance") ? ["suppliers"] : [])] : PLAIN;
    const types = worker ? ["moves", "orders", "counts", ...(sales ? ["payments"] : []), ...(can("finance") ? ["finance"] : [])] : BUCKETED;
    const wantAudit = !worker || can("log");
    this.expected = plain.length + types.length + (wantAudit ? 1 : 0) + (worker ? 0 : 1);
    const fail = name => err => { console.error(name, err); if (err && err.code === "permission-denied" && (!worker || name === "meta")) this.error = "denied"; this.ready.add(name); scheduleRender(); };
    const done = name => { this.ready.add(name); if (this.isReady()) clearTimeout(this.timer); ver++; scheduleRender(); };
    plain.forEach(col => this.unsubs.push(B.watch(col, docs => {
      S[col] = new Map(docs.map(d => [d.id, Object.assign({}, d.data, { id: d.id })])); done(col);
    }, fail(col))));
    types.forEach(t => this.unsubs.push(B.watch("ledger", docs => {
      const m = new Map();
      docs.forEach(d => Object.entries(d.data.r || {}).forEach(([id, rec]) => { if (rec) { m.set(id, Object.assign({}, rec, { id })); recBucket[id] = d.id; } }));
      S[t] = m; done("ledger:" + t);
    }, fail("ledger:" + t), { type: t })));
    if (wantAudit) this.unsubs.push(B.watch("audit", docs => {
      S.audit = new Map(docs.map(d => [d.id, Object.assign({}, d.data, { id: d.id })])); done("audit");
    }, fail("audit"), { since: addDays(today(), -(AUDIT_WINDOW - 1)) }));
    if (!worker) this.unsubs.push(B.watch("accounts", docs => { ACCOUNTS = new Map(docs.map(d => [d.id, d.data])); done("accounts"); }, fail("accounts")));
  },
  stop() {
    this.unsubs.forEach(u => { try { u(); } catch {} }); this.unsubs = []; this.started = false; this.ready.clear(); clearTimeout(this.timer);
    COLS.forEach(c => S[c] = new Map()); ver++;
  },
  isReady() { return this.timedOut || this.ready.size >= (this.expected || 99); },
  ops(col, id, clean, del) {
    if (BUCKETED.includes(col)) {
      const old = recBucket[id];
      if (del) { delete recBucket[id]; return old ? [{ kind: "unbucket", bid: old, id }] : []; }
      const month = String(clean.date || today()).slice(0, 7), bid = `${col}_${month}`;
      const out = [{ kind: "bucket", bid, meta: { type: col, month }, id, data: clean }];
      if (old && old !== bid) out.push({ kind: "unbucket", bid: old, id });
      recBucket[id] = bid; return out;
    }
    return del ? [{ kind: "del", col, id }] : [{ kind: "set", col, id, data: clean }];
  }
};

/* One way to save, whichever mode: the screen updates at once, then the change is written to the phone or the cloud. */
const Store = {
  newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
  put(col, id, data) { return this.bulk([{ op: "put", col, id, data }]); },
  remove(col, id) { return this.bulk([{ op: "del", col, id }]); },
  bulk(list) {
    const maps = {}, M = c => maps[c] || (maps[c] = new Map(S[c])), cloudOps = [];
    for (const o of list) {
      if (o.op === "put") {
        const clean = JSON.parse(JSON.stringify(o.data)); delete clean.id;
        M(o.col).set(o.id, Object.assign({}, clean, { id: o.id }));
        if (MODE === "cloud") cloudOps.push(...Cloud.ops(o.col, o.id, clean, false));
      } else {
        M(o.col).delete(o.id);
        if (MODE === "cloud") cloudOps.push(...Cloud.ops(o.col, o.id, null, true));
      }
    }
    Object.keys(maps).forEach(c => { S[c] = maps[c]; if (MODE !== "cloud") Local.mark(c); });
    ver++;
    if (MODE === "cloud" && cloudOps.length) B.batchWrite(cloudOps).catch(cloudFail);
    if (maps.workers) setTimeout(syncPeople, 0);
    scheduleRender();
    return Promise.resolve();
  }
};

/* ================== Domain helpers ================== */
const settings = () => S.meta.get("settings") || { farmName: "Pets Home" };
const items = (all = false) => [...S.items.values()].filter(i => all || i.active !== false).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
const item = id => S.items.get(id);
const itemName = id => item(id)?.name || "صنف محذوف";
const unitOf = id => item(id)?.unit || "";
const workers = (all = false) => [...S.workers.values()].filter(w => all || w.active !== false).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
const ownerName = () => settings().ownerName || "المدير";
const peopleName = id => { const p = S.meta.get("people"); return (p && p.names && id && p.names[id]) || ""; };
const wName = id => !id || id === OWNER_ID ? ownerName() : (S.workers.get(id)?.name || peopleName(id) || "—");
const customers = () => [...S.customers.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
const custName = id => S.customers.get(id)?.name || "عميل نقدي";
/* Who is using the app: the manager (local mode, or the Hegazy account) or an employee login (cloud). */
const ADMIN_EMAIL = "hegazy@petshome.local";
let acct;                    // employee login's account document: undefined = loading, null = none
let acctUnsub = null;
let ACCOUNTS = new Map();    // manager only: every employee login (accounts/<uid>)
const isWorker = () => MODE === "cloud" && !!authUser && authUser.email !== ADMIN_EMAIL;
const isMgr = () => !isWorker();
const me = () => isWorker()
  ? { id: (acct && acct.workerId) || authUser.uid, name: (acct && acct.name) || peopleName(acct && acct.workerId) || accountName(), role: "worker" }
  : { id: OWNER_ID, name: ownerName(), role: "manager" };
const PERMS = [["production", "تسجيل الإنتاج"], ["withdraw", "السحب من الغرفة (تالف، استخدام…)"], ["orders", "الأوردرات والعملاء"], ["payments", "التحصيل من العملاء"], ["count", "الجرد"], ["finance", "المصروفات والموردين"], ["log", "يشوف سجل كل اللي اتعمل"]];
const can = p => !isWorker() || !!(acct && acct.active === true && acct.perms && acct.perms[p]);
/* "Responsible worker": an optional name picked on each entry (no worker logins in the local edition). */
let pendingBy = null;
const lastBy = () => { const v = lsGet("petshome:lastBy"); return v && (v === OWNER_ID || (S.workers.has(v) && S.workers.get(v).active !== false)) ? v : OWNER_ID; };
function byField(sel) {
  if (!isMgr() || !workers().length) return "";
  const cur = sel || lastBy();
  return field("العامل المسؤول", `<select name="by" id="f-by">${opt(OWNER_ID, ownerName(), cur)}${workers(true).filter(w => w.active !== false || w.id === cur).map(w => opt(w.id, w.name, cur)).join("")}</select>`);
}
function byVal(fd) { if (!isMgr()) { pendingBy = me().id; return me().id; } const v = (fd.get("by") || "").toString() || lastBy(); lsSet("petshome:lastBy", v); pendingBy = v; return v; }

const EXP_CATS = ["خامات","أكل","أدوات","نقل","صيانة","أجور","كهرباء ومياه","إيجار","أخرى"];
const INC_CATS = ["بيع خارج الأوردرات","تحصيل آخر","أخرى"];
const WD_REASONS = ["استخدام داخلي","تالف","نافق","عينات","هدية","أخرى"];
const UNITS = ["كجم","جرام","عدد","لتر"];
const KIND = { opening: "رصيد البداية", production: "إنتاج", sale: "بيع", withdraw: "سحب من الغرفة", adjust: "تصحيح بعد الجرد" };

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
const PAY_LABEL = { paid: ["خالص", "good"], partial: ["دفع جزء", "warn"], credit: ["لسه ما دفعش", "bad"] };
const ST_LABEL = { prepared: ["اتجهز", "plate"], delivered: ["اتسلم", "acc"], cancelled: ["ملغي", ""] };
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
    const r = { sales: 0, orders: 0, collectedAtOrder: 0, payments: 0, income: 0, incomeCash: 0, expense: 0, expenseCash: 0, expenseCredit: 0, payroll: 0, byCat: {} };
    for (const o of S.orders.values()) if (o.status !== "cancelled" && inRange(o.date, f, t)) { r.sales += +o.total || 0; r.orders++; r.collectedAtOrder += +o.paidNow || 0; }
    for (const p of S.payments.values()) if (inRange(p.date, f, t)) r.payments += +p.amount || 0;
    r.supplierPaid = 0;
    for (const x of S.finance.values()) if (inRange(x.date, f, t)) {
      const a = +x.amount || 0;
      if (x.kind === "supplierPay") { r.supplierPaid += a; continue; }
      if (x.kind === "income") { r.income += a; if (x.payType !== "credit") r.incomeCash += a; }
      else { r.expense += a; if (x.payType === "credit") r.expenseCredit += a; else r.expenseCash += a; r.byCat[x.category] = (r.byCat[x.category] || 0) + a; }
    }
    /* Payroll: cash advances and salary payments are expenses on the day the money leaves. */
    for (const p of S.payroll.values()) if ((p.type === "advance" || p.type === "payout") && inRange(p.date, f, t)) {
      const a = +p.amount || 0; r.expense += a; r.expenseCash += a; r.payroll += a; r.byCat["مرتبات"] = (r.byCat["مرتبات"] || 0) + a;
    }
    r.net = r2(r.sales + r.income - r.expense);
    return r;
  });
}

/* ================== Audit log ================== */
const FIELD_LABEL = { date: "التاريخ", itemId: "الصنف", plates: "الأطباق", qty: "الكمية", note: "ملاحظة", reason: "السبب", amount: "المبلغ", category: "البند", kind: "النوع", payType: "طريقة الدفع", customerId: "العميل", lines: "الأصناف", total: "الإجمالي", subtotal: "قبل الخصم", paidNow: "المدفوع", status: "الحالة", discount: "الخصم", name: "الاسم", price: "السعر", perPlate: "وزن/عدد الطبق", unit: "الوحدة", role: "الدور", perms: "الصلاحيات", active: "نشط", orderId: "الأوردر", method: "الطريقة", phone: "التليفون", minPlates: "حد التنبيه", priceBasis: "أساس السعر", farmName: "اسم المزرعة", currency: "العملة", by: "العامل المسؤول", ownerName: "اسم المدير", empId: "الموظف", type: "النوع", days: "الأيام", startMonth: "بداية المرتب" };
function fmtVal(k, v) {
  if (v == null || v === "") return "—";
  if (k === "itemId") return itemName(v);
  if (k === "by" || k === "empId") return wName(v);
  if (k === "type" && PAY_TYPES[v]) return PAY_TYPES[v].label;
  if (k === "customerId") return custName(v);
  if (k === "lines") return (v || []).map(l => `${itemName(l.itemId)} ${nf(l.plates)}ط`).join("، ");
  if (k === "status") return (ST_LABEL[v] || [v])[0];
  if (k === "perms") return PERMS.filter(([p]) => v[p]).map(([, l]) => l).join("، ") || "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function diff(a, b) {
  const out = []; const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => { if (["id","at","no","editedAt","editedBy","ownerUid","username","lastBackup","demo","createdAt","onboarded","src","salaryHistory","salary","endMonth","currency"].includes(k)) return; if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out.push({ f: k, from: fmtVal(k, a?.[k]), to: fmtVal(k, b?.[k]) }); });
  return out;
}
function audit(action, entity, entityId, summary, before, after) {
  const date = today(); const by = pendingBy || me().id; pendingBy = null;
  const e = { at: nowISO(), by, action, entity, entityId: entityId || "", summary };
  if (before && after) e.changes = diff(before, after);
  const cur = S.audit.get(date);
  const docv = { date, entries: (cur ? cur.entries || [] : []).concat([e]) };
  if (MODE === "cloud") {
    const m = new Map(S.audit); m.set(date, Object.assign({}, docv, { id: date })); S.audit = m; ver++; scheduleRender();
    B.appendAudit(date, { date }, e).catch(err => console.error("audit", err));
  } else Store.put("audit", date, docv);
}
const allAudit = () => memo("audit", () => { const out = []; for (const d of S.audit.values()) (d.entries || []).forEach(e => out.push(e)); return out.sort((a, b) => a.at < b.at ? 1 : -1); });

/* ================== UI plumbing ================== */
let route = "dashboard";
let renderPending = false, renderTimer = null;
function scheduleRender(now) { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = null; render(); }, now ? 0 : 40); }
document.addEventListener("focusout", () => { if (renderPending) { renderPending = false; setTimeout(render, 0); } });
let toastTimer;
function toast(msg, opts = {}) {
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.innerHTML = `<span>${esc(msg)}</span>${opts.undo ? `<button type="button" class="toast-btn" id="toast-undo">تراجع</button>` : ""}`;
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, opts.undo ? 7000 : 4000);
  if (opts.undo) $("#toast-undo").onclick = () => { t.hidden = true; clearTimeout(toastTimer); opts.undo(); };
}
/* Undo the last save: put back what was there before (or remove what was just added). */
function undoOf(what, col, id, before) {
  return () => {
    if (before) Store.put(col, id, before); else Store.remove(col, id);
    audit("تراجع", col, id, `تراجع عن: ${what}`); toast("تم التراجع");
  };
}
const saved = (msg, col, id, before) => ({ msg, undo: undoOf(msg, col, id, before) });
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
ICONS.payroll = '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/><circle cx="16.5" cy="15" r="1.5"/>';
ICONS.attendance = '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18M8 15l2.5 2.5L16 13"/>';
ICONS.suppliers = '<path d="M1 7h13v10H1zM14 10h4l4 4v3h-8z"/><circle cx="5.5" cy="18.5" r="1.5"/><circle cx="17.5" cy="18.5" r="1.5"/>';
ICONS.help = '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4"/><circle cx="12" cy="17.3" r=".6"/>';
ICONS.backup = '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>';
const icon = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;
const ROUTES = [
  { id: "dashboard", label: "الرئيسية", short: "الرئيسية", ok: () => true },
  { id: "stock", label: "المخزون في الغرفة", short: "المخزون", ok: () => true },
  { id: "production", label: "الإنتاج اليومي", short: "الإنتاج", ok: () => can("production") },
  { id: "orders", label: "الأوردرات والفواتير", short: "الأوردرات", ok: () => can("orders") || can("payments") },
  { id: "customers", label: "العملاء وحساباتهم", short: "العملاء", ok: () => can("orders") || can("payments") },
  { id: "payroll", label: "المرتبات", short: "المرتبات", ok: () => isMgr() },
  { id: "attendance", label: "حضور الموظفين", short: "الحضور", ok: () => isMgr() },
  { id: "finance", label: "المصروفات", short: "المصروفات", ok: () => can("finance") },
  { id: "suppliers", label: "الموردين وحساباتهم", short: "الموردين", ok: () => can("finance") },
  { id: "count", label: "الجرد (عدّ الغرفة)", short: "الجرد", ok: () => can("count") },
  { id: "reports", label: "التقارير والأرباح", short: "التقارير", ok: () => isMgr() },
  { id: "log", label: "سجل كل اللي اتعمل", short: "السجل", ok: () => can("log") },
  { id: "admin", label: "الإعدادات", short: "الإعدادات", ok: () => isMgr() },
  { id: "help", label: "إزاي أستخدم التطبيق", short: "مساعدة", ok: () => true }
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
      if (res && typeof res === "object" && res.msg) { closeModal(); toast(res.msg, res); return; }
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
  if (phase === "cloudfail") {
    app.innerHTML = `<div class="screen"><div class="card"><div class="logo">Pets Home</div><p>تعذر تحميل التطبيق. أول تشغيل بعد التحديث يحتاج اتصال بالإنترنت، وبعدها يشتغل بدونه.</p>
      <button type="button" class="btn primary block" onclick="location.reload()">إعادة المحاولة</button></div></div>`;
    return;
  }
  if (phase !== "ready") return screenMsg(app, "جاري فتح Pets Home…");
  if (MODE === "cloud") {
    if (authUser === undefined) return screenMsg(app, "جاري فتح Pets Home…");
    if (!authUser) return renderLogin(app);
    if (isWorker()) {
      if (acct === undefined) return screenMsg(app, "جاري التحقق من الحساب…");
      if (!acct || acct.active !== true) return renderDenied(app, true);
    }
    if (Cloud.error === "denied") return renderDenied(app);
    if (!Cloud.started) Cloud.start();
    if (!Cloud.isReady()) return screenMsg(app, "جاري تحميل بيانات المزرعة…");
    if (!cloudBooted) { cloudBooted = true; cloudAfterReady(); }
  }
  if (!S.meta.get("settings")) {
    if (isWorker()) { app.innerHTML = `<div class="screen"><div class="card"><div class="logo">Pets Home</div><p>المدير لسه ما جهزش التطبيق. جرّب تاني بعدين.</p><button type="button" class="btn block" data-act="logout">تسجيل الخروج</button></div></div>`; return; }
    return renderWelcome(app);
  }
  if (!routeOf(route)?.ok()) route = "dashboard";
  const s = settings(); const r = routeOf(route);
  const tabs = tabsShown();
  app.innerHTML = `<div class="shell">
    <aside class="rail">
      <div class="brand"><span class="name">${esc(s.farmName || "Pets Home")}</span><span class="sub">إدارة المزرعة والمخزون</span></div>
      <nav class="nav" aria-label="الأقسام">${ROUTES.filter(x => x.ok()).map(x => `<a href="#${x.id}" data-go="${x.id}" ${x.id === route ? 'aria-current="page"' : ""}>${icon(x.id)}${x.label}</a>`).join("")}</nav>
      <div class="who"><div><b>${esc(me().name)}</b> <span class="muted small">${MODE === "cloud" ? (navigator.onLine === false ? "غير متصل" : "متصل بالسحابة") : "البيانات على هذا الجهاز"}</span></div>
      <div class="actions">${MODE === "cloud" ? `<button class="btn sm" data-act="account">حسابي</button>` : ""}${isMgr() ? `<button class="btn sm" data-act="backup">نسخة احتياطية</button>` : ""}${installPrompt ? `<button class="btn sm" data-act="install">تثبيت التطبيق</button>` : ""}</div></div>
    </aside>
    <div class="col">
      <header class="appbar"><div class="in"><div class="ttl"><span class="farm">${esc(s.farmName || "Pets Home")}</span><span class="page">${esc(r.label)}</span></div>
      <button class="avatar" data-act="more" aria-label="القائمة">${esc((me().name || "P").trim().charAt(0) || "P")}</button></div></header>
      <main id="main">${MODE === "cloud" && navigator.onLine === false ? `<div class="banner">أنت غير متصل بالإنترنت. سجّل عادي، والتسجيلات هتترفع للسحابة تلقائياً لما النت يرجع.</div>` : ""}${s.demo ? `<div class="banner info">أنت تجرّب ببيانات تجريبية. لما تخلص، امسحها من «الإعدادات ← مسح كل البيانات» وابدأ ببياناتك.</div>` : ""}${VIEWS[route]()}</main>
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
function tabsShown() { return ["dashboard", "stock", "orders", "production", "finance", "customers", "count"].map(routeOf).filter(r => r.ok()).slice(0, 3); }
const tabBtn = r => `<button type="button" data-go="${r.id}" ${r.id === route ? 'aria-current="page"' : ""}>${icon(r.id)}<span>${esc(r.short)}</span></button>`;
function quickActions() {
  return [
    can("orders") && { id: "order", label: "أوردر جديد", ic: "orders", run: () => orderForm() },
    can("production") && { id: "production", label: "سجّل إنتاج", ic: "production", run: () => moveForm("production") },
    isMgr() && { id: "advance", label: "سلفة لموظف", ic: "payroll", run: () => payEntryForm("advance") },
    can("finance") && { id: "expense", label: "مصروف جديد", ic: "finance", run: () => financeForm("expense") },
    can("withdraw") && { id: "withdraw", label: "سحب من الغرفة", ic: "withdraw", run: () => moveForm("withdraw") },
    can("payments") && { id: "payment", label: "تحصيل من عميل", ic: "pay", run: () => paymentForm() },
    isMgr() && { id: "attendance", label: "حضور الموظفين", ic: "attendance", run: () => go("attendance") },
    isMgr() && { id: "adjust", label: "خصم أو مكافأة", ic: "payroll", run: () => payEntryForm("deduct") },
    isMgr() && { id: "payout", label: "صرف مرتب", ic: "pay", run: () => payEntryForm("payout") },
    can("finance") && { id: "supplier-pay", label: "سداد لمورد", ic: "suppliers", run: () => supplierPayForm() },
    can("count") && { id: "count", label: "جرد الغرفة", ic: "count", run: () => go("count") }
  ].filter(Boolean);
}
function showQuick() {
  if (!quickActions().length) return toast("حسابك مش مسموح له يسجل حاجة. كلّم المدير.");
  openModal("تسجيل جديد", `<div class="sheet-grid">${quickActions().map(a => `<button type="button" data-quick="${a.id}">${icon(a.ic)}${esc(a.label)}</button>`).join("")}</div>`, { noFooter: true, noFocus: true });
  $$("[data-quick]").forEach(b => b.onclick = () => { const a = quickActions().find(x => x.id === b.dataset.quick); if (a) a.run(); });
}
function showMore() {
  const tabs = tabsShown().map(r => r.id);
  const rest = ROUTES.filter(r => !tabs.includes(r.id));
  openModal("المزيد", `<div class="sheet-grid">${rest.map(r => `<button type="button" data-go="${r.id}">${icon(r.id)}${esc(r.label)}</button>`).join("")}
    ${isMgr() ? `<button type="button" data-act="backup">${icon("backup")}نسخة احتياطية</button>` : ""}
    ${MODE === "cloud" ? `<button type="button" data-act="account">${icon("user")}حسابي</button>` : ""}
    ${installPrompt ? `<button type="button" data-act="install">${icon("install")}تثبيت التطبيق</button>` : ""}</div>
    <div class="fsize"><span>حجم الكلام</span>${fontSizeSeg()}</div>`, { noFooter: true, noFocus: true });
}
function screenMsg(app, msg) { app.innerHTML = `<div class="screen"><div class="loading">${esc(msg)}</div></div>`; }

/* ---------- First run ---------- */
function renderWelcome(app) {
  const cloud = MODE === "cloud";
  app.innerHTML = `<div class="screen"><form class="card" id="welcome" novalidate>
    <div><div class="logo">Pets Home</div><p class="muted">${cloud ? "أول مرة على الحساب ده: اكتب بيانات المزرعة. أي جهاز هيدخل بنفس الحساب هيشوف نفس البيانات." : "نسخة تجريبية تعمل على هذا الموبايل فقط، بدون إنترنت وبدون حسابات. كل البيانات تُحفظ على الجهاز."}</p></div>
    ${cloud && localPending ? `<div class="banner info">على الموبايل ده ${nf(localPending.count, 0)} سجل محفوظين من قبل. ارفعهم للحساب عشان تكمل بنفس البيانات.</div><button class="btn primary block" type="button" data-act="upload-local">رفع بيانات الموبايل للحساب</button>${localPending.demo ? `<p class="small muted">الموبايل ده فيه بيانات تجريبية. لو مش عايزها على الحساب اضغط «ابدأ من غير بيانات الموبايل».</p>` : ""}` : ""}
    <div class="form">
      ${field("اسم المزرعة", `<input type="text" name="farm" id="w-farm" value="Pets Home">`, "full")}
      ${field("اسمك", `<input type="text" name="name" id="w-name" autocomplete="name">`, "full", "يظهر في سجل العمليات")}
    </div>
    <div class="err" id="w-err" hidden></div>
    <button class="btn ${cloud && localPending ? "" : "primary"} block" type="submit">${cloud && localPending ? "ابدأ من غير بيانات الموبايل" : "ابدأ"}</button>
    ${cloud ? "" : `<button class="btn block" type="button" id="w-demo">جرّب ببيانات تجريبية أولاً</button>`}
    <label class="linkbtn" style="text-align:center">عندي نسخة احتياطية، استرجعها<input type="file" id="w-restore" accept=".json,application/json" hidden></label>
    ${Local.snapInfo && Local.snapInfo.count ? `<button class="btn block" type="button" id="w-snap">استرجاع البيانات السابقة من النسخة التلقائية (${nf(Local.snapInfo.count, 0)} سجل)</button>` : ""}
    ${cloud ? `<button type="button" class="linkbtn" data-act="logout">تسجيل الخروج</button>` : ""}
  </form></div>`;
  const ws = $("#w-snap"); if (ws) ws.onclick = restoreSnapshot;
  $("#welcome").addEventListener("submit", e => {
    e.preventDefault(); const fd = new FormData(e.target); const name = fv(fd, "name");
    if (!name) { const er = $("#w-err"); er.textContent = "اكتب اسمك."; er.hidden = false; return; }
    document.activeElement && document.activeElement.blur();
    Store.put("meta", "settings", { farmName: fv(fd, "farm") || "Pets Home", ownerName: name, createdAt: nowISO() });
    audit("إضافة", "settings", "settings", `بدء استخدام التطبيق — ${name}`);
    Local.flush();
  });
  const wd = $("#w-demo"); if (wd) wd.onclick = seedDemo;
  $("#w-restore").onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => importBackup(rd.result, true); rd.readAsText(f); e.target.value = ""; };
}
/* Sample farm data so the app can be explored before entering real records. */
function seedDemo() {
  const t = today(), d = n => addDays(t, -n), at = (date, h) => new Date(`${date}T${pad(h)}:${pad(10 + (Object.keys(S).length % 40))}:00`).toISOString();
  Store.put("meta", "settings", { farmName: "Pets Home", ownerName: "المدير", createdAt: nowISO(), demo: true });
  const W = [Store.newId(), Store.newId()];
  const pm0 = prevMonth(today().slice(0, 7));
  Store.put("workers", W[0], { name: "محمود", phone: "", active: true, startMonth: pm0, salary: 4000, salaryHistory: [{ from: pm0, amount: 4000 }] });
  Store.put("workers", W[1], { name: "سعيد", phone: "", active: true, startMonth: pm0, salary: 3500, salaryHistory: [{ from: pm0, amount: 3500 }] });
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
  fin("expense", "خامات", 600, 4, "cash", "ردة"); fin("expense", "كهرباء ومياه", 300, 2, "cash", "فاتورة الكهرباء"); fin("expense", "نقل", 150, 0, "cash", "توصيل أوردر"); fin("expense", "أكل", 400, 1, "credit", "خضار للتغذية");
  const pe = (empId, type, amount, date, extra = {}) => Store.put("payroll", Store.newId(), Object.assign({ empId, type, amount, date, note: "", by: OWNER_ID, at: at(date, 17) }, extra));
  const pmEnd = monthRange(pm0).to;
  pe(W[0], "payout", 4000, pmEnd); pe(W[1], "payout", 3500, pmEnd);
  pe(W[0], "advance", 200, d(2), { note: "سلفة" }); pe(W[1], "absence", 116.67, d(3), { days: 1 }); pe(W[1], "bonus", 150, d(1), { note: "حافز إنتاج" });
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
  const t = today(), ss = stockSummary("", ""), ms = moneySummary(t, t);
  let plates = 0; items().forEach(i => plates += ss.get(i.id).closing);
  const hour = new Date().getHours(), name = (me().name || "").trim().split(" ")[0];
  const acts = quickActions().slice(0, 4);
  const prodToday = [...S.moves.values()].filter(m => m.type === "production" && m.date === t).reduce((a, m) => a + (+m.plates || 0), 0);
  const ordToday = [...S.orders.values()].filter(o => o.date === t && o.status !== "cancelled");
  const kpis = isMgr() ? `
    <div class="kpi plate"><span>الأطباق في الغرفة دلوقتي</span><b class="num">${nf(plates)}</b><small>${items().length} صنف · <a href="#stock" data-go="stock">التفاصيل</a></small></div>
    <div class="kpi"><span>مبيعات النهارده</span><b class="num">${money(ms.sales)}</b><small>${ms.orders} أوردر · اتحصّل ${money(r2(ms.collectedAtOrder + ms.payments))}</small></div>
    <div class="kpi"><span>مصروفات النهارده</span><b class="num">${money(ms.expense)}</b><small>${ms.payroll ? `منها مرتبات وسلف ${money(ms.payroll)}` : "كل اللي اتصرف النهارده"}</small></div>
    <div class="kpi hero"><span>مكسب النهارده</span><b class="num">${money(ms.net)}</b><small>المبيعات − المصروفات</small></div>` : `
    <div class="kpi plate"><span>الأطباق في الغرفة دلوقتي</span><b class="num">${nf(plates)}</b><small>${items().length} صنف</small></div>
    <div class="kpi"><span>إنتاج النهارده</span><b class="num">${nf(prodToday)} طبق</b><small>من كل العمال</small></div>
    <div class="kpi"><span>أوردرات النهارده</span><b class="num">${ordToday.length}</b><small>${nf(ordToday.reduce((a, o) => a + (o.lines || []).reduce((x, l) => x + (+l.plates || 0), 0), 0))} طبق خرج</small></div>
    <div class="kpi hero"><span>سجلت النهارده</span><b class="num">${myToday().length}</b><small>تسجيل باسمك</small></div>`;
  const recent = isMgr() ? allAudit().slice(0, 6) : [];
  return `<div class="hello"><h1>${hour < 12 ? "صباح الخير" : "مساء الخير"}${name ? ` يا ${esc(name)}` : ""}</h1><div class="sub">${dayName(t)} ${fmtDate(t)}</div></div>
  ${onboarding()}
  ${acts.length ? `<section class="bigacts" aria-label="تسجيل سريع">${acts.map(a => `<button type="button" class="bigact" data-qa="${a.id}">${icon(a.ic)}<span>${esc(a.label)}</span></button>`).join("")}</section>` : ""}
  <section class="kpis" aria-label="النهارده">${kpis}</section>
  ${attention(ss)}
  ${isMgr() ? monthPanel() : ""}
  <section class="panel"><div class="panel-head"><h2>رصيد الغرفة لكل صنف</h2><a href="#stock" data-go="stock" class="small">كل الحركة</a></div>
    <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">الأطباق</th><th class="n">الكمية</th><th>الحالة</th></tr></thead><tbody>
    ${items().length ? items().map(i => { const b = ss.get(i.id); const lowI = (+i.minPlates || 0) > 0 && b.closing <= +i.minPlates; return `<tr><td>${esc(i.name)}</td><td class="n">${nf(b.closing)}</td><td class="n">${qtyStr(b.closingQ, i.id)}</td><td>${b.closing < 0 ? pill(["بالسالب: راجع التسجيلات", "bad"]) : lowI ? pill(["قرب يخلص", "warn"]) : pill(["موجود", "good"])}</td></tr>`; }).join("") : emptyRow(4, isMgr() ? `لسه مفيش أصناف. ابدأ من قائمة «ابدأ من هنا» فوق.` : "المدير لسه ما ضافش أصناف.")}
    </tbody></table></div></section>
  ${isMgr() ? `<section class="panel"><div class="panel-head"><h2>آخر حاجات اتسجلت</h2>${can("log") ? `<a href="#log" data-go="log" class="small">السجل الكامل</a>` : ""}</div>
    ${recent.length ? `<div class="tbl-wrap"><table class="rtable no-title"><thead><tr><th>الوقت</th><th>اللي اتعمل</th><th>مين</th></tr></thead><tbody>${recent.map(e => `<tr><td class="nowrap small muted">${fmtDT(e.at)}</td><td class="span">${esc(e.summary)}</td><td class="small muted">${esc(wName(e.by))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">أي حاجة هتتسجل هتظهر هنا على طول.</div>`}</section>`
    : `<section class="panel"><h2>اللي سجلته النهارده</h2>${myToday().length ? `<ul class="todo">${myToday().map(x => `<li><span>${esc(x)}</span></li>`).join("")}</ul>` : `<div class="empty">لسه ما سجلتش حاجة النهارده.</div>`}</section>`}
  <div class="actions center"><button type="button" class="btn" data-act="day-summary">${icon("orders")} ملخص النهارده على واتساب</button></div>`;
};
/* Things registered today under this person's name (shown on an employee's home screen). */
function myToday() {
  const t = today(), id = me().id, out = [];
  for (const m of S.moves.values()) if (m.date === t && m.by === id) out.push(`${KIND[m.type] || m.type}: ${nf(m.plates)} طبق ${itemName(m.itemId)}`);
  for (const o of S.orders.values()) if (o.date === t && o.by === id && o.status !== "cancelled") out.push(`أوردر ${o.no} — ${custName(o.customerId)}`);
  for (const p of S.payments.values()) if (p.date === t && p.by === id) out.push(`تحصيل ${money(p.amount)} من ${custName(p.customerId)}`);
  for (const x of S.finance.values()) if (x.date === t && x.by === id) out.push(`${x.kind === "income" ? "إيراد" : x.kind === "supplierPay" ? "سداد مورد" : "مصروف"} ${money(x.amount)}`);
  return out;
}
/* "Start here": the four things that make the app useful, until they're done. */
function onboarding() {
  const s = settings(); if (!isMgr() || s.onboarded) return "";
  const steps = [
    { done: items(true).length > 0, t: "ضيف الأصناف اللي بتنتجها", d: "اسم الصنف، الطبق فيه كام كيلو أو عدد، وسعره", act: "new-item" },
    { done: [...S.moves.values()].some(m => m.type === "opening" || m.type === "production"), t: "سجّل الموجود في الغرفة دلوقتي", d: "عدد الأطباق من كل صنف، مرة واحدة في الأول", act: "new-opening" },
    { done: workers(true).some(onPayroll), t: "ضيف الموظفين ومرتباتهم", d: "عشان تسجل السلف والخصومات والمرتب يتحسب لوحده", act: "new-worker" },
    { done: S.orders.size > 0, t: "سجّل أول أوردر", d: "الأطباق هتتخصم من الغرفة والفاتورة هتطلع لوحدها", act: "new-order" }
  ];
  const n = steps.filter(x => x.done).length;
  if (n === steps.length) return "";
  return `<section class="panel onboard"><div class="panel-head"><h2>ابدأ من هنا</h2><span class="hint">${n} من ${steps.length} خلصوا</span></div>
    <ol class="steps">${steps.map((x, k) => `<li class="${x.done ? "done" : ""}"><span class="dot">${x.done ? "✓" : k + 1}</span><div><b>${x.t}</b><small>${x.d}</small></div>${x.done ? "" : `<button type="button" class="btn sm primary" data-act="${x.act}">ابدأ</button>`}</li>`).join("")}</ol>
    <button type="button" class="linkbtn small" data-act="hide-onboard">إخفاء القائمة دي</button></section>`;
}
/* "Needs your attention": the few things worth acting on today. */
function attention(ss) {
  if (!isMgr()) return "";
  const rows = [];
  const low = items().filter(i => (+i.minPlates || 0) > 0 && ss.get(i.id).closing <= +i.minPlates);
  if (low.length) rows.push(`<li><span>${icon("stock")} قرب يخلص: ${low.map(i => `${esc(i.name)} (${nf(ss.get(i.id).closing)} طبق)`).join("، ")}</span><button type="button" class="btn sm" data-act="new-production">سجّل إنتاج</button></li>`);
  const debtors = customers().map(c => ({ c, due: (custBalances().get(c.id) || {}).due || 0 })).filter(x => x.due > 0.005).sort((a, b) => b.due - a.due);
  if (debtors.length) rows.push(`<li><span>${icon("customers")} ${debtors.length} عميل عليهم ${money(r2(debtors.reduce((a, x) => a + x.due, 0)))}: ${debtors.slice(0, 3).map(x => `${esc(x.c.name)} ${nf(x.due)}`).join("، ")}${debtors.length > 3 ? "…" : ""}</span>${remindBtn(debtors[0].c, debtors[0].due, `فكّر ${esc(debtors[0].c.name.split(" ")[0])}`)}<button type="button" class="btn sm" data-go="customers">الكل</button></li>`);
  const owedSup = [...supplierBalances().values()].reduce((a, v) => a + Math.max(0, v), 0);
  if (owedSup > 0.005 && can("finance")) rows.push(`<li><span>${icon("suppliers")} عليك للموردين ${money(r2(owedSup))}</span><button type="button" class="btn sm" data-go="suppliers">الموردين</button></li>`);
  const pm = prevMonth(curMonth()), unpaidPrev = payrollMonth(pm).remaining;
  if (unpaidPrev > 0.005) rows.push(`<li><span>${icon("payroll")} مرتبات ${MONTHS[+pm.slice(5, 7) - 1]} لسه فيها ${money(unpaidPrev)} ما اتصرفتش</span><button type="button" class="btn sm" data-go="payroll">المرتبات</button></li>`);
  const extra = uploadBanner() + backupNag();
  if (!rows.length && !extra) return "";
  return `${extra}${rows.length ? `<section class="panel"><h2>محتاج انتباهك</h2><ul class="todo">${rows.join("")}</ul></section>` : ""}`;
}
/* Ready-made WhatsApp reminder for a customer who owes money. */
function waNumber(phone) {
  let d = String(phone || "").replace(/[^\d+]/g, ""); if (d.startsWith("+")) d = d.slice(1); if (d.startsWith("00")) d = d.slice(2);
  if (/^01\d{9}$/.test(d)) d = "2" + d;
  return /^\d{10,15}$/.test(d) ? d : "";
}
function reminderText(c, due) { return `السلام عليكم يا ${c.name}، بنفكّر حضرتك بالحساب المتبقي لـ${settings().farmName || "Pets Home"}: ${money(due)}. شكراً ليك.`; }
function remindBtn(c, due, label) {
  const n = waNumber(c.phone);
  return n ? `<a class="btn sm" href="https://wa.me/${n}?text=${encodeURIComponent(reminderText(c, due))}" target="_blank" rel="noopener">${label || "فكّره على واتساب"}</a>`
    : `<button type="button" class="btn sm" data-act="remind" data-id="${c.id}">${label || "رسالة تذكير"}</button>`;
}
/* End-of-day summary for WhatsApp. */
function daySummaryText(day) {
  const ms = moneySummary(day, day), ss = stockSummary("", ""), L = [];
  L.push(`${settings().farmName || "Pets Home"} — ملخص ${dayName(day)} ${fmtDate(day)}`, "—".repeat(14));
  const prod = {}; [...S.moves.values()].filter(m => m.type === "production" && m.date === day).forEach(m => prod[m.itemId] = (prod[m.itemId] || 0) + (+m.plates || 0));
  L.push(Object.keys(prod).length ? "الإنتاج: " + Object.entries(prod).map(([id, n]) => `${itemName(id)} ${nf(n)} طبق`).join("، ") : "الإنتاج: مفيش");
  const out = {}; [...S.orders.values()].filter(o => o.date === day && o.status !== "cancelled").forEach(o => (o.lines || []).forEach(l => out[l.itemId] = (out[l.itemId] || 0) + (+l.plates || 0)));
  L.push(`الأوردرات: ${ms.orders}${Object.keys(out).length ? " (" + Object.entries(out).map(([id, n]) => `${itemName(id)} ${nf(n)} طبق`).join("، ") + ")" : ""}`);
  const wd = [...S.moves.values()].filter(m => m.type === "withdraw" && m.date === day);
  if (wd.length) L.push("سحب من الغرفة: " + wd.map(m => `${itemName(m.itemId)} ${nf(m.plates)} (${m.reason || ""})`).join("، "));
  L.push(`المبيعات: ${money(ms.sales)} · اتحصّل: ${money(r2(ms.collectedAtOrder + ms.payments))}`, `المصروفات: ${money(ms.expense)}${ms.payroll ? ` (منها مرتبات وسلف ${money(ms.payroll)})` : ""}`, `مكسب النهارده: ${money(ms.net)}`);
  L.push("—".repeat(14), "الرصيد في الغرفة: " + (items().map(i => `${i.name} ${nf(ss.get(i.id).closing)}`).join("، ") || "—"));
  return L.join("\n");
}
function backupNag() {
  if (MODE === "cloud") return "";
  const s = settings(); if (s.demo || recordCount() < 3) return "";
  const last = s.lastBackup ? new Date(s.lastBackup) : null; const days = last ? Math.floor((Date.now() - last) / 864e5) : null;
  if (last && days < 7) return "";
  return `<div class="banner">${last ? `آخر نسخة احتياطية من ${days} يوم.` : "لم تعمل نسخة احتياطية بعد."} البيانات محفوظة على هذا الموبايل فقط. <button type="button" class="linkbtn" data-act="backup">اعمل نسخة الآن</button></div>`;
}
afterRender.dashboard = () => { $$("[data-qa]").forEach(b => b.onclick = () => quickActions().find(a => a.id === b.dataset.qa)?.run()); };

let stockItemFilter = "", stockRange = 30;
VIEWS.stock = () => {
  const ss = stockSummary("", "");
  const acts = [isMgr() && `<button class="btn" data-act="new-opening">الموجود في الغرفة دلوقتي</button>`, can("withdraw") && `<button class="btn primary" data-act="new-withdraw">سحب من الغرفة</button>`].filter(Boolean).join("");
  const from = stockRange ? addDays(today(), -stockRange + 1) : "";
  const rows = ledger().filter(e => (!stockItemFilter || e.itemId === stockItemFilter) && (!from || e.date >= from)).slice().reverse().slice(0, 300);
  return `${headHtml("المخزون في الغرفة", "الرصيد بيتحسب لوحده: اللي كان موجود + الإنتاج − البيع − السحب (± تصحيح الجرد).", acts)}
  <section class="panel"><div class="panel-head"><h2>رصيد كل صنف</h2><span class="hint">بالأطباق</span></div>
    <div class="stack">${items().length ? items().map(i => { const b = ss.get(i.id); return `<div class="logline"><b>${esc(i.name)} <span class="muted small">— الطبق = ${nf(i.perPlate)} ${esc(i.unit)}</span></b>
      <div class="equation"><span class="t">البداية ${nf(b.opening)}</span><span class="op">+</span><span class="t">إنتاج ${nf(b.production)}</span><span class="op">−</span><span class="t">بيع ${nf(b.sale)}</span><span class="op">−</span><span class="t">سحب ${nf(b.withdraw)}</span><span class="op">${b.adjust < 0 ? "−" : "+"}</span><span class="t">تصحيح جرد ${nf(Math.abs(b.adjust))}</span><span class="op">=</span><span class="res">${nf(b.closing)} طبق · ${qtyStr(b.closingQ, i.id)}</span></div></div>`; }).join("") : `<div class="empty">لا توجد أصناف بعد.</div>`}</div>
  </section>
  <section class="panel"><div class="panel-head"><h2>كل اللي دخل وخرج من الغرفة</h2></div>
    <div class="filters"><label>الصنف<select id="st-item"><option value="">كل الأصناف</option>${itemOptions(stockItemFilter)}</select></label>
    <label>الفترة<select id="st-range">${opt(7, "آخر 7 أيام", stockRange)}${opt(30, "آخر 30 يوم", stockRange)}${opt(90, "آخر 90 يوم", stockRange)}${opt(0, "كل الحركة", stockRange)}</select></label></div>
    <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th>النوع</th><th>التاريخ</th><th class="n">أطباق</th><th class="n">الكمية</th><th>البيان</th><th>بواسطة</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map(e => `<tr><td>${esc(itemName(e.itemId))}</td><td>${pill([KIND[e.kind], e.plates >= 0 ? "good" : "bad"])}</td><td class="nowrap">${fmtDate(e.date)} <span class="muted small">${fmtTime(e.at)}</span></td><td class="n ${e.plates < 0 ? "neg" : "pos"}">${sgn((e.plates > 0 ? "+" : "") + nf(e.plates))}</td><td class="n">${qtyStr(e.qty, e.itemId)}</td><td class="small">${esc(e.note) || "—"}</td><td class="small muted">${esc(wName(e.by))}</td><td class="nowrap">${e.src === "move" ? rowActions("move", e.id) : `<button class="btn sm" data-act="invoice" data-id="${e.id}">الفاتورة</button>`}</td></tr>`).join("") : emptyRow(8, "لا توجد حركة في هذه الفترة.")}
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
  return `${headHtml("الإنتاج اليومي", "كل طبق بتسجله هنا بيتضاف لرصيد الغرفة على طول.", `<button class="btn primary" data-act="new-production">+ تسجيل إنتاج</button>`)}
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
  const titles = { production: "تسجيل إنتاج", opening: "الموجود في الغرفة دلوقتي", withdraw: "سحب من الغرفة", adjust: "تصحيح بعد الجرد" };
  const intro = { production: "سجّل الأطباق اللي اتنتجت ودخلت الغرفة. هتتضاف للرصيد على طول.", opening: "اكتب عدد الأطباق الموجودة في الغرفة دلوقتي من الصنف ده. بتتعمل مرة واحدة في الأول لكل صنف.", withdraw: "لأي أطباق خرجت من الغرفة من غير بيع: تالف، نافق، استخدام داخلي، عينات…", adjust: "" }[type];
  const body = `${intro && !existing ? `<p class="intro">${intro}</p>` : ""}<div class="form">
    ${field("الصنف", `<select name="itemId" id="f-itemId" required>${itemOptions(m.itemId)}</select>`, "full")}
    ${field(type === "adjust" ? "عدد الأطباق (موجب زيادة / سالب عجز)" : "عدد الأطباق", numInput("plates", m.plates, "required"))}
    ${field("الكمية", numInput("qty", m.qty), "", `بالـ<span data-unit></span>. بتتحسب لوحدها من عدد الأطباق، وتقدر تغيّرها`)}
    ${field("التاريخ", dateInput("date", m.date))}
    ${byField(m.by)}
    ${type === "withdraw" ? field("سبب السحب", `<select name="reason" id="f-reason">${WD_REASONS.map(r => opt(r, r, m.reason)).join("")}</select>`) : ""}
    ${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(m.note || "")}">`, "full")}
    ${type === "withdraw" && !existing ? `<div class="f full small muted" id="wd-bal"></div>` : ""}</div>`;
  const form = openModal((existing ? "تعديل: " : "") + titles[type], body, {
    submitLabel: existing ? "حفظ التعديل" : "سجّل",
    onSubmit: async fd => {
      const plates = fnum(fd, "plates"); let qty = fnum(fd, "qty");
      if (!fv(fd, "itemId")) return "اختر الصنف.";
      if (!isFinite(plates) || (type !== "adjust" && plates <= 0)) return "اكتب عدد أطباق أكبر من صفر.";
      if (!isFinite(qty)) qty = r2(plates * (+item(fv(fd, "itemId")).perPlate || 0));
      const data = { type, itemId: fv(fd, "itemId"), plates: r2(plates), qty: r2(qty), date: fv(fd, "date") || today(), note: fv(fd, "note"), by: byVal(fd) };
      if (type === "withdraw") data.reason = fv(fd, "reason");
      const word = { production: "إنتاج", opening: "رصيد البداية", withdraw: "سحب من الغرفة", adjust: "تصحيح بعد الجرد" }[type];
      const sum = `${word}: ${nf(data.plates)} طبق ${itemName(data.itemId)} (${nf(data.qty)} ${unitOf(data.itemId)})${data.reason ? " — " + data.reason : ""}`;
      if (existing) {
        const next = Object.assign({}, existing, data, { editedAt: nowISO(), editedBy: me().id });
        await Store.put("moves", existing.id, next); audit("تعديل", "move", existing.id, "تعديل " + sum, existing, next);
        return saved(`اتعدل التسجيل. رصيد ${itemName(data.itemId)} بقى ${nf(balance(data.itemId).closing)} طبق`, "moves", existing.id, existing);
      } else {
        const id = Store.newId();
        await Store.put("moves", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "move", id, sum);
        const verb = { production: "اتسجل إنتاج", opening: "اتسجل الموجود:", withdraw: "اتسحب", adjust: "اتصحح" }[type];
        return saved(`${verb} ${nf(data.plates)} طبق ${itemName(data.itemId)}. الرصيد بقى ${nf(balance(data.itemId).closing)} طبق`, "moves", id, null);
      }
    }
  });
  wirePlates(form);
  const wb = $("#wd-bal"); if (wb) { const upd = () => { const id = form.querySelector("[name=itemId]").value; const b = balance(id); wb.textContent = `في الغرفة دلوقتي: ${nf(b.closing)} طبق (${nf(b.closingQ)} ${unitOf(id)})`; }; form.querySelector("[name=itemId]").addEventListener("change", upd); upd(); }
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
  const segs = [["open", "لسه شغالة"], ["due", "عليها فلوس"], ["prepared", "اتجهزت"], ["delivered", "اتسلمت"], ["cancelled", "ملغية"], ["all", "الكل"]];
  return `${headHtml("الأوردرات والفواتير", "سجّل كل أوردر خارج من المزرعة. الأطباق بتتخصم من الغرفة والفاتورة بتطلع لوحدها.", [can("orders") && `<button class="btn primary" data-act="new-order">+ أوردر جديد</button>`, can("payments") && `<button class="btn" data-act="new-payment">تحصيل</button>`].filter(Boolean).join(""))}
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
    ${field("الأوردر", `<select name="status" id="f-status">${opt("prepared", "اتجهز ولسه ما اتسلمش", o.status)}${opt("delivered", "اتسلم للعميل", o.status)}</select>`)}
    <div class="f full"><span class="small muted" style="font-weight:600">الأصناف</span><div class="lines" id="lines">${(o.lines || [{}]).map((l, i) => lineHtml(l, i)).join("")}</div><button type="button" class="btn sm" id="addline" style="align-self:flex-start">+ صنف آخر</button></div>
    ${field("خصم (لو في)", numInput("discount", o.discount || ""))}
    ${field("العميل دفع كام دلوقتي؟", numInput("paidNow", existing ? o.paidNow : ""), "", "سيبه فاضي لو هيدفع بعدين (آجل)")}
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
        toast(`اتسجل الأوردر بـ${money(total)}. الأطباق اتخصمت من الغرفة`, { undo: undoOf(`أوردر ${no}`, "orders", id, null) });
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
    submitLabel: existing ? "حفظ التعديل" : "سجّل التحصيل",
    onSubmit: async fd => {
      const amount = fnum(fd, "amount"); if (!isFinite(amount) || amount <= 0) return "اكتب مبلغاً أكبر من صفر.";
      const data = { customerId: fv(fd, "customerId"), orderId: fv(fd, "orderId"), amount: r2(amount), date: fv(fd, "date") || today(), method: fv(fd, "method"), note: fv(fd, "note"), by: byVal(fd) };
      if (data.orderId) { const o = S.orders.get(data.orderId); const rem = r2(o.total - orderPaid(o) + (existing?.orderId === o.id ? +existing.amount : 0)); if (amount > rem + 0.005) return `المتبقي على هذا الأوردر ${money(rem)} فقط. اختر «دفعة على الحساب» لتسجيل مبلغ أكبر.`; }
      const sum = `تحصيل ${money(data.amount)} من ${custName(data.customerId)}${data.orderId ? " على أوردر " + S.orders.get(data.orderId).no : ""} (${data.method})`;
      const left = () => { const d = custBalances().get(data.customerId); return d && d.due > 0.005 ? `باقي عليه ${money(d.due)}` : "حسابه بقى خالص"; };
      if (existing) { const next = Object.assign({}, existing, data, { editedAt: nowISO(), editedBy: me().id }); await Store.put("payments", existing.id, next); audit("تعديل", "payment", existing.id, "تعديل " + sum, existing, next); return saved(`اتعدل التحصيل. ${left()}`, "payments", existing.id, existing); }
      else { const id = Store.newId(); await Store.put("payments", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "payment", id, sum); return saved(`اتسجل تحصيل ${money(data.amount)} من ${custName(data.customerId)}. ${left()}`, "payments", id, null); }
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
  return `${headHtml("العملاء وحساباتهم", `فلوس لينا عند العملاء: <b class="money">${money(totalReceivable())}</b>`, [can("orders") && `<button class="btn primary" data-act="new-customer">+ عميل جديد</button>`, can("payments") && `<button class="btn" data-act="new-payment">تحصيل</button>`].filter(Boolean).join(""))}
  <section class="panel"><div class="filters"><label>بحث<input type="search" id="cu-q" placeholder="اسم أو تليفون" value="${esc(custSearch)}"></label></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>العميل</th><th>التليفون</th><th class="n">أوردرات</th><th class="n">المشتريات</th><th class="n">المدفوع</th><th class="n">عليه لسه</th><th></th></tr></thead><tbody>
  ${list.length ? list.map(c => { const r = cb.get(c.id) || { sales: 0, paid: 0, due: 0, count: 0 }; return `<tr><td><b>${esc(c.name)}</b>${c.note ? ` <span class="small muted">${esc(c.note)}</span>` : ""}</td><td class="nowrap" dir="ltr" style="text-align:start">${esc(c.phone || "—")}</td><td class="n">${r.count}</td><td class="n">${nf(r.sales)}</td><td class="n">${nf(r.paid)}</td><td class="n ${r.due > 0.005 ? "neg" : ""}"><b>${nf(r.due)}</b></td>
  <td class="nowrap"><button class="btn sm" data-act="statement" data-id="${c.id}">كشف حساب</button>${r.due > 0.005 && can("payments") ? ` <button class="btn sm" data-act="pay-cust" data-id="${c.id}">تحصيل</button>` : ""}${r.due > 0.005 ? ` ${remindBtn(c, r.due)}` : ""}${c.phone ? ` <a class="btn sm" href="tel:${esc(c.phone)}">اتصال</a>` : ""}${isMgr() || can("orders") ? ` <button class="btn sm" data-act="edit-customer" data-id="${c.id}">تعديل</button>` : ""}</td></tr>`; }).join("") : emptyRow(7, "لا يوجد عملاء بعد. يمكنك إضافة العميل من هنا أو أثناء تسجيل الأوردر.")}
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
  const list = [...S.finance.values(), ...payrollCashRows()].filter(x => (!from || x.date >= from) && (finKind === "all" || x.kind === finKind || (finKind === "credit" && x.payType === "credit"))).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (a.at < b.at ? 1 : -1));
  const ms = moneySummary(from, "");
  const cats = Object.entries(ms.byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...cats.map(c => c[1]));
  return `${headHtml("المصروفات", "كل فلوس بتتصرف على المزرعة، كاش أو آجل (لسه ما اتدفعتش). البيع للعملاء بيتسجل من الأوردرات.", `<button class="btn primary" data-act="new-expense">+ مصروف</button><button class="btn" data-act="new-income">+ إيراد آخر</button>`)}
  <div class="kpis"><div class="kpi"><span>مصروفات الفترة</span><b class="num">${money(ms.expense)}</b><small>منها آجل ${money(ms.expenseCredit)}</small></div><div class="kpi"><span>إيرادات أخرى</span><b class="num">${money(ms.income)}</b><small>غير المبيعات</small></div><div class="kpi"><span>مبيعات الفترة</span><b class="num">${money(ms.sales)}</b><small>${ms.orders} أوردر</small></div><div class="kpi hero"><span>المكسب</span><b class="num">${money(ms.net)}</b><small>المبيعات والإيرادات − المصروفات</small></div></div>
  <div class="grid-side">
  <section class="panel"><div class="seg" role="group" aria-label="النوع">${[["all", "الكل"], ["expense", "مصروفات"], ["income", "إيرادات"], ["credit", "آجل"]].map(([k, l]) => `<button type="button" data-fink="${k}" aria-pressed="${k === finKind}">${l}</button>`).join("")}</div>
  <div class="filters"><label>الفترة<select id="fi-days">${opt(1, "اليوم", finDays)}${opt(7, "آخر 7 أيام", finDays)}${opt(31, "آخر 31 يوم", finDays)}${opt(90, "آخر 90 يوم", finDays)}${opt(0, "الكل", finDays)}</select></label></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>البند</th><th class="n">المبلغ</th><th>التاريخ</th><th>الدفع</th><th>البيان</th><th>بواسطة</th><th></th></tr></thead><tbody>
  ${list.length ? list.map(x => `<tr><td>${x.kind === "supplierPay" ? `سداد لـ${esc(supplierName(x.supplierId))} ${pill(["سداد مورد", "acc"])}` : `${esc(x.category)} ${x.kind === "income" ? pill(["إيراد", "good"]) : ""}${x.supplierId ? ` <span class="small muted">${esc(supplierName(x.supplierId))}</span>` : ""}`}</td><td class="n ${x.kind === "income" ? "pos" : "neg"}">${sgn((x.kind === "income" ? "+" : "−") + nf(x.amount))}</td><td class="nowrap">${fmtDate(x.date)}</td><td>${x.payType === "credit" ? pill(["آجل", "warn"]) : "كاش"}</td><td class="small">${esc(x.note || "") || "—"}</td><td class="small muted">${esc(wName(x.by))}</td><td class="nowrap">${x._pe ? `<button class="btn sm" data-go="payroll">المرتبات</button>` : rowActions("fin", x.id)}</td></tr>`).join("") : emptyRow(7, "لا توجد مصروفات أو إيرادات في هذه الفترة.")}
  </tbody></table></div></section>
  <section class="panel"><h2>المصروفات حسب البند</h2>${cats.length ? cats.map(([c, v]) => `<div class="logline"><div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(c)}</span><b class="num">${nf(v)}</b></div><div class="bar"><i style="width:${(v / maxCat * 100).toFixed(1)}%"></i></div></div>`).join("") : `<div class="empty">لا مصروفات في الفترة.</div>`}</section></div>`;
};
afterRender.finance = () => { $$("[data-fink]").forEach(b => b.onclick = () => { finKind = b.dataset.fink; render(); }); $("#fi-days").onchange = e => { finDays = +e.target.value; e.target.blur(); render(); }; };
function financeForm(kind, existing) {
  setTimeout(() => { const ss = $("#f-supplierId"); if (ss) ss.onchange = () => { $("#newsup").hidden = ss.value !== "__new"; if (ss.value === "__new") $("#f-newSupplier").focus(); }; }, 0);
  const x = existing || {}; const cats = kind === "income" ? INC_CATS : EXP_CATS;
  openModal((existing ? "تعديل " : "") + (kind === "income" ? "إيراد آخر" : "مصروف"), `<div class="form">
    ${field("البند", `<select name="category" id="f-category">${cats.map(c => opt(c, c, x.category)).join("")}${x.category && !cats.includes(x.category) ? opt(x.category, x.category, x.category) : ""}</select>`)}
    ${field("المبلغ", numInput("amount", x.amount, "required"))}
    ${field("التاريخ", dateInput("date", x.date))}
    ${byField(x.by)}
    ${field("الدفع", `<select name="payType" id="f-payType">${opt("cash", "كاش (اتدفع دلوقتي)", x.payType)}${opt("credit", "آجل (لسه ما اتدفعش)", x.payType)}</select>`)}
    ${kind === "income" ? "" : field("المورد (اختياري)", `<select name="supplierId" id="f-supplierId">${opt("", "—", x.supplierId)}${suppliers().map(v => opt(v.id, v.name, x.supplierId)).join("")}${opt("__new", "+ مورد جديد…", "")}</select>`, "", "اختار المورد في الشراء الآجل عشان تعرف عليك كام لكل مورد")}
    <label class="f" id="newsup" hidden><span>اسم المورد الجديد</span><input type="text" name="newSupplier" id="f-newSupplier"></label>
    ${field("البيان", `<input type="text" name="note" id="f-note" value="${esc(x.note || "")}" placeholder="مثال: 3 شكاير ردة">`, "full")}</div>`, {
    onSubmit: async fd => {
      const amount = fnum(fd, "amount"); if (!isFinite(amount) || amount <= 0) return "اكتب مبلغاً أكبر من صفر.";
      const data = { kind, category: fv(fd, "category"), amount: r2(amount), date: fv(fd, "date") || today(), payType: fv(fd, "payType"), note: fv(fd, "note"), by: byVal(fd) };
      let sid = fv(fd, "supplierId");
      if (sid === "__new") { const nm = fv(fd, "newSupplier"); if (!nm) return "اكتب اسم المورد الجديد."; sid = Store.newId(); await Store.put("suppliers", sid, { name: nm, phone: "", note: "", at: nowISO() }); audit("إضافة", "supplier", sid, `إضافة مورد ${nm}`); }
      if (sid) data.supplierId = sid;
      const sum = `${kind === "income" ? "إيراد" : "مصروف"} ${data.category}: ${money(data.amount)}${data.payType === "credit" ? " (آجل)" : ""}${sid ? " — " + supplierName(sid) : ""}${data.note ? " — " + data.note : ""}`;
      const tail = data.payType === "credit" && sid ? `. عليك لـ${supplierName(sid)} ${money(supplierBalances().get(sid) || 0)}` : "";
      if (existing) { const next = Object.assign({}, existing, data, { editedAt: nowISO(), editedBy: me().id }); if (!sid) delete next.supplierId; await Store.put("finance", existing.id, next); audit("تعديل", "finance", existing.id, "تعديل " + sum, existing, next); return saved("اتعدل التسجيل" + tail, "finance", existing.id, existing); }
      else { const id = Store.newId(); await Store.put("finance", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "finance", id, sum); return saved(`اتسجل ${kind === "income" ? "إيراد" : "مصروف"} ${data.category} ${money(data.amount)}${tail}`, "finance", id, null); }
    }
  });
}

const countDraft = {};
VIEWS.count = () => {
  const ss = stockSummary("", "");
  const hist = [...S.counts.values()].sort((a, b) => a.at < b.at ? 1 : -1).slice(0, 20);
  const diffHtml = d => d == null || isNaN(d) ? "—" : d === 0 ? pill(["مطابق", "good"]) : d < 0 ? `<span class="neg">عجز ${nf(-d)}</span>` : `<span class="pos">زيادة ${nf(d)}</span>`;
  return `${headHtml("الجرد (عدّ الغرفة)", "عدّ الأطباق اللي في الغرفة فعلاً واكتب العدد. التطبيق هيقولك لو في نقص أو زيادة عن اللي متسجل.")}
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
      cashIn: r2(ms.collectedAtOrder + ms.payments + ms.incomeCash), cashOut: r2(ms.expenseCash + (ms.supplierPaid || 0)), done: to < today() };
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
    </div>${payrollMonth(cm).people ? `<p class="small muted">مرتبات ${MONTHS[+cm.slice(5, 7) - 1]} المتبقية للصرف: <b class="num">${money(payrollMonth(cm).remaining)}</b> · <a href="#payroll" data-go="payroll">المرتبات</a></p>` : ""}</section>`;
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
        <div class="big"><span>= ${R.net >= 0 ? "صافي الربح" : "صافي الخسارة"}</span><b class="num ${R.net >= 0 ? "pos" : "neg"}">${money(Math.abs(R.net))}</b></div>
        ${payrollMonth(R.ym).remaining > 0 ? `<div class="small"><span>مرتبات الشهر اللي لسه ما اتصرفتش</span><span class="num neg">${money(payrollMonth(R.ym).remaining)}</span></div>
        <div class="small"><span>الربح بعد صرفها</span><b class="num">${money(r2(R.net - payrollMonth(R.ym).remaining))}</b></div>` : ""}</div>
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
    const list = [...S.finance.values(), ...payrollCashRows()].filter(x => x.kind === "expense" && inRange(x.date, rp.from, rp.to)).sort((a, b) => a.date < b.date ? -1 : 1);
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
    for (const p of payrollCashRows()) rows.push({ date: p.date, at: p.at, desc: `مرتبات: ${p.note}`, inn: 0, out: +p.amount });
    for (const x of S.finance.values()) if (x.payType !== "credit") rows.push({ date: x.date, at: x.at, desc: x.kind === "supplierPay" ? `سداد لمورد: ${supplierName(x.supplierId)}${x.note ? " — " + x.note : ""}` : `${x.kind === "income" ? "إيراد" : "مصروف"} ${x.category}${x.note ? " — " + x.note : ""}`, inn: x.kind === "income" ? +x.amount : 0, out: x.kind === "income" ? 0 : +x.amount });
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
let logFetch = { key: "", docs: null, error: false };
function logEntries() {
  if (MODE !== "cloud" || lg.from >= addDays(today(), -(AUDIT_WINDOW - 1))) return allAudit();
  const key = lg.from + "|" + lg.to;
  if (logFetch.key !== key) {
    logFetch = { key, docs: null, error: false };
    B.queryAudit(lg.from, lg.to).then(docs => { if (logFetch.key === key) { logFetch.docs = docs.map(d => d.data); render(); } })
      .catch(() => { if (logFetch.key === key) { logFetch.error = true; render(); } });
  }
  if (!logFetch.docs) return null;
  const seen = new Set(), out = [];
  [...logFetch.docs, ...S.audit.values()].forEach(d => (d.entries || []).forEach(e => { const k = e.at + "|" + e.summary; if (!seen.has(k)) { seen.add(k); out.push(e); } }));
  return out.sort((a, b) => a.at < b.at ? 1 : -1);
}
VIEWS.log = () => {
  const all = logEntries();
  let list = (all || []).filter(e => { const d = localDay(e.at); return d >= lg.from && d <= lg.to; });
  if (lg.worker) list = list.filter(e => (e.by || OWNER_ID) === lg.worker);
  if (lg.q) list = list.filter(e => (e.summary || "").includes(lg.q));
  return `${headHtml("سجل كل اللي اتعمل", "كل تسجيل محفوظ بوقته واسم اللي عمله. لو حاجة اتعدلت، بتشوف القيمة القديمة والجديدة.")}
  <section class="panel"><div class="filters"><label>من<input type="date" id="lg-from" value="${lg.from}"></label><label>إلى<input type="date" id="lg-to" value="${lg.to}"></label>
  <label>العامل<select id="lg-w">${opt("", "الكل", lg.worker)}${opt(OWNER_ID, ownerName(), lg.worker)}${workers(true).map(w => opt(w.id, w.name, lg.worker)).join("")}</select></label>
  <label>بحث<input type="search" id="lg-q" placeholder="عميل، صنف، رقم أوردر" value="${esc(lg.q)}"></label></div>
  ${all === null ? `<div class="empty">${logFetch.error ? "تعذر تحميل السجل لهذه الفترة. تحقق من الاتصال." : "جاري تحميل السجل…"}</div>` : ""}
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
  return `${headHtml("الإعدادات", "الأصناف وأسعارها، الموظفين وحسابات دخولهم، وحجم الكلام.")}
  <section class="panel"><div class="panel-head"><h2>الأصناف</h2><button class="btn primary" data-act="new-item">+ صنف جديد</button></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الصنف</th><th class="n">الطبق =</th><th class="n">السعر</th><th class="n">تنبيه عند</th><th class="n">الرصيد</th><th>الحالة</th><th></th></tr></thead><tbody>
  ${items(true).length ? items(true).map(i => `<tr><td><b>${esc(i.name)}</b></td><td class="n">${nf(i.perPlate)} ${esc(i.unit)}</td><td class="n">${nf(i.price)} / ${i.priceBasis === "unit" ? esc(i.unit) : "طبق"}</td><td class="n">${+i.minPlates ? nf(i.minPlates) + " طبق" : "—"}</td><td class="n">${nf(ss.get(i.id)?.closing || 0)} طبق</td><td>${i.active === false ? pill(["موقوف"]) : pill(["نشط", "good"])}</td><td class="nowrap"><button class="btn sm" data-act="edit-item" data-id="${i.id}">تعديل</button></td></tr>`).join("") : emptyRow(7, "أضف أصناف المزرعة مع وزن أو عدد الطبق الواحد وسعره.")}
  </tbody></table></div><p class="small muted">بعد ما تضيف الصنف، سجّل الموجود منه في الغرفة من «المخزون ← الموجود في الغرفة دلوقتي».</p></section>
  <section class="panel"><div class="panel-head"><h2>الموظفين وحسابات الدخول</h2><button class="btn primary" data-act="new-worker">+ موظف</button></div>
  <p class="small muted">${MODE === "cloud" ? "اعمل لأي موظف «حساب دخول» عشان يسجل من موبايله. هيشوف بس اللي تسمح له بيه، ومش هيشوف المرتبات ولا الأرباح." : "حسابات دخول الموظفين بتشتغل لما السحابة تكون شغالة."} المرتبات والسلف من صفحة «المرتبات».</p>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الاسم</th><th>التليفون</th><th class="n">المرتب</th>${MODE === "cloud" ? "<th>حساب الدخول</th>" : ""}<th>الحالة</th><th></th></tr></thead><tbody>
  ${workers(true).length ? workers(true).map(w => `<tr><td><b>${esc(w.name)}</b></td><td dir="ltr" style="text-align:start">${esc(w.phone || "—")}</td><td class="n">${onPayroll(w) ? money(salaryFor(w, curMonth())) : "—"}</td>${MODE === "cloud" ? `<td>${accountCell(w)}</td>` : ""}<td>${w.active === false ? pill(["موقوف"]) : pill(["نشط", "good"])}</td><td class="nowrap">${MODE === "cloud" ? `<button class="btn sm ${w.accountUid ? "" : "primary"}" data-act="account-form" data-id="${w.id}">${w.accountUid ? "الحساب" : "اعمل حساب دخول"}</button> ` : ""}<button class="btn sm" data-act="edit-worker" data-id="${w.id}">تعديل</button> <button class="btn sm" data-act="worker-log" data-id="${w.id}">حركاته</button></td></tr>`).join("") : emptyRow(MODE === "cloud" ? 6 : 5, "لسه ما ضفتش موظفين.")}
  </tbody></table></div></section>
  <div class="grid2">
  <section class="panel"><h2>بيانات المزرعة</h2><form id="set-form" class="form">${field("اسم المزرعة", `<input type="text" name="farmName" id="set-farm" value="${esc(s.farmName || "")}">`)}${field("اسمك", `<input type="text" name="ownerName" id="set-owner" value="${esc(s.ownerName || "")}">`)}<div class="f full"><button class="btn primary" type="submit" style="align-self:flex-start">حفظ</button></div></form></section>
  <section class="panel"><h2>البيانات والنسخ الاحتياطي</h2><p class="small muted">${MODE === "cloud" ? `البيانات محفوظة على السحابة في حساب <b dir="ltr">${esc(accountName())}</b> ومتزامنة مع كل الأجهزة.` : "كل البيانات محفوظة على هذا الموبايل فقط."} آخر نسخة احتياطية: <b>${s.lastBackup ? fmtDT(s.lastBackup) : "لم تُعمل بعد"}</b></p>
  <div class="actions">${MODE === "cloud" ? `<button class="btn" data-act="account">حسابي</button>` : ""}<button class="btn primary" data-act="backup">نسخة احتياطية / استرجاع</button><button class="btn danger" data-act="reset">مسح كل البيانات</button></div></section></div>
  <section class="panel"><h2>حجم الكلام على الموبايل ده</h2>${fontSizeSeg()}</section>
  <p class="small muted">Pets Home — ${MODE === "cloud" ? "نسخة السحابة" : "نسخة محلية"} (${APP_VERSION})</p>`;
};
afterRender.admin = () => {
  $("#set-form").onsubmit = e => {
    e.preventDefault(); const fd = new FormData(e.target); const before = settings();
    const next = Object.assign({}, before, { farmName: fv(fd, "farmName") || "Pets Home", ownerName: fv(fd, "ownerName") || before.ownerName || "المدير" }); delete next.id;
    Store.put("meta", "settings", next); audit("تعديل", "settings", "settings", "تعديل بيانات المزرعة", before, next); document.activeElement?.blur(); toast("تم الحفظ");
  };
};
function itemForm(existing) {
  const i = existing || { unit: "كجم", priceBasis: "plate", active: true };
  openModal(existing ? `تعديل صنف ${i.name}` : "صنف جديد", `<div class="form">
    ${field("اسم الصنف", `<input type="text" name="name" id="f-name" value="${esc(i.name || "")}" required>`, "full")}
    ${field("وحدة القياس", `<select name="unit" id="f-unit">${UNITS.map(u => opt(u, u, i.unit)).join("")}</select>`)}
    ${field("الطبق الواحد فيه كام؟", numInput("perPlate", i.perPlate, "required"), "", "مثلاً 2 يعني الطبق = 2 كجم (بالوحدة اللي فوق)")}
    ${field("سعر البيع", numInput("price", i.price))}
    ${field("السعر محسوب على", `<select name="priceBasis" id="f-priceBasis">${opt("plate", "الطبق", i.priceBasis)}${opt("unit", "الكيلو / العدد", i.priceBasis)}</select>`)}
    ${field("نبّهني لما الرصيد يقل عن (طبق)", numInput("minPlates", i.minPlates), "", "اختياري. هيظهر لك تنبيه في الرئيسية")}
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
  const months = [prevMonth(prevMonth(curMonth())), prevMonth(curMonth()), curMonth(), nextMonth(curMonth())];
  const sal = existing && onPayroll(existing) ? salaryFor(existing, curMonth()) : null;
  openModal(existing ? `تعديل ${w.name}` : "موظف جديد", `<div class="form">
    ${field("الاسم", `<input type="text" name="name" id="f-name" value="${esc(w.name || "")}" required>`)}
    ${field("التليفون", `<input type="tel" name="phone" id="f-phone" dir="ltr" value="${esc(w.phone || "")}">`)}
    ${existing ? `<div class="f full"><span class="small muted" style="font-weight:600">المرتب الشهري</span><div class="actions" style="align-items:center"><b class="num">${sal != null ? money(sal) : "لم يُحدد"}</b><button type="button" class="btn sm" data-act="salary" data-id="${w.id}">${sal != null ? "زيادة / تغيير المرتب" : "تحديد المرتب"}</button></div></div>`
      : `${field("المرتب الشهري", numInput("salary", ""), "", "اتركه فاضي لو العامل مش على المرتبات")}
         ${field("المرتب يبدأ من شهر", `<select name="startMonth" id="f-startMonth">${months.map(m => opt(m, monthLabel(m), curMonth())).join("")}</select>`)}`}
    <label class="check f full"><input type="checkbox" name="active" id="f-active" ${w.active !== false ? "checked" : ""}> نشط (يظهر في القوائم ويستحق مرتب)</label></div>`, {
    done: "تم الحفظ",
    onSubmit: async fd => {
      const name = fv(fd, "name"); if (!name) return "اكتب اسم الموظف.";
      const data = { name, phone: fv(fd, "phone"), active: fd.get("active") === "on" };
      if (existing) {
        const next = Object.assign({}, existing, data);
        if (onPayroll(existing)) { if (!data.active && existing.active !== false && !existing.endMonth) next.endMonth = curMonth(); if (data.active) delete next.endMonth; }
        const a = existing.accountUid && ACCOUNTS.get(existing.accountUid);
        if (a && (a.name !== name || (!data.active && a.active))) { const na = Object.assign({}, a, { name, active: data.active ? a.active : false }); ACCOUNTS.set(existing.accountUid, na); B.batchWrite([{ kind: "set", col: "accounts", id: existing.accountUid, data: na }]).catch(cloudFail); }
        await Store.put("workers", existing.id, next); audit("تعديل", "worker", existing.id, `تعديل بيانات ${name}`, existing, next);
      } else {
        const salary = fnum(fd, "salary");
        if (fv(fd, "salary") && (!isFinite(salary) || salary < 0)) return "اكتب المرتب بالأرقام.";
        if (isFinite(salary) && salary > 0) { const from = fv(fd, "startMonth") || curMonth(); Object.assign(data, { salary: r2(salary), startMonth: from, salaryHistory: [{ from, amount: r2(salary), at: nowISO() }] }); }
        const id = Store.newId(); await Store.put("workers", id, Object.assign(data, { at: nowISO() }));
        audit("إضافة", "worker", id, `إضافة موظف ${name}${data.salary ? ` بمرتب ${money(data.salary)} من ${monthLabel(data.startMonth)}` : ""}`);
      }
    }
  });
}

/* ---------- Employee logins (cloud) ---------- */
function accountCell(w) {
  const a = w.accountUid && ACCOUNTS.get(w.accountUid);
  if (!a) return `<span class="muted small">—</span>`;
  return `<span dir="ltr">${esc(a.username)}</span> ${a.active ? pill(["شغال", "good"]) : pill(["موقوف"])}`;
}
function accountForm(empId) {
  const w = S.workers.get(empId); if (!w) return;
  if (MODE !== "cloud") return toast("حسابات دخول الموظفين بتشتغل مع السحابة بس.");
  const a = w.accountUid ? ACCOUNTS.get(w.accountUid) : null;
  const perms = (a && a.perms) || { production: true, withdraw: true, orders: true };
  openModal(a ? `حساب ${w.name}` : `حساب دخول لـ${w.name}`, `<p class="intro">${a ? "تقدر تغيّر هو يقدر يعمل إيه، أو توقف الحساب." : `اعمل لـ${esc(w.name)} اسم مستخدم وكلمة سر يدخل بيهم من موبايله. هيشوف بس الحاجات اللي هتعلّم عليها، ومش هيشوف المرتبات ولا الأرباح.`}</p>
    <div class="form">
      ${a ? `<div class="f full"><span class="small muted">اسم المستخدم</span><b dir="ltr">${esc(a.username)}</b></div>`
        : `${field("اسم المستخدم", `<input type="text" name="username" id="f-username" dir="ltr" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="mahmoud">`, "", "حروف إنجليزي صغيرة وأرقام")}
           ${field("كلمة السر", `<input type="text" name="password" id="f-password" dir="ltr" autocomplete="off">`, "", "6 حروف أو أرقام على الأقل")}`}
      <fieldset class="f full perms"><legend>يقدر يعمل إيه؟</legend>${PERMS.map(([k, l]) => `<label class="check"><input type="checkbox" name="p_${k}" id="f-p_${k}" ${perms[k] ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
      ${a ? `<label class="check f full"><input type="checkbox" name="active" id="f-active" ${a.active !== false ? "checked" : ""}> الحساب شغال (لو شلت العلامة مش هيقدر يدخل)</label>` : ""}
    </div>`, {
    submitLabel: a ? "حفظ" : "اعمل الحساب",
    onSubmit: async fd => {
      const pm = {}; PERMS.forEach(([k]) => { if (fd.get("p_" + k) === "on") pm[k] = true; });
      if (a) {
        const next = Object.assign({}, a, { perms: pm, active: fd.get("active") === "on", name: w.name });
        try { await B.batchWrite([{ kind: "set", col: "accounts", id: w.accountUid, data: next }]); } catch (ex) { return "تعذر الحفظ. اتأكد إن النت شغال."; }
        ACCOUNTS.set(w.accountUid, next); render();
        audit("تعديل", "account", w.accountUid, `تعديل حساب دخول ${w.name}${next.active ? "" : " (موقوف)"}`);
        return { msg: next.active ? `اتحفظت صلاحيات ${w.name}` : `حساب ${w.name} اتوقف` };
      }
      const username = fv(fd, "username").toLowerCase(), password = (fd.get("password") || "").toString();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return "اسم المستخدم: حروف إنجليزي صغيرة وأرقام (3 على الأقل).";
      if (password.length < 6) return "كلمة السر 6 حروف أو أرقام على الأقل.";
      if (navigator.onLine === false) return "عمل حساب جديد محتاج إنترنت.";
      let uid;
      try { uid = await B.createAccount(username, password); }
      catch (ex) {
        const c = ex && ex.code;
        if (c === "auth/email-already-in-use") return "اسم المستخدم ده موجود. اختار اسم تاني.";
        if (c === "auth/operation-not-allowed" || c === "auth/admin-restricted-operation") return "لازم يتفعّل «Enable create (sign-up)» في إعدادات Firebase الأول.";
        return authMsg(ex);
      }
      const acc = { workerId: w.id, name: w.name, username, perms: pm, active: true, at: nowISO() };
      try { await B.batchWrite([{ kind: "set", col: "accounts", id: uid, data: acc }]); } catch (ex) { return "اتعمل الحساب بس ما اتفعّلش. جرّب «اعمل حساب دخول» تاني باسم مستخدم مختلف."; }
      ACCOUNTS.set(uid, acc);
      await Store.put("workers", w.id, Object.assign({}, w, { accountUid: uid, username }));
      audit("إضافة", "account", uid, `عمل حساب دخول لـ${w.name} (${username})`);
      return () => { openModal("الحساب جاهز", `<p>ابعت لـ${esc(w.name)} البيانات دي. يفتح رابط التطبيق ويدخل بيها:</p><div class="sum-box" dir="ltr"><div><span>Username</span><b>${esc(username)}</b></div><div><span>Password</span><b>${esc(password)}</b></div></div><p class="small muted">لو نسي كلمة السر: أوقف الحساب ده واعمل له حساب جديد باسم مستخدم مختلف.</p>`,
        { noFocus: true, extra: `<button type="button" class="btn primary" id="cred-share">ابعتها واتساب</button>` }); $("#cred-share").onclick = () => shareOrCopy("Pets Home", `Pets Home\n${location.origin + location.pathname}\nUsername: ${username}\nPassword: ${password}`, "اتنسخت"); };
    }
  });
}

/* ================== Payroll ==================
   Each employee has a monthly salary (with its history, so raises apply from a chosen month).
   Through the month the manager records cash advances, deductions, absences and bonuses; the app works out
   what is still owed. Whatever is left over (or overdrawn) carries into the next month automatically.
   Cash advances and salary payments count as expenses ("مرتبات") on the day the money is paid. */
const PAY_TYPES = {
  advance: { label: "سلفة / سحب نقدي", short: "سلفة", sign: -1, cls: "warn", cash: true },
  deduct:  { label: "خصم / جزاء", short: "خصم", sign: -1, cls: "bad" },
  absence: { label: "غياب", short: "غياب", sign: -1, cls: "bad" },
  bonus:   { label: "مكافأة / حافز", short: "مكافأة", sign: 1, cls: "good" },
  payout:  { label: "صرف مرتب", short: "صرف", sign: -1, cls: "acc", cash: true }
};
const nextMonth = ym => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };
const salaryHist = w => !w ? [] : (Array.isArray(w.salaryHistory) && w.salaryHistory.length ? w.salaryHistory : (+w.salary ? [{ from: w.startMonth || curMonth(), amount: +w.salary }] : []));
const onPayroll = w => salaryHist(w).length > 0;
function salaryFor(w, ym) {
  const h = salaryHist(w).slice().sort((a, b) => a.from < b.from ? -1 : 1);
  if (!h.length || ym < h[0].from || (w.endMonth && ym > w.endMonth)) return 0;
  let amt = 0; h.forEach(x => { if (x.from <= ym) amt = +x.amount || 0; }); return amt;
}
const peMonth = p => String(p.date || "").slice(0, 7);
function payLedger(empId) {
  return memo("pl:" + empId, () => {
    const w = S.workers.get(empId);
    const entries = [...S.payroll.values()].filter(p => p.empId === empId).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || "") < (b.at || "") ? -1 : 1);
    const starts = salaryHist(w).map(x => x.from).concat(entries.map(peMonth)).filter(Boolean).sort();
    const start = starts[0] || curMonth(), end = [curMonth(), ...entries.map(peMonth)].sort().pop();
    const rows = new Map(); let carry = 0;
    for (let m = start, i = 0; m <= end && i < 600; m = nextMonth(m), i++) {
      const r = { ym: m, carry: r2(carry), base: salaryFor(w, m), advance: 0, deduct: 0, absence: 0, bonus: 0, payout: 0, entries: [] };
      entries.forEach(p => { if (peMonth(p) === m) { if (r[p.type] != null) r[p.type] += +p.amount || 0; r.entries.push(p); } });
      ["advance", "deduct", "absence", "bonus", "payout"].forEach(k => r[k] = r2(r[k]));
      r.earned = r2(r.base + r.bonus - r.deduct - r.absence);
      r.due = r2(r.carry + r.earned - r.advance - r.payout);
      rows.set(m, r); carry = r.due;
    }
    return rows;
  });
}
function payRow(empId, ym) {
  const L = payLedger(empId), r = L.get(ym); if (r) return r;
  const keys = [...L.keys()], last = keys.length && ym > keys[keys.length - 1] ? L.get(keys[keys.length - 1]).due : 0;
  return { ym, carry: last, base: 0, advance: 0, deduct: 0, absence: 0, bonus: 0, payout: 0, entries: [], earned: 0, due: last };
}
function payrollMonth(ym) {
  return memo("pm:" + ym, () => {
    const t = { base: 0, advance: 0, deduct: 0, absence: 0, bonus: 0, payout: 0, remaining: 0, over: 0, people: 0 };
    workers(true).forEach(w => {
      const r = payRow(w.id, ym); if (!r.base && !r.entries.length && !r.carry) return;
      t.people++; ["base", "advance", "deduct", "absence", "bonus", "payout"].forEach(k => t[k] += r[k]);
      if (r.due > 0) t.remaining += r.due; else t.over += -r.due;
    });
    Object.keys(t).forEach(k => t[k] = r2(t[k])); return t;
  });
}
const payrollCashRows = () => memo("pcr", () => [...S.payroll.values()].filter(p => PAY_TYPES[p.type] && PAY_TYPES[p.type].cash).map(p => ({
  id: "pe-" + p.id, _pe: true, kind: "expense", category: "مرتبات", amount: +p.amount || 0, date: p.date, at: p.at, payType: "cash",
  note: `${PAY_TYPES[p.type].short} — ${wName(p.empId)}${p.note ? " — " + p.note : ""}`, by: p.by })));
const dueLabel = d => d > 0.005 ? pill(["متبقي له", "warn"]) : d < -0.005 ? pill(["عليه (يتخصم)", "bad"]) : pill(["تم الصرف", "good"]);

let payMonth = curMonth();
VIEWS.payroll = () => {
  if (payMonth > curMonth()) payMonth = curMonth();
  const ym = payMonth, T = payrollMonth(ym);
  const emps = workers(true).filter(w => { const r = payRow(w.id, ym); return (onPayroll(w) && w.active !== false) || r.base || r.entries.length || Math.abs(r.due) > 0.005; });
  const noSalary = workers().filter(w => !onPayroll(w));
  const cell = (v, sign) => v ? sgn(sign + nf(v)) : "—";
  return `${headHtml("المرتبات", `شهر ${monthLabel(ym)}${ym === curMonth() ? " (الحالي)" : ""}`, `<button class="btn" data-go="attendance">الحضور</button><button class="btn primary" data-act="pe-new" data-id="advance">+ سلفة</button><button class="btn" data-act="pe-new" data-id="deduct">+ خصم / مكافأة</button><button class="btn" data-act="pe-new" data-id="payout">صرف مرتب</button>`)}
  <div class="monthnav"><button type="button" class="btn sm" data-act="pay-month" data-id="${prevMonth(ym)}">الشهر السابق</button><b>${monthLabel(ym)}</b>${ym < curMonth() ? `<button type="button" class="btn sm" data-act="pay-month" data-id="${nextMonth(ym)}">الشهر التالي</button>` : `<span class="btn sm" style="visibility:hidden">الشهر التالي</span>`}</div>
  <section class="kpis" aria-label="ملخص المرتبات">
    <div class="kpi hero"><span>المتبقي للصرف</span><b class="num">${money(T.remaining)}</b><small>تم صرف ${money(T.payout)}</small></div>
    <div class="kpi"><span>إجمالي المرتبات</span><b class="num">${money(T.base)}</b><small>${T.people} موظف</small></div>
    <div class="kpi"><span>سلف ومسحوبات</span><b class="num">${money(T.advance)}</b><small>تُخصم من المرتب</small></div>
    <div class="kpi"><span>خصومات وغياب</span><b class="num">${money(r2(T.deduct + T.absence))}</b><small>مكافآت ${sgn("+" + nf(T.bonus))}</small></div>
  </section>
  <section class="panel"><div class="panel-head"><h2>الموظفين</h2><button class="btn sm" data-act="new-worker">+ موظف</button></div>
  <div class="tbl-wrap"><table class="rtable"><thead><tr><th>الموظف</th><th class="n">المرتب</th><th class="n">باقي من الشهر اللي فات</th><th class="n">مكافآت</th><th class="n">خصومات وغياب</th><th class="n">سلف</th><th class="n">مصروف</th><th class="n">المتبقي</th><th></th></tr></thead><tbody>
  ${emps.length ? emps.map(w => { const r = payRow(w.id, ym); return `<tr><td><b>${esc(w.name)}</b>${w.active === false ? ` ${pill(["موقوف"])}` : ""}</td><td class="n">${nf(r.base)}</td><td class="n">${r.carry ? sgn((r.carry > 0 ? "+" : "−") + nf(Math.abs(r.carry))) : "—"}</td><td class="n pos">${cell(r.bonus, "+")}</td><td class="n neg">${cell(r2(r.deduct + r.absence), "−")}</td><td class="n neg">${cell(r.advance, "−")}</td><td class="n">${cell(r.payout, "−")}</td><td class="n"><b class="num">${nf(Math.abs(r.due))}</b> ${dueLabel(r.due)}</td>
    <td class="nowrap"><button class="btn sm" data-act="pe-new" data-id="advance" data-emp="${w.id}">سلفة</button> <button class="btn sm" data-act="pe-new" data-id="deduct" data-emp="${w.id}">خصم</button> <button class="btn sm" data-act="pe-new" data-id="bonus" data-emp="${w.id}">مكافأة</button> <button class="btn sm" data-act="pe-new" data-id="payout" data-emp="${w.id}">صرف</button> <button class="btn sm" data-act="emp-st" data-id="${w.id}">الكشف</button></td></tr>`; }).join("")
    : emptyRow(9, "لا يوجد موظفين على المرتبات. اضغط «+ موظف» وحدد المرتب الشهري.")}
  </tbody></table></div>
  ${noSalary.length ? `<p class="small muted">بدون مرتب محدد: ${noSalary.map(w => `${esc(w.name)} <button type="button" class="linkbtn" data-act="salary" data-id="${w.id}">حدد المرتب</button>`).join(" · ")}</p>` : ""}
  <p class="small muted">المتبقي = المرحّل من الشهر اللي فات + المرتب + المكافآت − الخصومات والغياب − السلف − المصروف. أي باقي أو زيادة بيترحّل للشهر اللي بعده تلقائياً. السلف والمرتبات المصروفة بتتحسب في المصروفات تحت بند «مرتبات».</p></section>`;
};

function payEntryForm(type, empId, existing) {
  const emps = workers().filter(onPayroll);
  if (existing && !emps.some(w => w.id === existing.empId) && S.workers.get(existing.empId)) emps.push(S.workers.get(existing.empId));
  if (!emps.length) { toast("أضف موظف بمرتب أولاً من «المرتبات ← + موظف»."); go("payroll"); return; }
  const p = existing || { type: type || "advance", empId: emps.some(w => w.id === empId) ? empId : emps[0].id, date: today() };
  const form = openModal(existing ? "تعديل حركة مرتبات" : (PAY_TYPES[p.type] || PAY_TYPES.advance).label, `<div class="form">
    ${field("الموظف", `<select name="empId" id="f-empId">${emps.map(w => opt(w.id, w.name, p.empId)).join("")}</select>`)}
    ${field("النوع", `<select name="type" id="f-type">${Object.entries(PAY_TYPES).map(([k, v]) => opt(k, v.label, p.type)).join("")}</select>`)}
    <label class="f" id="pe-days"><span>عدد أيام الغياب</span>${numInput("days", p.days)}<small>المبلغ = مرتب اليوم × عدد الأيام (المرتب ÷ 30)</small></label>
    ${field("المبلغ", numInput("amount", p.amount, "required"))}
    ${field("التاريخ", dateInput("date", p.date))}
    ${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(p.note || "")}" placeholder="مثال: سلفة نقدي">`)}
    <div class="f full"><div class="sum-box" id="pe-sum"></div></div></div>`, {
    submitLabel: existing ? "حفظ التعديل" : "سجّل",
    onSubmit: async fd => {
      const t = fv(fd, "type"), amount = fnum(fd, "amount"), emp = fv(fd, "empId");
      if (!PAY_TYPES[t]) return "اختر النوع.";
      if (!isFinite(amount) || amount <= 0) return "اكتب مبلغ أكبر من صفر.";
      const data = { empId: emp, type: t, amount: r2(amount), date: fv(fd, "date") || today(), note: fv(fd, "note"), by: OWNER_ID };
      if (t === "absence") { const dd = fnum(fd, "days"); if (isFinite(dd) && dd > 0) data.days = r2(dd); }
      const sum = `${PAY_TYPES[t].short} ${money(data.amount)} — ${wName(emp)}${data.days ? ` (${nf(data.days)} يوم)` : ""}${data.note ? " — " + data.note : ""}`;
      const left = () => { const d = payRow(emp, data.date.slice(0, 7)).due; return d >= 0 ? `الباقي له ${money(d)}` : `عليه ${money(-d)} يتخصموا الشهر الجاي`; };
      if (existing) { const next = Object.assign({}, existing, data, { editedAt: nowISO() }); if (t !== "absence") delete next.days; await Store.put("payroll", existing.id, next); audit("تعديل", "payroll", existing.id, "تعديل " + sum, existing, next); return saved(`اتعدل. ${left()}`, "payroll", existing.id, existing); }
      else { const id = Store.newId(); await Store.put("payroll", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "payroll", id, sum); return saved(`اتسجل ${PAY_TYPES[t].short} ${money(data.amount)} لـ${wName(emp)}. ${left()}`, "payroll", id, null); }
    }
  });
  const $f = n => form.querySelector(`[name=${n}]`);
  let amountTouched = !!existing;
  $f("amount").addEventListener("input", () => amountTouched = true);
  const upd = () => {
    const t = $f("type").value, emp = $f("empId").value, w = S.workers.get(emp), date = $f("date").value || today(), ym = date.slice(0, 7);
    $("#pe-days").hidden = t !== "absence";
    $("#m-title").textContent = existing ? "تعديل حركة مرتبات" : PAY_TYPES[t].label;
    const r = payRow(emp, ym);
    let before = r.due; if (existing && existing.empId === emp && peMonth(existing) === ym) before = r2(before + (existing.type === "bonus" ? -existing.amount : +existing.amount));
    if (!amountTouched) {
      if (t === "absence") { const dd = pnum($f("days").value); $f("amount").value = isFinite(dd) && dd > 0 ? r2(salaryFor(w, ym) / 30 * dd) : ""; }
      else if (t === "payout") $f("amount").value = before > 0 ? before : "";
      else $f("amount").value = "";
    }
    const a = pnum($f("amount").value) || 0, after = r2(before + (t === "bonus" ? a : -a));
    $("#pe-sum").innerHTML = `<div class="small"><span>المرتب الشهري</span><span class="num">${money(salaryFor(w, ym))}</span></div>
      <div><span>المتبقي له في ${MONTHS[+ym.slice(5, 7) - 1]} قبل التسجيل</span><b class="num">${money(before)}</b></div>
      <div class="big"><span>بعد التسجيل</span><b class="num ${after < 0 ? "neg" : ""}">${money(after)}</b></div>`;
  };
  ["type", "empId", "date"].forEach(n => $f(n).addEventListener("change", () => { if (n !== "date") amountTouched = !!existing && n === "empId" ? amountTouched : false; upd(); }));
  $f("days").addEventListener("input", () => { amountTouched = false; upd(); });
  $f("amount").addEventListener("input", upd);
  upd();
}
function salaryForm(empId) {
  const w = S.workers.get(empId); if (!w) return;
  const curSal = salaryFor(w, curMonth()), had = onPayroll(w);
  const months = [prevMonth(prevMonth(curMonth())), prevMonth(curMonth()), curMonth(), nextMonth(curMonth())];
  openModal(had ? `زيادة / تغيير مرتب ${w.name}` : `تحديد مرتب ${w.name}`, `<div class="form">
    ${had ? `<div class="f full"><div class="sum-box"><div><span>المرتب الحالي</span><b class="num">${money(curSal)}</b></div></div></div>` : ""}
    ${field("المرتب الشهري الجديد", numInput("amount", had ? curSal : "", "required"))}
    ${field("يبدأ من شهر", `<select name="from" id="f-from">${months.map(m => opt(m, monthLabel(m), curMonth())).join("")}</select>`, "", "الشهور اللي قبله بتفضل بالمرتب القديم")}</div>`, {
    submitLabel: "حفظ المرتب", done: "تم حفظ المرتب",
    onSubmit: async fd => {
      const amount = fnum(fd, "amount"), from = fv(fd, "from") || curMonth();
      if (!isFinite(amount) || amount < 0) return "اكتب المرتب بالأرقام.";
      const hist = salaryHist(w).filter(x => x.from !== from).concat([{ from, amount: r2(amount), at: nowISO() }]).sort((a, b) => a.from < b.from ? -1 : 1);
      const next = Object.assign({}, w, { salaryHistory: hist, startMonth: w.startMonth && w.startMonth < hist[0].from ? w.startMonth : hist[0].from });
      next.salary = salaryFor(next, curMonth()) || r2(amount);
      await Store.put("workers", w.id, next);
      audit("تعديل", "worker", w.id, had ? `${amount > curSal ? "زيادة" : "تغيير"} مرتب ${w.name}: ${money(curSal)} ← ${money(amount)} من ${monthLabel(from)}` : `تحديد مرتب ${w.name}: ${money(amount)} من ${monthLabel(from)}`);
    }
  });
}
function empStatementText(empId, ym) {
  const w = S.workers.get(empId), r = payRow(empId, ym);
  return [`${settings().farmName || "Pets Home"} — كشف مرتب ${w ? w.name : ""} — ${monthLabel(ym)}`, "—".repeat(14),
    r.carry ? `مرحّل من الشهر اللي فات: ${r.carry > 0 ? "+" : "−"}${money(Math.abs(r.carry))}` : null,
    `المرتب: ${money(r.base)}`, r.bonus ? `+ مكافآت: ${money(r.bonus)}` : null, r.deduct ? `− خصومات: ${money(r.deduct)}` : null,
    r.absence ? `− غياب: ${money(r.absence)}` : null, r.advance ? `− سلف: ${money(r.advance)}` : null, r.payout ? `− تم صرفه: ${money(r.payout)}` : null,
    "—".repeat(14), r.due >= 0 ? `المتبقي له: ${money(r.due)}` : `عليه للشهر الجاي: ${money(-r.due)}`,
    ...r.entries.map(p => `• ${fmtDate(p.date)} ${PAY_TYPES[p.type] ? PAY_TYPES[p.type].short : p.type} ${money(p.amount)}${p.note ? " — " + p.note : ""}`)].filter(Boolean).join("\n");
}
function empStatement(empId, ym) {
  const w = S.workers.get(empId); if (!w) return; ym = ym || payMonth;
  const r = payRow(empId, ym), hist = [...payLedger(empId).values()].reverse().slice(0, 12);
  openModal(`كشف مرتب ${w.name}`, `<div class="stack">
    <div class="monthnav"><button type="button" class="btn sm" data-act="emp-st" data-id="${empId}" data-month="${prevMonth(ym)}">الشهر السابق</button><b>${monthLabel(ym)}</b>${ym < curMonth() ? `<button type="button" class="btn sm" data-act="emp-st" data-id="${empId}" data-month="${nextMonth(ym)}">الشهر التالي</button>` : `<span class="btn sm" style="visibility:hidden">الشهر التالي</span>`}</div>
    <div class="sum-box">
      ${r.carry ? `<div class="small"><span>${r.carry > 0 ? "باقي له من الشهر اللي فات" : "عليه من الشهر اللي فات"}</span><span class="num">${money(Math.abs(r.carry))}</span></div>` : ""}
      <div><span>المرتب الأساسي</span><b class="num">${money(r.base)}</b></div>
      ${r.bonus ? `<div class="small"><span>+ مكافآت</span><span class="num pos">${money(r.bonus)}</span></div>` : ""}
      ${r.deduct ? `<div class="small"><span>− خصومات</span><span class="num neg">${money(r.deduct)}</span></div>` : ""}
      ${r.absence ? `<div class="small"><span>− غياب</span><span class="num neg">${money(r.absence)}</span></div>` : ""}
      ${r.advance ? `<div class="small"><span>− سلف ومسحوبات</span><span class="num neg">${money(r.advance)}</span></div>` : ""}
      ${r.payout ? `<div class="small"><span>− تم صرفه</span><span class="num">${money(r.payout)}</span></div>` : ""}
      <div class="big"><span>${r.due >= 0 ? "المتبقي له" : "عليه (يتخصم الشهر الجاي)"}</span><b class="num ${r.due < 0 ? "neg" : ""}">${money(Math.abs(r.due))}</b></div></div>
    <h3>حركات الشهر</h3><div class="tbl-wrap"><table class="rtable"><thead><tr><th>النوع</th><th>التاريخ</th><th class="n">المبلغ</th><th>ملاحظة</th><th></th></tr></thead><tbody>
    ${r.entries.length ? r.entries.map(p => `<tr><td>${pill([PAY_TYPES[p.type] ? PAY_TYPES[p.type].label : p.type, PAY_TYPES[p.type] ? PAY_TYPES[p.type].cls : ""])}${p.days ? ` <span class="small muted">${nf(p.days)} يوم</span>` : ""}</td><td class="nowrap">${fmtDate(p.date)}</td><td class="n ${p.type === "bonus" ? "pos" : "neg"}">${sgn((p.type === "bonus" ? "+" : "−") + nf(p.amount))}</td><td class="small">${esc(p.note || "") || "—"}</td><td class="nowrap">${rowActions("pe", p.id)}</td></tr>`).join("") : emptyRow(5, "لا توجد حركات في هذا الشهر.")}
    </tbody></table></div>
    <h3>آخر الشهور</h3><div class="tbl-wrap"><table class="rtable"><thead><tr><th>الشهر</th><th class="n">المرتب</th><th class="n">المستحق</th><th class="n">سلف + مصروف</th><th class="n">المتبقي</th></tr></thead><tbody>
    ${hist.map(h => `<tr><td>${monthLabel(h.ym)}</td><td class="n">${nf(h.base)}</td><td class="n">${nf(h.earned)}</td><td class="n">${nf(r2(h.advance + h.payout))}</td><td class="n"><b>${nf(h.due)}</b></td></tr>`).join("")}
    </tbody></table></div>
    <p class="small muted">تاريخ المرتب: ${salaryHist(w).slice().sort((a, b) => a.from < b.from ? -1 : 1).map(x => `${money(x.amount)} من ${monthLabel(x.from)}`).join(" ← ") || "لم يُحدد"}</p></div>`, {
    wide: true, noFocus: true,
    extra: `<button type="button" class="btn primary" data-act="pe-new" data-id="payout" data-emp="${empId}">صرف المرتب</button><button type="button" class="btn" data-act="pe-new" data-id="advance" data-emp="${empId}">سلفة</button><button type="button" class="btn" data-act="salary" data-id="${empId}">تغيير المرتب</button><button type="button" class="btn" id="emp-share">${navigator.share ? "مشاركة الكشف" : "نسخ الكشف"}</button>`
  });
  labelTables($("#modal-root"));
  $("#emp-share").onclick = () => shareOrCopy("كشف مرتب", empStatementText(empId, ym), "تم نسخ الكشف");
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
    <p>${MODE === "cloud" ? "البيانات محفوظة على السحابة. النسخة الاحتياطية ملف إضافي للاحتياط تحتفظ بيه معاك." : "كل بيانات المزرعة محفوظة على هذا الموبايل فقط. لو اتمسح التطبيق أو ضاع الموبايل، النسخة الاحتياطية هي اللي بترجّع البيانات."}</p>
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
      Store.bulk(replaceOps(snap.data)); mergeAudit(snap.data.audit);
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
    Store.bulk(replaceOps(o.data, !replace)); mergeAudit(o.data.audit);
    if (!S.meta.get("settings")) Store.put("meta", "settings", { farmName: "Pets Home", ownerName: "المدير", createdAt: nowISO() });
    audit("استرجاع", "backup", "", `استرجاع نسخة احتياطية بتاريخ ${fmtDT(o.exportedAt)} (${n} سجل)${replace ? " — استبدال كامل" : " — دمج"}`);
    Local.flush(); closeModal(); toast("تم الاسترجاع"); render();
  };
  if (fresh) return apply(true);
  openModal("استرجاع نسخة احتياطية", `<p>النسخة بتاريخ <b>${fmtDT(o.exportedAt)}</b> وفيها ${nf(n, 0)} سجل.</p><p class="small muted">«استبدال» يمسح البيانات الحالية ويضع بيانات النسخة مكانها. «دمج» يضيف سجلات النسخة للبيانات الحالية.</p>`,
    { noFocus: true, extra: `<button type="button" class="btn danger" id="imp-replace">استبدال كل البيانات</button><button type="button" class="btn" id="imp-merge">دمج</button>` });
  $("#imp-replace").onclick = () => apply(true); $("#imp-merge").onclick = () => apply(false);
}
/* Writes needed to make the data equal `data` (or, with merge, to add what's missing). The audit log is history: it is only ever added to. */
function replaceOps(data, merge) {
  const ops = [];
  for (const c of COLS) {
    if (c === "audit") continue;
    const incoming = data[c] || {};
    if (!merge) for (const id of S[c].keys()) if (!(id in incoming) && !(c === "meta" && id === "app")) ops.push({ op: "del", col: c, id });
    for (const [id, v] of Object.entries(incoming)) {
      const cur = S[c].get(id);
      if (!cur || JSON.stringify(fromMap(new Map([[id, cur]]))[id]) !== JSON.stringify(v)) ops.push({ op: "put", col: c, id, data: v });
    }
  }
  return ops;
}
function mergeAudit(auditData) {
  Object.entries(auditData || {}).forEach(([id, d]) => {
    const entries = (d && d.entries) || []; if (!entries.length) return;
    const date = (d && d.date) || id.slice(0, 10);
    if (MODE === "cloud") { B.appendAuditMany(id, { date }, entries).catch(e => console.error("audit merge", e)); return; }
    const cur = S.audit.get(id), have = new Set((cur ? cur.entries || [] : []).map(e => e.at + "|" + e.summary));
    const add = entries.filter(e => !have.has(e.at + "|" + e.summary));
    if (add.length) Store.put("audit", id, { date, entries: (cur ? cur.entries || [] : []).concat(add) });
  });
}
function resetAll() {
  openModal("مسح كل البيانات", `<p>هيتم مسح كل الأصناف والأوردرات والمصروفات والعملاء والمرتبات ${MODE === "cloud" ? "من الحساب على كل الأجهزة" : "من هذا الموبايل"}. سجل العمليات بيفضل زي ما هو.</p><p class="small muted">لو محتاج البيانات دي بعدين، اعمل نسخة احتياطية الأول.</p><div class="form">${field("للتأكيد اكتب: مسح", `<input type="text" name="confirm" id="f-confirm" autocomplete="off">`, "full")}</div>`, {
    danger: true, submitLabel: "مسح نهائي", noFocus: true,
    onSubmit: async fd => {
      if (fv(fd, "confirm") !== "مسح") return "اكتب كلمة «مسح» للتأكيد.";
      await Local.snapshot("قبل مسح كل البيانات");
      Store.bulk(replaceOps({})); await Local.flush();
      route = "dashboard"; lsSet("petshome:lastBy", null);
    }
  });
}

/* ================== Suppliers ==================
   Purchases on credit (an expense with payType "credit" and a supplierId) add to what is owed;
   a supplier payment (finance record, kind "supplierPay") reduces it. A payment moves cash but is not a new expense. */
const suppliers = () => [...S.suppliers.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
const supplierName = id => (S.suppliers.get(id) || {}).name || "مورد";
function supplierBalances() {
  return memo("supb", () => {
    const m = new Map();
    for (const x of S.finance.values()) {
      if (!x.supplierId) continue;
      if (x.kind === "expense" && x.payType === "credit") m.set(x.supplierId, r2((m.get(x.supplierId) || 0) + (+x.amount || 0)));
      if (x.kind === "supplierPay") m.set(x.supplierId, r2((m.get(x.supplierId) || 0) - (+x.amount || 0)));
    }
    return m;
  });
}
VIEWS.suppliers = () => {
  const bal = supplierBalances(), list = suppliers();
  const total = [...bal.values()].reduce((a, v) => a + Math.max(0, v), 0);
  const loose = [...S.finance.values()].filter(x => x.kind === "expense" && x.payType === "credit" && !x.supplierId).reduce((a, x) => a + (+x.amount || 0), 0);
  const stat = id => { let bought = 0, credit = 0, paid = 0; for (const x of S.finance.values()) if (x.supplierId === id) { if (x.kind === "expense") { bought += +x.amount || 0; if (x.payType === "credit") credit += +x.amount || 0; } if (x.kind === "supplierPay") paid += +x.amount || 0; } return { bought, credit, paid }; };
  return `${headHtml("الموردين وحساباتهم", `عليك للموردين: <b class="money">${money(r2(total))}</b>`, `<button class="btn primary" data-act="supplier-pay">سداد لمورد</button><button class="btn" data-act="new-supplier">+ مورد</button>`)}
  <p class="intro">لما تشتري حاجة آجل، سجّلها كمصروف «آجل» واختار المورد. لما تدفع له، اضغط «سداد لمورد». التطبيق بيحسب عليك كام لكل مورد.</p>
  <section class="panel"><div class="tbl-wrap"><table class="rtable"><thead><tr><th>المورد</th><th>التليفون</th><th class="n">اشتريت منه</th><th class="n">منها آجل</th><th class="n">دفعت له</th><th class="n">عليك له</th><th></th></tr></thead><tbody>
  ${list.length ? list.map(v => { const st = stat(v.id), due = bal.get(v.id) || 0; return `<tr><td><b>${esc(v.name)}</b>${v.note ? ` <span class="small muted">${esc(v.note)}</span>` : ""}</td><td dir="ltr" style="text-align:start">${esc(v.phone || "—")}</td><td class="n">${nf(st.bought)}</td><td class="n">${nf(st.credit)}</td><td class="n">${nf(st.paid)}</td><td class="n ${due > 0.005 ? "neg" : ""}"><b>${nf(due)}</b></td>
    <td class="nowrap">${due > 0.005 ? `<button class="btn sm primary" data-act="supplier-pay" data-id="${v.id}">سداد</button> ` : ""}<button class="btn sm" data-act="supplier-st" data-id="${v.id}">كشف حساب</button>${v.phone ? ` <a class="btn sm" href="tel:${esc(v.phone)}">اتصال</a>` : ""}${isMgr() ? ` <button class="btn sm" data-act="edit-supplier" data-id="${v.id}">تعديل</button>` : ""}</td></tr>`; }).join("") : emptyRow(7, "لسه مفيش موردين. ضيف المورد من هنا أو وانت بتسجل مصروف.")}
  </tbody></table></div>
  ${loose > 0.005 ? `<p class="small muted">في مصروفات آجل بـ${money(r2(loose))} من غير مورد محدد. افتحها من «المصروفات» واختار المورد عشان تتحسب هنا.</p>` : ""}</section>`;
};
function supplierForm(existing) {
  const v = existing || {};
  openModal(existing ? "تعديل بيانات مورد" : "مورد جديد", `<div class="form">${field("اسم المورد", `<input type="text" name="name" id="f-name" value="${esc(v.name || "")}" required>`, "full")}${field("التليفون", `<input type="tel" name="phone" id="f-phone" dir="ltr" value="${esc(v.phone || "")}">`)}${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(v.note || "")}" placeholder="مثال: ردة وأكل">`)}</div>`, {
    done: "اتحفظ",
    onSubmit: async fd => {
      const name = fv(fd, "name"); if (!name) return "اكتب اسم المورد.";
      const data = { name, phone: fv(fd, "phone"), note: fv(fd, "note") };
      if (existing) { const next = Object.assign({}, existing, data); await Store.put("suppliers", existing.id, next); audit("تعديل", "supplier", existing.id, `تعديل بيانات مورد ${name}`, existing, next); }
      else { const id = Store.newId(); await Store.put("suppliers", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "supplier", id, `إضافة مورد ${name}`); }
    }
  });
}
function supplierPayForm(supplierId, existing) {
  const all = suppliers(); if (!all.length) { toast("ضيف مورد الأول من «الموردين»."); go("suppliers"); return; }
  const x = existing || { supplierId: supplierId || (all.find(v => (supplierBalances().get(v.id) || 0) > 0) || all[0]).id, date: today() };
  const form = openModal(existing ? "تعديل سداد لمورد" : "سداد لمورد", `<div class="form">
    ${field("المورد", `<select name="supplierId" id="f-supplierId">${all.map(v => opt(v.id, `${v.name} — عليك له ${nf(supplierBalances().get(v.id) || 0)}`, x.supplierId)).join("")}</select>`, "full")}
    ${field("دفعت كام؟", numInput("amount", x.amount, "required"))}
    ${field("التاريخ", dateInput("date", x.date))}
    ${field("طريقة الدفع", `<select name="method" id="f-method">${["كاش", "تحويل / محفظة", "شيك"].map(m => opt(m, m, x.method)).join("")}</select>`)}
    ${field("ملاحظة", `<input type="text" name="note" id="f-note" value="${esc(x.note || "")}">`)}</div>`, {
    submitLabel: existing ? "حفظ التعديل" : "سجّل السداد",
    onSubmit: async fd => {
      const amount = fnum(fd, "amount"); if (!isFinite(amount) || amount <= 0) return "اكتب مبلغ أكبر من صفر.";
      const data = { kind: "supplierPay", supplierId: fv(fd, "supplierId"), amount: r2(amount), date: fv(fd, "date") || today(), method: fv(fd, "method"), payType: "cash", note: fv(fd, "note"), by: byVal(fd) };
      const sum = `سداد ${money(data.amount)} للمورد ${supplierName(data.supplierId)}`;
      const left = () => { const d = supplierBalances().get(data.supplierId) || 0; return d > 0.005 ? `باقي عليك له ${money(d)}` : "حسابه بقى خالص"; };
      if (existing) { const next = Object.assign({}, existing, data, { editedAt: nowISO() }); await Store.put("finance", existing.id, next); audit("تعديل", "finance", existing.id, "تعديل " + sum, existing, next); return saved(`اتعدل السداد. ${left()}`, "finance", existing.id, existing); }
      const id = Store.newId(); await Store.put("finance", id, Object.assign(data, { at: nowISO() })); audit("إضافة", "finance", id, sum);
      return saved(`اتسجل ${sum}. ${left()}`, "finance", id, null);
    }
  });
  const sel = form.querySelector("[name=supplierId]"), amt = form.querySelector("[name=amount]");
  const fill = () => { if (!existing) { const d = supplierBalances().get(sel.value) || 0; amt.value = d > 0 ? d : ""; } };
  sel.onchange = fill; fill();
}
function supplierStatement(id) {
  const rows = [...S.finance.values()].filter(x => x.supplierId === id && ((x.kind === "expense" && x.payType === "credit") || x.kind === "supplierPay")).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || "") < (b.at || "") ? -1 : 1);
  let bal = 0;
  const body = `<div class="tbl-wrap"><table class="rtable"><thead><tr><th>البيان</th><th>التاريخ</th><th class="n">اشتريت آجل</th><th class="n">دفعت</th><th class="n">عليك له</th></tr></thead><tbody>
    ${rows.length ? rows.map(x => { const inc = x.kind === "expense"; bal = r2(bal + (inc ? +x.amount : -x.amount)); return `<tr><td>${inc ? `${esc(x.category)}${x.note ? " — " + esc(x.note) : ""}` : `سداد (${esc(x.method || "كاش")})`}</td><td class="nowrap">${fmtDate(x.date)}</td><td class="n">${inc ? nf(x.amount) : "—"}</td><td class="n">${inc ? "—" : nf(x.amount)}</td><td class="n"><b>${nf(bal)}</b></td></tr>`; }).join("") : emptyRow(5, "مفيش مشتريات آجل أو سداد لسه.")}
    </tbody></table></div>`;
  openModal(`كشف حساب ${supplierName(id)}`, body, { wide: true, noFocus: true, extra: `<button type="button" class="btn primary" data-act="supplier-pay" data-id="${id}">سداد</button>` });
  labelTables($("#modal-root"));
}

/* ================== Attendance ==================
   Everyone counts as present. Marking someone absent saves a payroll "absence" entry for that day
   (fixed id att-<date>-<employee>, so it can be undone by marking them present again). */
let attDate = null;
const attId = (date, empId) => `att-${date}-${empId}`;
VIEWS.attendance = () => {
  const d = attDate || today(), ym = d.slice(0, 7);
  const emps = workers().filter(w => onPayroll(w) && salaryFor(w, ym) > 0);
  const state = w => { const p = S.payroll.get(attId(d, w.id)); return !p ? "in" : (+p.days || 1) < 1 ? "half" : "out"; };
  const absent = emps.filter(w => state(w) !== "in").length, half = emps.filter(w => state(w) === "half").length;
  return `${headHtml("حضور الموظفين", "الكل حاضر إلا اللي تعلّم عليه. الغياب بيتخصم من المرتب لوحده (يوم = المرتب ÷ 30).", `<button class="btn" data-go="payroll">المرتبات</button>`)}
  <section class="panel"><div class="panel-head"><h2>${dayName(d)} ${fmtDate(d)}</h2><span class="hint">حاضر ${emps.length - absent}${half ? ` · نص يوم ${half}` : ""}${absent - half ? ` · غايب ${absent - half}` : ""}</span></div>
  <div class="filters"><label>اليوم<input type="date" id="att-date" value="${d}" max="${today()}"></label></div>
  ${emps.length ? `<ul class="att">${emps.map(w => { const st = state(w); return `<li><b>${esc(w.name)}</b><div class="seg" role="group" aria-label="${esc(w.name)}">
    <button type="button" data-att="in" data-id="${w.id}" aria-pressed="${st === "in"}">حاضر</button><button type="button" data-att="half" data-id="${w.id}" aria-pressed="${st === "half"}">نص يوم</button><button type="button" data-att="out" data-id="${w.id}" aria-pressed="${st === "out"}">غايب</button></div></li>`; }).join("")}</ul>`
    : `<div class="empty">مفيش موظفين على المرتبات. ضيفهم من «المرتبات ← + موظف».</div>`}
  </section>`;
};
afterRender.attendance = () => {
  const di = $("#att-date"); if (di) di.onchange = () => { attDate = di.value || today(); di.blur(); render(); };
  $$("[data-att]").forEach(b => b.onclick = () => setAttendance(attDate || today(), b.dataset.id, b.dataset.att));
};
function setAttendance(date, empId, st) {
  const w = S.workers.get(empId); if (!w) return;
  const id = attId(date, empId), cur = S.payroll.get(id);
  if (st === "in") { if (cur) { Store.remove("payroll", id); audit("حذف", "payroll", id, `${w.name} حاضر يوم ${fmtDate(date)} (اتشال الغياب)`); toast(`${w.name}: حاضر`); } return; }
  const days = st === "half" ? 0.5 : 1, amount = r2(salaryFor(w, date.slice(0, 7)) / 30 * days);
  Store.put("payroll", id, { empId, type: "absence", days, amount, date, note: st === "half" ? "نص يوم (من الحضور)" : "غياب (من الحضور)", src: "attendance", by: me().id, at: nowISO() });
  audit(cur ? "تعديل" : "إضافة", "payroll", id, `${w.name} ${st === "half" ? "نص يوم" : "غايب"} يوم ${fmtDate(date)} — خصم ${money(amount)}`);
  toast(`${w.name}: ${st === "half" ? "نص يوم" : "غايب"}، اتخصم ${money(amount)}`);
}

/* ================== Help ================== */
VIEWS.help = () => `${headHtml("إزاي أستخدم التطبيق", "خطوات قصيرة لأهم الحاجات.")}
  <section class="panel help">
    <h2>أول مرة</h2><ol>
      <li>من «الإعدادات» ضيف كل صنف: اسمه، الطبق فيه كام كيلو أو عدد، وسعره.</li>
      <li>من «المخزون» اضغط «الموجود في الغرفة دلوقتي» واكتب عدد الأطباق من كل صنف.</li>
      <li>من «المرتبات» ضيف الموظفين ومرتب كل واحد.</li></ol>
    <h2>كل يوم</h2><ul>
      <li><b>إنتاج:</b> زرار + ← «سجّل إنتاج»: اختار الصنف واكتب عدد الأطباق.</li>
      <li><b>أوردر:</b> زرار + ← «أوردر جديد»: العميل، الأصناف والأطباق، ودفع كام. الفاتورة بتطلع لوحدها وتقدر تبعتها واتساب.</li>
      <li><b>مصروف:</b> زرار + ← «مصروف جديد». لو آجل اختار المورد.</li>
      <li><b>موظف أخد فلوس:</b> زرار + ← «سلفة لموظف». بتتخصم من مرتبه لوحدها.</li>
      <li><b>غياب:</b> «حضور الموظفين»: علّم على اللي غاب.</li>
      <li>لو سجلت حاجة غلط: اضغط «تراجع» في الرسالة اللي بتظهر تحت بعد الحفظ.</li></ul>
    <h2>آخر الشهر</h2><ul>
      <li><b>المكسب:</b> «التقارير والأرباح» ← «الأرباح الشهرية».</li>
      <li><b>المرتبات:</b> من «المرتبات» اضغط «صرف» لكل موظف. المبلغ بيتحسب لوحده بعد السلف والخصومات.</li></ul>
    <h2>من غير نت</h2><p>سجّل عادي. كل حاجة بتترفع لوحدها لما النت يرجع.</p>
    <h2>الكلام صغير؟</h2><p>من «المزيد» ← «حجم الكلام» اختار «كبير» أو «أكبر».</p>
  </section>`;

/* ================== Text size (per phone) ================== */
const FS = [["1", "عادي"], ["1.12", "كبير"], ["1.25", "أكبر"]];
const fontSize = () => { const v = lsGet("petshome:fs"); return FS.some(f => f[0] === v) ? v : "1.12"; };
function applyFontSize() { document.documentElement.style.setProperty("--fs", fontSize()); }
const fontSizeSeg = () => `<div class="seg" role="group" aria-label="حجم الكلام">${FS.map(([v, l]) => `<button type="button" data-act="fs" data-id="${v}" aria-pressed="${fontSize() === v}">${l}</button>`).join("")}</div>`;
applyFontSize();

/* ================== Cloud: sign-in, account, moving phone data up ================== */
const AUTH_MSG = {
  "auth/invalid-credential": "اسم المستخدم أو كلمة السر غير صحيحة.", "auth/wrong-password": "اسم المستخدم أو كلمة السر غير صحيحة.",
  "auth/user-not-found": "اسم المستخدم أو كلمة السر غير صحيحة.", "auth/invalid-email": "اسم المستخدم غير صالح.",
  "auth/too-many-requests": "محاولات كتير. استنى دقائق وحاول تاني.", "auth/network-request-failed": "مفيش إنترنت. أول دخول على أي جهاز محتاج إنترنت.",
  "auth/weak-password": "كلمة السر قصيرة. 6 حروف أو أرقام على الأقل.", "auth/requires-recent-login": "اخرج وادخل تاني وبعدين جرّب."
};
const authMsg = e => AUTH_MSG[e && e.code] || "حصل خطأ. حاول تاني.";
const accountName = () => ((authUser && authUser.email) || "").split("@")[0];
function renderLogin(app) {
  app.innerHTML = `<div class="screen"><form class="card" id="auth-form" novalidate>
    <div><div class="logo">Pets Home</div><p class="muted">ادخل باسم المستخدم وكلمة السر. لو انت موظف، المدير هيديهوملك.</p></div>
    <div class="form">
      ${field("اسم المستخدم", `<input type="text" name="user" id="a-user" dir="ltr" autocapitalize="none" autocomplete="username" spellcheck="false" value="${esc(lsGet("petshome:lastUser") || "")}">`, "full")}
      ${field("كلمة السر", `<input type="password" name="pass" id="a-pass" dir="ltr" autocomplete="current-password">`, "full")}
    </div>
    <div class="err" id="a-err" hidden></div>
    <button class="btn primary block" type="submit" id="a-submit">دخول</button></form></div>`;
  $("#auth-form").addEventListener("submit", async e => {
    e.preventDefault(); const fd = new FormData(e.target); const err = $("#a-err"); err.hidden = true;
    const user = fv(fd, "user"), pass = (fd.get("pass") || "").toString();
    if (!user || !pass) { err.textContent = "اكتب اسم المستخدم وكلمة السر."; err.hidden = false; return; }
    $("#a-submit").disabled = true; document.activeElement && document.activeElement.blur();
    try { await B.signIn(user, pass); lsSet("petshome:lastUser", user); }
    catch (ex) { const er = $("#a-err"); if (er) { er.textContent = authMsg(ex); er.hidden = false; } const b = $("#a-submit"); if (b) b.disabled = false; }
  });
}
function renderDenied(app, worker) {
  app.innerHTML = `<div class="screen"><div class="card"><div class="logo">Pets Home</div>
    <p>${worker ? `الحساب <b dir="ltr">${esc(accountName())}</b> موقوف أو لسه ما اتفعّلش.` : `الحساب <b dir="ltr">${esc(accountName())}</b> ليس له صلاحية على بيانات المزرعة.`}</p><p class="small muted">${worker ? "كلّم المدير." : "ادخل بحساب المزرعة."}</p>
    <button type="button" class="btn primary block" data-act="logout">تسجيل الخروج</button></div></div>`;
}
function accountSheet() {
  openModal("حسابي", `<div class="stack"><div class="sum-box"><div><span>الحساب</span><b dir="ltr">${esc(accountName())}</b></div>
      <div class="small"><span>الحالة</span><span>${navigator.onLine === false ? "غير متصل — التسجيلات هتترفع لما النت يرجع" : "متصل بالسحابة"}</span></div></div>
    <h3>تغيير كلمة السر</h3><div class="form">${field("كلمة السر الحالية", `<input type="password" name="cur" id="f-cur" dir="ltr" autocomplete="current-password">`)}${field("كلمة السر الجديدة", `<input type="password" name="next" id="f-next" dir="ltr" autocomplete="new-password">`, "", "6 حروف أو أرقام على الأقل")}</div></div>`, {
    submitLabel: "تغيير كلمة السر", noFocus: true, done: "تم تغيير كلمة السر",
    extra: `<button type="button" class="btn danger" data-act="logout">تسجيل الخروج</button>`,
    onSubmit: async fd => {
      const c = (fd.get("cur") || "").toString(), n = (fd.get("next") || "").toString();
      if (!c || !n) return "اكتب كلمة السر الحالية والجديدة."; if (n.length < 6) return "كلمة السر الجديدة 6 حروف أو أرقام على الأقل.";
      try { await B.changePassword(c, n); } catch (ex) { return authMsg(ex); }
    }
  });
}
function signOutCloud() { closeModal(true); Cloud.stop(); cloudBooted = false; if (acctUnsub) { acctUnsub(); acctUnsub = null; } acct = undefined; ACCOUNTS = new Map(); if (B) B.signOut(); }
/* Names of employees for screens an employee login sees (they can't read the employee list itself, which has salaries). */
function syncPeople() {
  if (MODE !== "cloud" || !isMgr() || !Cloud.isReady()) return;
  const names = {}; S.workers.forEach((w, id) => names[id] = w.name);
  const cur = S.meta.get("people");
  if (!cur || JSON.stringify(cur.names || {}) !== JSON.stringify(names)) Store.put("meta", "people", { names });
}
async function cloudAfterReady() {
  if (!isMgr()) return;
  try {
    syncPeople();
    const marker = await Local.getKey("__meta_cloud");
    if ((S.meta.size || recordCount()) && (!marker || marker.appVersion !== APP_VERSION)) await Local.snapshot(`نسخة من السحابة قبل التحديث إلى ${APP_VERSION}`, marker && marker.appVersion);
    await Local.putKey("__meta_cloud", { appVersion: APP_VERSION, updatedAt: nowISO() });
    const appDoc = S.meta.get("app"), from = appDoc && appDoc.schema ? appDoc.schema : 1;
    MIGRATIONS.filter(m => m.to > from && m.to <= SCHEMA).sort((a, b) => a.to - b.to).forEach(m => m.run());
    if (S.meta.get("settings") && (!appDoc || appDoc.schema !== SCHEMA || appDoc.appVersion !== APP_VERSION)) Store.put("meta", "app", { schema: SCHEMA, appVersion: APP_VERSION, updatedAt: nowISO() });
  } catch (e) { console.error(e); }
}
const countData = d => ["items", "workers", "customers", ...BUCKETED].reduce((a, c) => a + Object.keys((d && d[c]) || {}).length, 0);
function uploadBanner() {
  if (MODE !== "cloud" || !isMgr() || !localPending || localPending.hidden) return "";
  return `<div class="banner info">على الموبايل ده ${nf(localPending.count, 0)} سجل اتسجلوا قبل التحويل للسحابة${localPending.demo ? " (فيهم بيانات تجريبية)" : ""}. <button type="button" class="linkbtn" data-act="upload-local">ارفعهم للحساب</button> · <button type="button" class="linkbtn" data-act="skip-upload">مش دلوقتي</button> · <button type="button" class="linkbtn" data-act="never-upload">ماترفعهمش</button></div>`;
}
function uploadLocal() {
  if (!localPending) return;
  const d = localPending.data, ops = []; let n = 0;
  for (const c of [...PLAIN, ...BUCKETED]) Object.entries(d[c] || {}).forEach(([id, rec]) => {
    if (S[c].has(id)) return;
    ops.push({ op: "put", col: c, id, data: rec }); if (c !== "meta") n++;
  });
  openModal("رفع بيانات الموبايل", `<p>هيترفع <b>${nf(n, 0)}</b> سجل من الموبايل ده للحساب، ومعاهم سجل العمليات.</p>${localPending.demo ? `<p class="banner">الموبايل ده استخدم «البيانات التجريبية». لو السجلات دي كلها تجريبية اختار «ماترفعهمش».</p>` : ""}<p class="small muted">السجلات اللي موجودة على الحساب بالفعل مش هتتغير، والبيانات على الموبايل هتفضل زي ما هي.</p>`, {
    submitLabel: "رفع البيانات", noFocus: true,
    onSubmit: async () => {
      Store.bulk(ops); mergeAudit(d.audit);
      await Local.putKey("__uploaded", { at: nowISO(), count: n });
      localPending = null;
      audit("إضافة", "upload", "", `رفع ${n} سجل من الموبايل للسحابة`);
      toast(`تم رفع ${n} سجل`);
    }
  });
}

/* ================== Install prompt ================== */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; scheduleRender(); });
window.addEventListener("online", () => scheduleRender());
window.addEventListener("offline", () => scheduleRender());
window.addEventListener("appinstalled", () => { installPrompt = null; toast("تم تثبيت التطبيق"); scheduleRender(); });

/* ================== Event delegation ================== */
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if (g) { e.preventDefault(); go(g.dataset.go); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = b.dataset.id; const act = b.dataset.act;
  const H = {
    "backup": backupSheet, "reset": resetAll,
    "fs": () => { lsSet("petshome:fs", id); applyFontSize(); if (modalOpen) { $$(".fsize [data-act=fs]").forEach(x => x.setAttribute("aria-pressed", x.dataset.id === id)); } else render(); },
    "hide-onboard": () => { const st = Object.assign({}, settings(), { onboarded: true }); delete st.id; Store.put("meta", "settings", st); },
    "day-summary": () => shareOrCopy("ملخص النهارده", daySummaryText(today()), "اتنسخ الملخص، الصقه في واتساب"),
    "remind": () => { const c = S.customers.get(id); if (c) shareOrCopy("تذكير", reminderText(c, (custBalances().get(id) || {}).due || 0), "اتنسخت الرسالة"); },
    "new-supplier": () => supplierForm(), "edit-supplier": () => { const v = S.suppliers.get(id); if (v) supplierForm(v); },
    "supplier-pay": () => supplierPayForm(id), "supplier-st": () => supplierStatement(id),
    "account": accountSheet, "logout": signOutCloud,
    "upload-local": uploadLocal, "skip-upload": () => { if (localPending) localPending.hidden = true; render(); },
    "never-upload": () => confirmBox("عدم رفع بيانات الموبايل", "السجلات اللي على الموبايل ده مش هتترفع للحساب ومش هيتسأل عنها تاني. هتفضل محفوظة على الموبايل نفسه.", "تمام، ماترفعهمش", async () => { await Local.putKey("__uploaded", { at: nowISO(), skipped: true }); localPending = null; }),
    "pay-month": () => { payMonth = id; render(); },
    "pe-new": () => payEntryForm(id, b.dataset.emp),
    "edit-pe": () => { const p = S.payroll.get(id); if (p) payEntryForm(p.type, p.empId, p); },
    "del-pe": () => { const p = S.payroll.get(id); if (!p) return; confirmBox("حذف حركة مرتبات", `حذف ${esc(PAY_TYPES[p.type] ? PAY_TYPES[p.type].label : p.type)} ${money(p.amount)} — ${esc(wName(p.empId))} بتاريخ ${fmtDate(p.date)}؟`, "حذف", () => { Store.remove("payroll", id); audit("حذف", "payroll", id, `حذف ${PAY_TYPES[p.type] ? PAY_TYPES[p.type].short : p.type} ${money(p.amount)} — ${wName(p.empId)} بتاريخ ${fmtDate(p.date)}`); }); },
    "emp-st": () => empStatement(id, b.dataset.month),
    "salary": () => salaryForm(id),
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
    "edit-fin": () => { const x = S.finance.get(id); if (!x) return; if (x.kind === "supplierPay") supplierPayForm(x.supplierId, x); else financeForm(x.kind || "expense", x); },
    "del-fin": () => { const x = S.finance.get(id); if (!x) return; confirmBox("حذف", `حذف ${x.kind === "income" ? "إيراد" : x.kind === "supplierPay" ? "سداد لـ" + esc(supplierName(x.supplierId)) : "مصروف " + esc(x.category)} بمبلغ ${money(x.amount)}؟`, "حذف", () => { Store.remove("finance", id); audit("حذف", "finance", id, `حذف ${x.kind === "income" ? "إيراد" : x.kind === "supplierPay" ? "سداد مورد" : "مصروف"} ${x.category || supplierName(x.supplierId)} ${money(x.amount)} بتاريخ ${fmtDate(x.date)} (سجّله ${wName(x.by)})`); }); },
    "save-count": saveCount, "clear-count": () => { Object.keys(countDraft).forEach(k => delete countDraft[k]); render(); },
    "new-item": () => itemForm(), "edit-item": () => { const i = S.items.get(id); if (i) itemForm(i); },
    "new-worker": () => workerForm(), "edit-worker": () => { const w = S.workers.get(id); if (w) workerForm(w); },
    "account-form": () => accountForm(id),
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
  if (cloudConfigured()) {
    /* Cloud mode: the phone's own saved records stay untouched; they are offered for upload once. */
    MODE = "cloud";
    Local.snapInfo = r.ok ? await Local.getKey("__snapshot_info") : null;
    if (r.ok) {
      const n = countData(r.data), done = await Local.getKey("__uploaded"), demo = !!(r.data.meta && r.data.meta.settings && r.data.meta.settings.demo);
      if (n > 0 && !done) localPending = { data: r.data, count: n, demo };
    }
    try { const mod = await import("./backend.js"); B = mod.createBackend(window.PETSHOME_FIREBASE); }
    catch (e) { console.error(e); phase = "cloudfail"; render(); return; }
    phase = "ready";
    B.onAuth(u => {
      if (!u && Cloud.started) Cloud.stop();
      if (!u) cloudBooted = false;
      if (acctUnsub) { acctUnsub(); acctUnsub = null; }
      authUser = u; acct = undefined;
      if (u && u.email !== ADMIN_EMAIL) {
        /* Employee login: load its account; if the manager changes what it may do, restart the listeners. */
        acctUnsub = B.watchDoc("accounts", u.uid, d => {
          const before = acct; acct = d;
          if (Cloud.started && before !== undefined && JSON.stringify((before && before.perms) || {}) !== JSON.stringify((d && d.perms) || {})) Cloud.stop();
          render();
        }, err => { console.error(err); acct = null; render(); });
      }
      render();
    });
    render();
    return;
  }
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
window.PH = { version: APP_VERSION, get mode() { return MODE; }, _debug: { accountForm, get ACCOUNTS() { return ACCOUNTS; }, get acct() { return acct; }, isWorker, can, me, syncPeople, supplierBalances, supplierPayForm, setAttendance, daySummaryText, onboarding, waNumber, Cloud, payLedger, payRow, payrollMonth, salaryFor, payEntryForm, empStatement, salaryForm, uploadLocal, get localPending() { return localPending; }, S, Store, Local, go, me, balance, custBalances, orderPayState, moneySummary, allAudit, setPreset, rp, render, saveCount, countDraft, moveForm, orderForm, paymentForm, financeForm, workerForm, closeModal, stockSummary, seedDemo, backupData, importBackup, lastBy, monthReport, dataMonths, monthText } };
boot();
})();
