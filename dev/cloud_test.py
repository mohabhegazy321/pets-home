"""Cloud-mode test for Pets Home, run against dev/mock_backend.js (same interface and access rule as Firebase).

1. A phone uses the app in local mode and saves records (the brother's phone today).
2. Cloud settings are published. The phone shows sign-in; a wrong password fails; the farm account signs in.
3. The phone's saved records are offered for upload and every one of them reaches the cloud; the local copy stays intact.
4. New entries made in cloud mode are saved to the cloud and survive a reload (still signed in).
5. A second phone signs in to the same account and sees the same data; another account is refused.

Usage: python3 dev/cloud_test.py   (from the repo root; needs Playwright + Chrome; CHROME=/path if needed)
"""
import asyncio, json, os, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
PORT = int(os.environ.get("PORT", "8798"))
APP_FILES = ["index.html", "app.js", "sw.js", "manifest.webmanifest", "icons", "backend.js", "firebase-config.js"]
USERS = {"hegazy@petshome.local": "test-pass-123", "someone@petshome.local": "other-pass-1"}
DUMP_IDB = """() => new Promise(res => { const r = indexedDB.open("petshome-local"); r.onsuccess = () => { const db = r.result;
  const tx = db.transaction("kv", "readonly"), st = tx.objectStore("kv"), out = {}; const k = st.getAllKeys();
  k.onsuccess = () => { k.result.forEach(key => { const g = st.get(key); g.onsuccess = () => { out[key] = g.result; }; }); };
  tx.oncomplete = () => { db.close(); res(out); }; }; r.onerror = () => res(null); })"""
RECORD_COLS = ["items", "workers", "customers", "moves", "orders", "payments", "finance", "counts", "payroll"]

def cloud_records(mock):
    out = {c: dict(mock.get(c, {})) for c in ["meta", "items", "workers", "customers"]}
    for c in ["moves", "orders", "payments", "finance", "counts", "payroll"]: out[c] = {}
    for d in mock.get("ledger", {}).values():
        if d.get("type") in out: out[d["type"]].update(d.get("r") or {})
    return out

