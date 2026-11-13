# Pets Home — project rules

Farm management app (PWA) for Moe's brother Mohamed. Live site: https://mohabhegazy321.github.io/pets-home/ (GitHub Pages from `main`, root). Plain HTML/JS, no build step: `index.html`, `app.js`, `sw.js`, `backend.js`, `firebase-config.js`, `manifest.webmanifest`, `icons/`. Dark theme only; money is always Egyptian pounds (`ج.م`), with no currency setting.

## Two storage modes

- **Local mode**: used while `firebase-config.js` still has the `PASTE_API_KEY_HERE` placeholder. Records live in the phone's IndexedDB (`petshome-local` → store `kv`, one key per collection).
- **Cloud mode**: used once `firebase-config.js` has real Firebase settings. Sign-in is the farm admin account (username `Hegazy` → `hegazy@petshome.local`). Firestore layout: `meta/items/workers/customers` hold one document per record; `ledger/<type>_<YYYY-MM>` holds records under `r.<id>` for moves, orders, payments, finance, counts and payroll; `audit/<YYYY-MM-DD>` is `{ date, entries[] }`, append-only. Access is locked to that account by `firestore.rules`.
- The account password is never written into this repository (it's public). The account is created in the Firebase console.

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
3. `python3 dev/cloud_test.py`: local→cloud switch, upload of phone data, sign-in, a second device, and refusal of other accounts (runs against `dev/mock_backend.js`).
4. Commit to `main` and push. Pages redeploys in about a minute; phones update on refresh (network-first service worker).

## Conventions

- UI text is Egyptian Arabic, RTL, and phone-first. Wrap signed numbers with `sgn()` so +/− stays on the correct side.
- Payroll: `workers` carry `salaryHistory` (raises apply from a month). `payroll` entries have types `advance`, `deduct`, `absence`, `bonus` and `payout`. Each month's balance carries into the next. Advances and payouts count as the "مرتبات" expense on the day paid.
- Employee logins and dashboards are planned. They will need per-user rules in `firestore.rules`.
