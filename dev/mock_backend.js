// Stand-in for backend.js used by the dev tests: same interface, data kept in localStorage ("__mockcloud"),
// and the same access rules as firestore.rules (manager account = everything; employee logins = only what
// their accounts/<uid> document allows; nobody else = nothing).
const DOMAIN = "petshome.local";
const ADMIN = "hegazy@petshome.local";
export const toEmail = u => { const s = String(u || "").trim().toLowerCase(); return s.includes("@") ? s : `${s}@${DOMAIN}`; };
export function createBackend() {
  const LS = "__mockcloud", US = "__mockusers", AS = "__mockauth";
  const load = () => JSON.parse(localStorage.getItem(LS) || "{}");
  const save = db => localStorage.setItem(LS, JSON.stringify(db));
  const col = (db, c) => db[c] || (db[c] = {});
  let current = JSON.parse(localStorage.getItem(AS) || "null");
  const authCbs = [], listeners = [];
  const deny = () => { const e = new Error("Missing or insufficient permissions."); e.code = "permission-denied"; return e; };
  const emit = () => setTimeout(() => listeners.slice().forEach(l => l.emit()), 0);
  const fire = () => authCbs.forEach(cb => setTimeout(() => cb(current), 0));

  // ---- rules (mirror of firestore.rules) ----
  const admin = () => !!current && current.email === ADMIN;
  const acct = () => current && col(load(), "accounts")[current.uid];
  const member = () => { const a = acct(); return !!a && a.active === true; };
  const can = p => member() && !!((acct().perms || {})[p]);
  const sales = () => can("orders") || can("payments");
  const readType = t => ["moves", "orders", "counts"].includes(t) || (t === "payments" && sales()) || (t === "finance" && can("finance"));
  const writeType = t => (t === "moves" && (can("production") || can("withdraw") || can("count"))) || (t === "orders" && can("orders")) || (t === "payments" && sales()) || (t === "finance" && can("finance")) || (t === "counts" && can("count"));
  const canRead = (c, opts = {}, id) => {
    if (admin()) return true; if (!current) return false;
    if (c === "accounts") return id === current.uid;
    if (c === "meta" || c === "items") return member();
    if (c === "customers") return sales();
    if (c === "suppliers") return can("finance");
    if (c === "ledger") return member() && !!opts.type && readType(opts.type);
    if (c === "audit") return can("log");
    return false;
  };
  const canWrite = (o, db) => {
    if (admin()) return true; if (!member()) return false;
    if (o.kind === "set") return (o.col === "customers" && sales()) || (o.col === "suppliers" && can("finance"));
    if (o.kind === "del") return false;
    if (o.kind === "bucket") { const ex = col(db, "ledger")[o.bid]; return writeType(o.meta.type) && (!ex || !ex.type || ex.type === o.meta.type); }
    if (o.kind === "unbucket") { const ex = col(db, "ledger")[o.bid]; return !!ex && writeType(ex.type); }
    return false;
  };

  const api = {
    kind: "mock",
    onAuth(cb) { authCbs.push(cb); setTimeout(() => cb(current), 0); return () => {}; },
    async signIn(u, p) {
      const users = JSON.parse(localStorage.getItem(US) || "{}"), e = toEmail(u);
      if (!users[e] || users[e].pass !== p) { const er = new Error("bad"); er.code = "auth/invalid-credential"; throw er; }
      current = { uid: users[e].uid, email: e }; localStorage.setItem(AS, JSON.stringify(current)); fire();
    },
    async signOut() { current = null; localStorage.removeItem(AS); fire(); },
    async changePassword(c, n) { const users = JSON.parse(localStorage.getItem(US) || "{}"); if (users[current.email].pass !== c) { const e = new Error(); e.code = "auth/invalid-credential"; throw e; } users[current.email].pass = n; localStorage.setItem(US, JSON.stringify(users)); },
    async createAccount(u, p) {
      const users = JSON.parse(localStorage.getItem(US) || "{}"), e = toEmail(u);
      if (users[e]) { const er = new Error(); er.code = "auth/email-already-in-use"; throw er; }
      users[e] = { uid: "uid-" + e, pass: p }; localStorage.setItem(US, JSON.stringify(users)); return users[e].uid;
    },
    watchDoc(c, id, onData, onErr) {
      const l = { emit: () => { if (!canRead(c, {}, id)) return onErr(deny()); const d = col(load(), c)[id]; onData(d ? JSON.parse(JSON.stringify(d)) : null); } };
      listeners.push(l); setTimeout(l.emit, 0); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    },
    watch(c, onData, onErr, opts = {}) {
      const l = { emit: () => {
        if (!canRead(c, opts)) return onErr(deny());
        onData(Object.entries(col(load(), c)).filter(([, d]) => (!opts.since || d.date >= opts.since) && (!opts.type || d.type === opts.type)).map(([id, d]) => ({ id, data: JSON.parse(JSON.stringify(d)) })), false);
      } };
      listeners.push(l); setTimeout(l.emit, 0);
      return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    },
    async getOnce(c, id) { if (!canRead(c, {}, id)) throw deny(); return col(load(), c)[id] || null; },
    async batchWrite(ops) {
      const db = load();
      if (!ops.every(o => canWrite(o, db))) throw deny();
      ops.forEach(o => {
        if (o.kind === "set") col(db, o.col)[o.id] = o.data;
        else if (o.kind === "del") delete col(db, o.col)[o.id];
        else if (o.kind === "bucket") { const d = col(db, "ledger")[o.bid] || { r: {} }; Object.assign(d, o.meta); d.r = d.r || {}; d.r[o.id] = o.data; col(db, "ledger")[o.bid] = d; }
        else if (o.kind === "unbucket") { const d = col(db, "ledger")[o.bid]; if (d && d.r) delete d.r[o.id]; }
      });
      save(db); emit();
    },
    appendAudit(id, base, entry) { return api.appendAuditMany(id, base, [entry]); },
    async appendAuditMany(id, base, entries) {
      if (!admin() && !member()) throw deny();
      const db = load(), d = col(db, "audit")[id] || Object.assign({ entries: [] }, base);
      Object.assign(d, base); d.entries = d.entries || [];
      entries.forEach(e => { if (!d.entries.some(x => JSON.stringify(x) === JSON.stringify(e))) d.entries.push(e); });
      col(db, "audit")[id] = d; save(db); emit();
    },
    async queryAudit(f, t) { if (!canRead("audit")) throw deny(); return Object.entries(col(load(), "audit")).filter(([, d]) => d.date >= f && d.date <= t).map(([id, d]) => ({ id, data: d })); }
  };
  return api;
}
