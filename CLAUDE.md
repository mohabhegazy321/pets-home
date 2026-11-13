# Pets Home — project rules

Local, on-phone farm management app (PWA) for Moe's brother. Live site: https://mohabhegazy321.github.io/pets-home/ (GitHub Pages from `main`, root). Plain HTML/JS, no build step: `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`.

## Rule 1: never lose the data already on the phone

The farm's records live only in the phone's IndexedDB (`petshome-local` → store `kv`, one key per collection: `meta, items, workers, customers, moves, orders, payments, finance, counts, audit`). Every change must keep them intact:

- Never rename or delete the database, the store or a collection key, and never change the shape of saved records in place. Add new fields as optional (old records won't have them), and read with fallbacks.
- If saved data really must change shape: raise `SCHEMA` in `app.js` and add a step to `MIGRATIONS` that converts old records without dropping anything.
- Bump `APP_VERSION` (app.js) and `VERSION` (sw.js) on every release. The app takes an automatic on-phone snapshot of all data when it first runs a new version (restorable from the backup sheet).
- Keep the read-failure lock (`Local.init` → `phase = "readfail"`) and the `Local.canWrite` guard. The app must never start empty and save over unreadable data.
- Backups exported by any earlier version must still import.

## Before every push

1. `node --check app.js && node --check sw.js`
2. Run the upgrade test. It serves the version currently on `origin/main` with data in it, publishes the working tree over it, and checks that every saved record survives:
   `python3 dev/upgrade_test.py` (needs Playwright + Chromium; set `CHROME=/path/to/chrome` if it isn't at `/usr/bin/google-chrome`).
3. Commit to `main` and push. Pages redeploys in about a minute; the phone gets the update on refresh (network-first service worker).

## Conventions

- UI text is Egyptian Arabic, RTL, and phone-first. Money is EGP (`ج.م`) by default.
- Online sync with worker accounts exists separately (Firebase build) and is planned for later. Don't add network or account dependencies to this local edition.