async def main():
    site = tempfile.mkdtemp(prefix="petshome-cloud-")
    for f in APP_FILES:
        src = os.path.join(ROOT, f)
        if os.path.isdir(src): shutil.copytree(src, os.path.join(site, f))
        else: shutil.copy(src, os.path.join(site, f))
    with open(os.path.join(site, "firebase-config.js"), "w") as fh:   # phone starts in local mode
        fh.write('window.PETSHOME_FIREBASE = { apiKey: "PASTE_API_KEY_HERE" };\n')
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1); url = f"http://localhost:{PORT}/"; fails = []
    def check(ok, msg):
        print(("  ok   " if ok else "  FAIL ") + msg)
        if not ok: fails.append(msg)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            A = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            pa = await A.new_page(); errs = []
            pa.on("pageerror", lambda e: errs.append("A: " + str(e)))
            D = lambda pg, js: pg.evaluate(f"(() => {{ const D = window.PH._debug; return {js}; }})()")
            # 1. local mode with real (non-demo) records
            await pa.goto(url); await pa.wait_for_timeout(1000)
            check(await pa.evaluate("window.PH.mode") == "local", "starts in local mode while firebase-config.js is a placeholder")
            await pa.fill("#w-name", "محمد"); await pa.click("#welcome button[type=submit]"); await pa.wait_for_timeout(300)
            await pa.evaluate("""() => { const D = window.PH._debug, t = new Date().toISOString().slice(0, 10);
              D.Store.put("items", "it1", { name: "ميل وورم", unit: "كجم", perPlate: 2, price: 150, priceBasis: "plate", minPlates: 5, active: true });
              D.Store.put("workers", "w1", { name: "أحمد", active: true, startMonth: t.slice(0, 7), salary: 3000, salaryHistory: [{ from: t.slice(0, 7), amount: 3000 }] });
              D.Store.put("customers", "c1", { name: "محل النيل", phone: "" });
              D.Store.put("moves", "m1", { type: "opening", itemId: "it1", plates: 20, qty: 40, date: t, note: "", by: "owner", at: new Date().toISOString() });
              D.Store.put("orders", "o1", { customerId: "c1", date: t, status: "delivered", lines: [{ itemId: "it1", plates: 3, qty: 6, price: 150, basis: "plate", total: 450 }], subtotal: 450, discount: 0, total: 450, paidNow: 200, note: "", by: "owner", no: "T-1", at: new Date().toISOString() });
              D.Store.put("payroll", "p1", { empId: "w1", type: "advance", amount: 200, date: t, note: "", by: "owner", at: new Date().toISOString() });
              D.Store.put("finance", "f1", { kind: "expense", category: "خامات", amount: 500, date: "2026-10-05", payType: "cash", note: "", by: "owner", at: "2026-10-05T10:00:00Z" }); }""")
            await pa.wait_for_timeout(800)
            local_before = await pa.evaluate(DUMP_IDB)
            n_local = sum(len(local_before.get(c) or {}) for c in RECORD_COLS)
            print(f"phone has {n_local} records saved locally")
            # 2. publish cloud settings
            shutil.copy(os.path.join(ROOT, "dev", "mock_backend.js"), os.path.join(site, "backend.js"))
            with open(os.path.join(site, "firebase-config.js"), "w") as fh:
                fh.write('window.PETSHOME_FIREBASE = { apiKey: "test-key", authDomain: "x", projectId: "x", appId: "x" };\n')
            await pa.evaluate("u => localStorage.setItem('__mockusers', JSON.stringify(u))", USERS)
            await pa.reload(); await pa.wait_for_timeout(1500)
            check(await pa.evaluate("window.PH.mode") == "cloud" and await pa.is_visible("#auth-form"), "after publishing cloud settings: one refresh shows the sign-in screen")
            await pa.fill("#a-user", "Hegazy"); await pa.fill("#a-pass", "wrong-pass"); await pa.click("#a-submit"); await pa.wait_for_timeout(400)
            check("غير صحيحة" in (await pa.inner_text("#a-err")), "wrong password is refused with a clear message")
            await pa.fill("#a-pass", USERS["hegazy@petshome.local"]); await pa.click("#a-submit"); await pa.wait_for_timeout(1200)
            check(await pa.locator('[data-act="upload-local"]').count() > 0, "signed in; empty account offers to upload the phone's records")
            # 3. upload
            await pa.click('[data-act="upload-local"]'); await pa.wait_for_timeout(300); await pa.click("#m-submit"); await pa.wait_for_timeout(1200)
            cloud = cloud_records(await pa.evaluate("JSON.parse(localStorage.getItem('__mockcloud') || '{}')"))
            missing = [f"{c}/{i}" for c in RECORD_COLS for i in (local_before.get(c) or {}) if i not in cloud[c]]
            changed = [f"{c}/{i}" for c in RECORD_COLS for i, v in (local_before.get(c) or {}).items() if i in cloud[c] and cloud[c][i] != v]
            check(not missing and not changed, f"all {n_local} phone records are in the cloud unchanged (missing {len(missing)}, changed {len(changed)})")
            check("settings" in cloud["meta"], "farm settings uploaded too")
            local_after = await pa.evaluate(DUMP_IDB)
            check(all(local_after.get(c) == local_before.get(c) for c in RECORD_COLS), "the phone's own local copy is untouched")
            shown = await D(pa, '({ bal: D.balance("it1").closing, due: D.custBalances().get("c1").due, owed: D.payRow("w1", new Date().toISOString().slice(0,7)).due })')
            check(shown == {"bal": 17, "due": 250, "owed": 2800}, f"app shows the same numbers from the cloud: {shown}")
            # 4. new entries go to the cloud and survive a reload
            await pa.evaluate("window.PH._debug.payEntryForm('advance', 'w1')"); await pa.wait_for_timeout(300)
            await pa.fill("#f-amount", "150"); await pa.dispatch_event("#f-amount", "input"); await pa.click("#m-submit"); await pa.wait_for_timeout(800)
            await pa.reload(); await pa.wait_for_timeout(1500)
            check(not await pa.is_visible("#auth-form"), "stays signed in after reopening")
            owed = await D(pa, 'D.payRow("w1", new Date().toISOString().slice(0,7)).due')
            check(owed == 2650, f"advance made in cloud mode is saved (owed now {owed}, expected 2650)")
            check(await pa.locator('[data-act="upload-local"]').count() == 0, "upload is not offered again")
            # 5. second phone, same account
            Bc = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
            pb = await Bc.new_page(); pb.on("pageerror", lambda e: errs.append("B: " + str(e)))
            await pb.goto(url); await pb.wait_for_timeout(300)
            await pb.evaluate("([u, c]) => { localStorage.setItem('__mockusers', JSON.stringify(u)); localStorage.setItem('__mockcloud', c); }", [USERS, await pa.evaluate("localStorage.getItem('__mockcloud')")])
            await pb.reload(); await pb.wait_for_timeout(1200)
            await pb.fill("#a-user", "hegazy"); await pb.fill("#a-pass", USERS["hegazy@petshome.local"]); await pb.click("#a-submit"); await pb.wait_for_timeout(1500)
            same = await D(pb, '({ bal: D.balance("it1").closing, owed: D.payRow("w1", new Date().toISOString().slice(0,7)).due, orders: D.S.orders.size })')
            check(same == {"bal": 17, "owed": 2650, "orders": 1}, f"second phone signed in to the same account sees the same data: {same}")
            await pb.evaluate("window.PH._debug && document.querySelector('[data-act=more]').click()"); await pb.wait_for_timeout(200)
            await pb.click('#modal-root [data-act="account"]'); await pb.wait_for_timeout(200); await pb.click('#modal-root [data-act="logout"]'); await pb.wait_for_timeout(600)
            await pb.fill("#a-user", "someone"); await pb.fill("#a-pass", USERS["someone@petshome.local"]); await pb.click("#a-submit"); await pb.wait_for_timeout(1200)
            check("ليس له صلاحية" in (await pb.inner_text("#app")), "a different account is refused (no farm data shown)")
            check(not errs, "no page errors" + ("" if not errs else ": " + "; ".join(errs)))
            await b.close()
    finally:
        srv.terminate(); shutil.rmtree(site, ignore_errors=True)
    print("RESULT:", "PASS" if not fails else f"FAIL ({len(fails)})")
    sys.exit(1 if fails else 0)

asyncio.run(main())
