// Stand-in for backend.js used by dev/cloud_test.py: same interface, data kept in localStorage ("__mockcloud"),
// and the same access rule as firestore.rules (only hegazy@petshome.local may read or write).
const DOMAIN = "petshome.local";
export const toEmail = u => { const s = String(u || "").trim().toLowerCase(); return s.includes("@") ? s : `${s}@${DOMAIN}`; };
export function createBackend() {
  const LS = "__mockcloud", US = "__mockusers", AS = "__mockauth";
  const load = () => JSON.parse(localStorage.getItem(LS) || "{}");
  const save = db => localStorage.setItem(LS, JSON.stringify(db));
  const col = (db, c) => db[c] || (db[c] = {});
  let current = JSON.parse(localStorage.getItem(AS) || "null");
  const authCbs = [], listeners = [];
  const allowed = () => !!current && current.email === "hegazy@petshome.local";
  const deny = () => { const e = new Error("Missing or insufficient permissions."); e.code = "permission-denied"; return e; };
  const emit = () => setTimeout(() => listeners.slice().forEach(l => l.emit()), 0);
  const fire = () => authCbs.forEach(cb => setTimeout(() => cb(current), 0));
  const api = {
    kind: "mock",
    onAuth(cb) { authCbs.push(cb); setTimeout(() => cb(current), 0); return () => {}; },
    async signIn(u, p) {
      const users = JSON.parse(localStorage.getItem(US) || "{}"), e = toEmail(u);
      if (users[e] !== p) { const er = new Error("bad"); er.code = "auth/invalid-credential"; throw er; }
      current = { uid: "uid-" + e, email: e }; localStorage.setItem(AS, JSON.stringify(current)); fire();
    },
    async signOut() { current = null; localStorage.removeItem(AS); fire(); },
    async changePassword(c, n) { const users = JSON.parse(localStorage.getItem(US) || "{}"); if (users[current.email] !== c) { const e = new Error(); e.code = "auth/invalid-credential"; throw e; } users[current.email] = n; localStorage.setItem(US, JSON.stringify(users)); },
    watch(c, onData, onErr, opts = {}) {
      const l = { emit: () => {
        if (!allowed()) return onErr(deny());
        onData(Object.entries(col(load(), c)).filter(([, d]) => !opts.since || d.date >= opts.since).map(([id, d]) => ({ id, data: JSON.parse(JSON.stringify(d)) })), false);
      } };
      listeners.push(l); setTimeout(l.emit, 0);
      return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    },
    async getOnce(c, id) { if (!allowed()) throw deny(); return col(load(), c)[id] || null; },
    async batchWrite(ops) {
      if (!allowed()) throw deny();
      const db = load();
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
      if (!allowed()) throw deny();
      const db = load(), d = col(db, "audit")[id] || Object.assign({ entries: [] }, base);
      Object.assign(d, base); d.entries = d.entries || [];
      entries.forEach(e => { if (!d.entries.some(x => JSON.stringify(x) === JSON.stringify(e))) d.entries.push(e); });
      col(db, "audit")[id] = d; save(db); emit();
    },
    async queryAudit(f, t) { return Object.entries(col(load(), "audit")).filter(([, d]) => d.date >= f && d.date <= t).map(([id, d]) => ({ id, data: d })); }
  };
  return api;
}
