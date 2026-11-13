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
APP_FILES = ["index.html", "app.js", "sw.js", "manifest.webmanifest", "icons", "backend.js", "firebase-config.js"]

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
    if is_cloud(site):
        return await cloud_upgrade(ref, site, new_version)
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
                got = await version_of(pg)
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
            mode = await pg.evaluate("window.PH && window.PH.mode")
            if mode == "cloud":
                # Cloud settings are published: the phone's own records stay on the phone untouched
                # (checked above) and are offered for upload after sign-in. Upload itself: dev/cloud_test.py.
                pend = await pg.evaluate("(() => { const p = window.PH._debug.localPending; return p ? p.count : 0; })()")
                n_rec = sum(len(before.get(c) or {}) for c in cols if c not in ("meta", "audit"))
                print(f"new version runs in cloud mode: {pend} phone records waiting to be offered for upload (expected {n_rec})")
                if pend != n_rec: fails.append(f"phone records not offered for upload ({pend} of {n_rec})")
                if errs: fails.append("page errors: " + "; ".join(errs))
                await b.close()
                return finish(fails, srv, site)
            # 4. the app shows the same numbers and can still save
            shown = await pg.evaluate("(() => { const D = window.PH._debug; return { orders: D.S.orders.size, probe: D.S.finance.get('upgrade-probe') && D.S.finance.get('upgrade-probe').amount }; })()")
            if shown["orders"] != len(before.get("orders") or {}) or shown["probe"] != 123.45: fails.append(f"app shows different data: {shown}")
            await pg.evaluate("""() => window.PH._debug.Store.put("finance", "upgrade-probe-2", { kind: "income", category: "أخرى", amount: 7, date: "2026-01-16", payType: "cash", note: "", by: "owner", at: "2026-01-16T10:00:00Z" })""")
            await pg.wait_for_timeout(600); await pg.reload(); await pg.wait_for_timeout(1500)
            saved = await pg.evaluate("!!window.PH._debug.S.finance.get('upgrade-probe-2')")
            if not saved: fails.append("new entries are not saved after the update")
            if errs: fails.append("page errors: " + "; ".join(errs))
            await b.close()
    except SystemExit:
        raise
    finally:
        srv.terminate(); shutil.rmtree(site, ignore_errors=True)
    finish(fails, None, None)

async def version_of(pg):
    """Version running in the page; tolerates the app reloading itself once when a new version takes over."""
    for _ in range(6):
        try: return await pg.evaluate("window.PH && window.PH.version")
        except Exception: await pg.wait_for_timeout(1500)
    return None

def is_cloud(dirpath):
    try: code = "\n".join(l for l in open(os.path.join(dirpath, "firebase-config.js"), encoding="utf-8") if not l.strip().startswith("//"))
    except FileNotFoundError: return False
    return not re.search(r'apiKey:\s*"PASTE', code)

MOCK_USERS = {"hegazy@petshome.local": "test-pass-123"}
def cloud_records(mock):
    out = {c: dict(mock.get(c, {})) for c in ["meta", "items", "workers", "customers"]}
    for d in mock.get("ledger", {}).values():
        if d.get("type"): out.setdefault(d["type"], {}).update(d.get("r") or {})
    out["audit"] = dict(mock.get("audit", {}))
    return out

