"""Upgrade safety test for Pets Home.

Serves the version on origin/main (what the phone currently has), fills it with data,
then publishes the working tree over it the way a GitHub Pages deploy would, refreshes
like the user does, and checks that every saved record is still there and still saves.

Usage:  python3 dev/upgrade_test.py            (run from the repo root)
Needs:  playwright (Python) and Chrome/Chromium; set CHROME to the browser binary if needed.
"""
import asyncio, json, os, re, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
PORT = int(os.environ.get("PORT", "8799"))
APP_FILES = ["index.html", "app.js", "sw.js", "manifest.webmanifest", "icons"]

def export_ref(ref, dest):
    """Write the app files as they are at a git ref into dest."""
    files = subprocess.run(["git", "-C", ROOT, "ls-tree", "-r", "--name-only", ref], capture_output=True, text=True, check=True).stdout.split()
    for f in files:
        if f.split("/")[0] not in APP_FILES: continue
        out = os.path.join(dest, f); os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as fh: fh.write(subprocess.run(["git", "-C", ROOT, "show", f"{ref}:{f}"], capture_output=True, check=True).stdout)

def publish_worktree(dest):
    for f in APP_FILES:
        src = os.path.join(ROOT, f)
        if os.path.isdir(src): shutil.copytree(src, os.path.join(dest, f), dirs_exist_ok=True)
        elif os.path.exists(src): shutil.copy(src, os.path.join(dest, f))

DUMP_IDB = """() => new Promise(res => { const r = indexedDB.open("petshome-local"); r.onsuccess = () => { const db = r.result;
  const tx = db.transaction("kv", "readonly"), st = tx.objectStore("kv"), out = {}; const k = st.getAllKeys();
  k.onsuccess = () => { k.result.forEach(key => { const g = st.get(key); g.onsuccess = () => { out[key] = g.result; }; }); };
  tx.oncomplete = () => { db.close(); res(out); }; }; r.onerror = () => res(null); })"""

async def main():
    ref = os.environ.get("OLD_REF", "origin/main")
    site = tempfile.mkdtemp(prefix="petshome-site-")
    export_ref(ref, site)
    new_version = re.search(r'const APP_VERSION = "([^"]+)"', open(os.path.join(ROOT, "app.js"), encoding="utf-8").read()).group(1)
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1); url = f"http://localhost:{PORT}/"; fails = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            pg = await ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            # 1. the phone today: old version with sample data plus a manual entry
            await pg.goto(url); await pg.wait_for_timeout(1200)
            await pg.click("#w-demo"); await pg.wait_for_timeout(800)
            await pg.evaluate("""() => { const D = window.PH._debug; D.Store.put("finance", "upgrade-probe", { kind: "expense", category: "أخرى", amount: 123.45, date: "2026-01-15", payType: "cash", note: "probe", by: "owner", at: "2026-01-15T10:00:00Z" }); }""")
            await pg.wait_for_timeout(800); await pg.reload(); await pg.wait_for_timeout(1200)
            before = await pg.evaluate(DUMP_IDB)
            cols = [k for k in before if not k.startswith("__")]
            n_before = sum(len(before[c] or {}) for c in cols)
            print(f"old version ({ref}): {n_before} records in {len(cols)} collections")
            # 2. publish the new version and refresh like the user does (at most twice)
            publish_worktree(site)
            got = None
            for attempt in range(3):
                await pg.reload(); await pg.wait_for_timeout(2500)
                got = await pg.evaluate("window.PH && window.PH.version")
                if got == new_version: break
            print(f"refreshes needed to reach {new_version}: {attempt + 1} (running: {got})")
            if got != new_version: fails.append(f"new version did not load (running {got})")
            # 3. every record from before is still saved, unchanged
            after = await pg.evaluate(DUMP_IDB)
            for c in cols:
                for rid, rec in (before[c] or {}).items():
                    now = (after.get(c) or {}).get(rid)
                    if c == "audit":
                        if not now or now.get("entries", [])[:len(rec.get("entries", []))] != rec.get("entries", []): fails.append(f"audit/{rid} changed")
                    elif c == "meta":
                        for k, v in rec.items():
                            if now is None or now.get(k) != v: fails.append(f"meta/{rid}.{k} changed")
                    elif now != rec: fails.append(f"{c}/{rid} changed or missing")
            if "__snapshot" in after:
                snap = after["__snapshot"]["data"]
                missing = [f"{c}/{rid}" for c in cols if c != "audit" for rid in (before[c] or {}) if rid not in (snap.get(c) or {})]
                print("automatic snapshot:", after["__snapshot"]["info"]["reason"], "| covers all old records:", not missing)
                if missing: fails.append(f"snapshot missing {len(missing)} records")
            # 4. the app shows the same numbers and can still save
            shown = await pg.evaluate("(() => { const D = window.PH._debug; return { orders: D.S.orders.size, probe: D.S.finance.get('upgrade-probe') && D.S.finance.get('upgrade-probe').amount }; })()")
            if shown["orders"] != len(before.get("orders") or {}) or shown["probe"] != 123.45: fails.append(f"app shows different data: {shown}")
            await pg.evaluate("""() => window.PH._debug.Store.put("finance", "upgrade-probe-2", { kind: "income", category: "أخرى", amount: 7, date: "2026-01-16", payType: "cash", note: "", by: "owner", at: "2026-01-16T10:00:00Z" })""")
            await pg.wait_for_timeout(600); await pg.reload(); await pg.wait_for_timeout(1500)
            saved = await pg.evaluate("!!window.PH._debug.S.finance.get('upgrade-probe-2')")
            if not saved: fails.append("new entries are not saved after the update")
            if errs: fails.append("page errors: " + "; ".join(errs))
            await b.close()
    finally:
        srv.terminate(); shutil.rmtree(site, ignore_errors=True)
    print("RESULT:", "PASS — all data kept" if not fails else "FAIL\n  " + "\n  ".join(fails))
    sys.exit(1 if fails else 0)

asyncio.run(main())
