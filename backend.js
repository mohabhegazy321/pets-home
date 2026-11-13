// Pets Home — cloud backend (Firebase Auth + Firestore with an offline copy on the phone).
// Loaded only when firebase-config.js holds real settings. The app talks to the object returned by
// createBackend(); swapping this file is how dev/cloud_test.py runs the app against a fake cloud.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, doc, onSnapshot, setDoc, getDoc, getDocs, query, where, writeBatch,
  deleteField, arrayUnion, FieldPath
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Sign-in uses a username (e.g. "Hegazy"). Firebase needs an email, so usernames map to a private placeholder domain.
const DOMAIN = "petshome.local";
export const toEmail = u => {
  const s = String(u || "").trim().toLowerCase();
  return s.includes("@") ? s : `${s}@${DOMAIN}`;
};

export function createBackend(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  let db;
  try {
    db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: memoryLocalCache() });
  }
  const wrap = snap => snap.docs.map(d => ({ id: d.id, data: d.data() }));

  return {
    kind: "firebase",
    onAuth(cb) { return onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, email: u.email } : null)); },
    signIn(user, pass) { return signInWithEmailAndPassword(auth, toEmail(user), pass); },
    signOut() { return signOut(auth); },
    async changePassword(current, next) {
      const u = auth.currentUser;
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current));
      await updatePassword(u, next);
    },
    watch(col, onData, onErr, opts = {}) {
      let q = collection(db, col);
      if (opts.since) q = query(q, where("date", ">=", opts.since));
      return onSnapshot(q, snap => onData(wrap(snap), snap.metadata.fromCache), onErr);
    },
    async getOnce(col, id) { const s = await getDoc(doc(db, col, id)); return s.exists() ? s.data() : null; },
    // ops: { kind: "set", col, id, data } | { kind: "del", col, id }
    //      { kind: "bucket", bid, meta, id, data } (record inside ledger/<bid>) | { kind: "unbucket", bid, id }
    // Each ledger record is its own field, so two phones saving at the same time never overwrite each other.
    batchWrite(ops) {
      const commits = [];
      for (let i = 0; i < ops.length; i += 400) {
        const b = writeBatch(db);
        ops.slice(i, i + 400).forEach(o => {
          if (o.kind === "set") b.set(doc(db, o.col, o.id), o.data);
          else if (o.kind === "del") b.delete(doc(db, o.col, o.id));
          else if (o.kind === "bucket") b.set(doc(db, "ledger", o.bid), Object.assign({}, o.meta, { r: { [o.id]: o.data } }), { mergeFields: ["type", "month", new FieldPath("r", o.id)] });
          else if (o.kind === "unbucket") b.set(doc(db, "ledger", o.bid), { r: { [o.id]: deleteField() } }, { merge: true });
        });
        commits.push(b.commit());
      }
      return Promise.all(commits);
    },
    // Audit log: one document per day; entries are only ever appended.
    appendAudit(id, base, entry) { return setDoc(doc(db, "audit", id), Object.assign({}, base, { entries: arrayUnion(entry) }), { merge: true }); },
    appendAuditMany(id, base, entries) { return setDoc(doc(db, "audit", id), Object.assign({}, base, { entries: arrayUnion(...entries) }), { merge: true }); },
    async queryAudit(from, to) { return wrap(await getDocs(query(collection(db, "audit"), where("date", ">=", from), where("date", "<=", to)))); }
  };
}