async def cloud_upgrade(ref, site, new_version):
    """The live version is in cloud mode: run old → new against dev/mock_backend.js (same interface and access rule)
    and check that every record in the cloud is unchanged after the update."""
    mock = os.path.join(ROOT, "dev", "mock_backend.js")
    shutil.copy(mock, os.path.join(site, "backend.js"))
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1); url = f"http://localhost:{PORT}/"; fails = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            pg = await (await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)).new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(url); await pg.wait_for_timeout(500)
            await pg.evaluate("u => localStorage.setItem('__mockusers', JSON.stringify(u))", MOCK_USERS)
            await pg.reload(); await pg.wait_for_timeout(1200)
            await pg.fill("#a-user", "Hegazy"); await pg.fill("#a-pass", MOCK_USERS["hegazy@petshome.local"]); await pg.click("#a-submit"); await pg.wait_for_timeout(1500)
            if await pg.locator("#welcome").count():
                await pg.fill("#w-name", "محمد"); await pg.click("#welcome button[type=submit]"); await pg.wait_for_timeout(500)
            # 1. the cloud today: farm records of every kind, entered through the old version
            await pg.evaluate("""() => { const D = window.PH._debug, t = new Date().toISOString().slice(0, 10), m = t.slice(0, 7), at = new Date().toISOString();
              D.Store.put("items", "u-it", { name: "ميل وورم", unit: "كجم", perPlate: 2, price: 150, priceBasis: "plate", minPlates: 5, active: true });
              D.Store.put("workers", "u-w", { name: "أحمد", active: true, startMonth: m, salary: 3000, salaryHistory: [{ from: m, amount: 3000 }] });
              D.Store.put("customers", "u-c", { name: "محل النيل", phone: "0100" });
              D.Store.put("moves", "u-m", { type: "opening", itemId: "u-it", plates: 20, qty: 40, date: t, note: "", by: "owner", at });
              D.Store.put("orders", "u-o", { customerId: "u-c", date: t, status: "delivered", lines: [{ itemId: "u-it", plates: 3, qty: 6, price: 150, basis: "plate", total: 450 }], subtotal: 450, discount: 0, total: 450, paidNow: 200, note: "", by: "owner", no: "U-1", at });
              D.Store.put("payments", "u-p", { customerId: "u-c", orderId: "u-o", amount: 100, date: t, method: "نقدي", note: "", by: "owner", at });
              D.Store.put("finance", "u-f", { kind: "expense", category: "خامات", amount: 500, date: "2026-10-05", payType: "cash", note: "", by: "owner", at: "2026-10-05T10:00:00Z" });
              D.Store.put("payroll", "u-pr", { empId: "u-w", type: "advance", amount: 200, date: t, note: "", by: "owner", at });
              D.Store.put("counts", "u-k", { date: t, lines: [{ itemId: "u-it", system: 17, actual: 17, diff: 0 }], applied: true, by: "owner", at }); }""")
            await pg.wait_for_timeout(1000)
            before = cloud_records(await pg.evaluate("JSON.parse(localStorage.getItem('__mockcloud') || '{}')"))
            n_before = sum(len(v) for k, v in before.items() if k not in ("meta", "audit"))
            print(f"old version ({ref}, cloud mode): {n_before} records in the cloud")
            # 2. publish the new version (still talking to the stand-in cloud) and refresh
            publish_worktree(site); shutil.copy(mock, os.path.join(site, "backend.js"))
            got = None
            for attempt in range(3):
                await pg.reload(); await pg.wait_for_timeout(2500)
                got = await version_of(pg)
                if got == new_version: break
            print(f"refreshes needed to reach {new_version}: {attempt + 1} (running: {got})")
            if got != new_version: fails.append(f"new version did not load (running {got})")
            if await pg.locator("#auth-form").count(): fails.append("signed out by the update")
            # 3. every cloud record unchanged
            await pg.wait_for_timeout(800)
            after = cloud_records(await pg.evaluate("JSON.parse(localStorage.getItem('__mockcloud') || '{}')"))
            for c, recs in before.items():
                for rid, rec in recs.items():
                    now = after.get(c, {}).get(rid)
                    if c == "audit":
                        if not now or now.get("entries", [])[:len(rec.get("entries", []))] != rec.get("entries", []): fails.append(f"audit/{rid} changed")
                    elif c == "meta":
                        if rid == "app": continue
                        for k, v in rec.items():
                            if now is None or now.get(k) != v: fails.append(f"meta/{rid}.{k} changed")
                    elif now != rec: fails.append(f"{c}/{rid} changed or missing")
            shown = await pg.evaluate("(() => { const D = window.PH._debug; return { bal: D.balance('u-it').closing, owed: D.payRow('u-w', new Date().toISOString().slice(0,7)).due, orders: D.S.orders.size }; })()")
            print("app shows:", shown)
            if shown != {"bal": 17, "owed": 2800, "orders": 1}: fails.append(f"app shows different data: {shown}")
            snap = await pg.evaluate(DUMP_IDB)
            print("automatic snapshot on the phone:", (snap or {}).get("__snapshot", {}).get("info", {}).get("reason"))
            await pg.evaluate("""() => window.PH._debug.Store.put("finance", "u-f2", { kind: "income", category: "أخرى", amount: 7, date: "2026-01-16", payType: "cash", note: "", by: "owner", at: "2026-01-16T10:00:00Z" })""")
            await pg.wait_for_timeout(800)
            if "u-f2" not in cloud_records(await pg.evaluate("JSON.parse(localStorage.getItem('__mockcloud') || '{}')")).get("finance", {}): fails.append("new entries are not saved to the cloud after the update")
            if errs: fails.append("page errors: " + "; ".join(errs))
            await b.close()
    finally:
        srv.terminate(); shutil.rmtree(site, ignore_errors=True)
    finish(fails, None, None)

def finish(fails, srv, site):
    if srv: srv.terminate()
    if site: shutil.rmtree(site, ignore_errors=True)
    print("RESULT:", "PASS — all data kept" if not fails else "FAIL\n  " + "\n  ".join(fails))
    sys.exit(1 if fails else 0)

asyncio.run(main())
