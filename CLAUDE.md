# Pets Home — project rules

Farm management app (PWA) for Moe's brother Mohamed. Live site: https://mohabhegazy321.github.io/pets-home/ (GitHub Pages from `main`, root). Plain HTML/JS, no build step: `index.html`, `app.js`, `sw.js`, `backend.js`, `firebase-config.js`, `manifest.webmanifest`, `icons/`. Dark theme only; money is always Egyptian pounds (`ج.م`), with no currency setting.

## Two storage modes

- **Local mode**: used while `firebase-config.js` still has the `PASTE_API_KEY_HERE` placeholder. Records live in the phone's IndexedDB (`petshome-local` → store `kv`, one key per collection).
- **Cloud mode**: used once `firebase-config.js` has real Firebase settings. Sign-in is the farm admin account (username `Hegazy` → `hegazy@petshome.local`). Firestore layout: `meta/items/workers/customers/suppliers` hold one document per record; `ledger/<type>_<YYYY-MM>` holds records under `r.<id>` for moves, orders, payments, finance, counts and payroll; `audit/<YYYY-MM-DD>` is `{ date, entries[] }`, append-only; `accounts/<uid>` is an employee login (`{workerId, name, username, perms, active}`); `meta/people` holds names employees may see. `firestore.rules` gives the admin everything and an employee only what their `accounts/<uid>` allows. Ledger documents carry `type`, and the app reads them with typed queries (`where type ==`), so rules can check access per type. `dev/mock_backend.js` mirrors these rules; change both together.
- No password is ever written into this repository or into memory (the repo is public). The admin account is created in the Firebase console; employee logins are created from the app (needs "Enable create (sign-up)" on in Firebase Auth).

## Rule 1: never lose the farm's data

- Never rename or delete the IndexedDB database, store or collection keys, or the Firestore collections and ledger layout. Never change the shape of saved records in place. Add new fields as optional, and read with fallbacks.
- If saved data really must change shape: raise `SCHEMA` in `app.js` and add a step to `MIGRATIONS` that converts old records without dropping anything. It runs in both modes; cloud tracks the schema in `meta/app`.
- Bump `APP_VERSION` (app.js) and `VERSION` (sw.js) on every release. On the first run of a new version, the app saves a full snapshot of the data into the phone's IndexedDB (`__snapshot`), restorable from the backup sheet.
- Keep the read-failure lock (`phase = "readfail"`) and the `Local.canWrite` guard. Cloud writes go through `Store.bulk`, which writes per record, never whole collections.
- In cloud mode, the phone's local records are never deleted. They're offered for upload once (`__uploaded` marks it done).
- The audit log is only ever appended to.
- Backups exported by any earlier version must still import.

## Before every push

1. `node --check app.js && node --check sw.js`
2. `python3 dev/upgrade_test.py`: takes the version on `origin/main` with data in it, publishes the working tree over it, and checks that every record survives.
3. `python3 dev/cloud_test.py`: local→cloud switch, upload of phone data, sign-in, a second device, refusal of other accounts, and employee logins with permissions (runs against `dev/mock_backend.js`).
4. `python3 dev/features_test.py`: start-here list, save message with undo, attendance, suppliers, WhatsApp reminder, day summary, text size, help, no sideways scroll at 390px. Screenshots go to `dev/shots/` (not committed); look at them after UI changes.
5. Commit to `main` and push. Pages redeploys in about a minute; phones update on refresh (network-first service worker).

## Conventions

- UI text is plain spoken Egyptian Arabic ("الأطباق اللي في الغرفة دلوقتي", not formal terms), RTL, and phone-first. Each screen and form opens with a one-sentence intro; save messages say what changed and offer تراجع (undo) via `saved(...)`. Wrap signed numbers with `sgn()` so +/− stays on the correct side.
- Payroll: `workers` carry `salaryHistory` (raises apply from a month). `payroll` entries have types `advance`, `deduct`, `absence`, `bonus` and `payout`. Each month's balance carries into the next. Advances and payouts count as the "مرتبات" expense on the day paid.
- Attendance writes payroll `absence` entries with the fixed id `att-<date>-<workerId>` (1 day = salary ÷ 30, half day `days: 0.5`); marking present removes it.
- Suppliers: a `finance` expense with `payType: "credit"` and `supplierId` adds to what's owed; a `finance` record with `kind: "supplierPay"` reduces it. Supplier payments are cash out but never an expense (the purchase already was).
- Roles: `isWorker()`/`isMgr()`/`can(perm)` gate screens, quick actions and listeners. Anything new that workers can reach needs a matching rule in `firestore.rules` and `dev/mock_backend.js`.
