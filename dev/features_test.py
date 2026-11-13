"""Feature test for Pets Home (local mode, real browser): start-here checklist, save messages with undo,
attendance → absence deductions, suppliers (credit purchase + payment, not counted twice), WhatsApp reminder,
end-of-day summary, text size, help. Saves phone-size screenshots to dev/shots/.

Usage: python3 dev/features_test.py   (from the repo root; needs Playwright + Chrome; CHROME=/path if needed)
"""
import asyncio, os, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
PORT = int(os.environ.get("PORT", "8797"))
SHOTS = os.path.join(ROOT, "dev", "shots")

async def main():
    site = tempfile.mkdtemp(prefix="petshome-feat-")
    for f in ["index.html", "app.js", "sw.js", "manifest.webmanifest", "icons", "backend.js"]:
        src = os.path.join(ROOT, f)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(site, f))
    with open(os.path.join(site, "firebase-config.js"), "w") as fh: fh.write('window.PETSHOME_FIREBASE = { apiKey: "PASTE_API_KEY_HERE" };\n')
    os.makedirs(SHOTS, exist_ok=True)
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1); fails = []
    def check(ok, msg):
        print(("  ok   " if ok else "  FAIL ") + msg)
        if not ok: fails.append(msg)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            pg = await ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            D = lambda js: pg.evaluate(f"(() => {{ const D = window.PH._debug; return {js}; }})()")
            async def fill(sel, v): await pg.fill(sel, v); await pg.dispatch_event(sel, "input")
            async def submit(): await pg.click("#m-submit"); await pg.wait_for_timeout(250)
            shot = lambda n: pg.screenshot(path=os.path.join(SHOTS, n + ".png"))
            await pg.goto(f"http://localhost:{PORT}/"); await pg.wait_for_timeout(900)
            await pg.fill("#w-name", "محمد حجازي"); await pg.click("#welcome button[type=submit]"); await pg.wait_for_timeout(400)
            # start-here checklist
            steps = await pg.locator(".steps li").count()
            check(steps == 4 and "صباح الخير" in await pg.inner_text(".hello") or "مساء الخير" in await pg.inner_text(".hello"), "home greets by first name and shows the 4-step start-here list")
            await shot("01-home-first-run")
            await pg.click('.steps [data-act="new-item"]'); await pg.wait_for_timeout(250)
            await fill("#f-name", "ميل وورم"); await fill("#f-perPlate", "2"); await fill("#f-price", "150"); await submit()
            await pg.click('.steps [data-act="new-opening"]'); await pg.wait_for_timeout(250)
            check("مرة واحدة" in await pg.inner_text(".modal .intro"), "each form explains itself in a sentence")
            await fill("#f-plates", "10"); await submit()
            msg = await pg.inner_text("#toast")
            check("الرصيد بقى 10" in msg and await pg.locator("#toast-undo").count() == 1, f"save message says what changed, with undo: «{msg.splitlines()[0]}»")
            await shot("02-saved-with-undo")
            await pg.click("#toast-undo"); await pg.wait_for_timeout(300)
            item = await D("[...D.S.items.keys()][0]")
            check(await D(f'D.balance("{item}").closing') == 0, "undo removes the entry (stock back to 0)")
            await D('D.moveForm("opening")'); await pg.wait_for_timeout(200); await fill("#f-plates", "10"); await submit()
            done = await pg.inner_text(".onboard .hint")
            check("2 من 4" in done, f"checklist progresses ({done})")
            # employee + attendance
            await pg.click('.steps [data-act="new-worker"]'); await pg.wait_for_timeout(250)
            await fill("#f-name", "أحمد"); await fill("#f-salary", "3000"); await submit()
            emp = await D("[...D.S.workers.keys()][0]")
            await D('D.go("attendance")'); await pg.wait_for_timeout(250)
            await pg.click(f'[data-att="out"][data-id="{emp}"]'); await pg.wait_for_timeout(250)
            a1 = await D(f'(D.S.payroll.get("att-" + new Date().toISOString().slice(0,10) + "-{emp}") || {{}}).amount')
            await pg.click(f'[data-att="half"][data-id="{emp}"]'); await pg.wait_for_timeout(250)
            a2 = await D(f'(D.S.payroll.get("att-" + new Date().toISOString().slice(0,10) + "-{emp}") || {{}}).amount')
            await shot("03-attendance")
            await pg.click(f'[data-att="in"][data-id="{emp}"]'); await pg.wait_for_timeout(250)
            a3 = await D(f'D.payRow("{emp}", new Date().toISOString().slice(0,7)).absence')
            check(a1 == 100 and a2 == 50 and a3 == 0, f"attendance: absent deducts a day (100), half day 50, present removes it ({a1}, {a2}, {a3})")
            # suppliers: a credit purchase is the expense; paying it later is not a second expense
            await D('D.go("finance")'); await pg.wait_for_timeout(150)
            await pg.click('[data-act="new-expense"]'); await pg.wait_for_timeout(250)
            await fill("#f-amount", "1000"); await pg.select_option("#f-payType", "credit")
            await pg.select_option("#f-supplierId", "__new"); await pg.wait_for_timeout(100); await fill("#f-newSupplier", "مورد الردة"); await submit()
            sup = await D("[...D.S.suppliers.keys()][0]")
            await D(f'D.supplierPayForm("{sup}")'); await pg.wait_for_timeout(250)
            pre = await pg.input_value("#f-amount"); await fill("#f-amount", "400"); await submit()
            t = await D('(() => { const t = new Date().toISOString().slice(0,10); const m = D.moneySummary(t, t); const R = D.monthReport(t.slice(0,7)); return { owed: D.supplierBalances().get(Object.keys(Object.fromEntries(D.S.suppliers))[0]), expense: m.expense, cashOut: R.cashOut }; })()')
            check(pre == "1000" and t["owed"] == 600 and t["expense"] == 1000 and t["cashOut"] == 400, f"suppliers: owed 1000 → pay 400 → 600; expense counted once ({t})")
            await D('D.go("suppliers")'); await pg.wait_for_timeout(250); await shot("04-suppliers")
            # customer debt reminder on WhatsApp
            await D('D.go("customers")'); await pg.wait_for_timeout(150)
            await pg.click('[data-act="new-customer"]'); await pg.wait_for_timeout(200); await fill("#f-name", "محل النيل"); await fill("#f-phone", "01001234567"); await submit()
            await D('D.orderForm()'); await pg.wait_for_timeout(250)
            await pg.select_option("#f-customerId", label="محل النيل"); await fill('[data-line] [name=plates]', "2"); await submit(); await pg.wait_for_timeout(300)
            await D("D.closeModal()"); await D('D.go("customers")'); await pg.wait_for_timeout(250)
            href = await pg.get_attribute('a[href^="https://wa.me/"]', "href")
            check(bool(href) and href.startswith("https://wa.me/201001234567?text="), f"customer who owes gets a WhatsApp reminder link ({(href or '')[:40]}…)")
            await D('D.go("dashboard")'); await pg.wait_for_timeout(300)
            check(await pg.locator(".todo li").count() >= 2, "home lists what needs attention (customer debt, supplier dues)")
            await shot("05-home-attention")
            summ = await D("D.daySummaryText(new Date().toISOString().slice(0,10))")
            check("ملخص" in summ and "الرصيد في الغرفة" in summ and "مكسب النهارده" in summ, "end-of-day summary text is ready to send")
            # text size + help
            await pg.click('.tabbar [data-act="more"]'); await pg.wait_for_timeout(250); await shot("06-more")
            await pg.click('.fsize [data-act="fs"][data-id="1.25"]'); await pg.wait_for_timeout(100)
            fs = await pg.evaluate("getComputedStyle(document.documentElement).fontSize")
            check(fs == "20px", f"text size can be made bigger (now {fs})")
            await pg.click('#modal-root [data-go="help"]'); await pg.wait_for_timeout(250)
            check("كل يوم" in await pg.inner_text("#main"), "help page explains daily use")
            await shot("07-help")
            await pg.click('.fsize [data-act="fs"][data-id="1.12"]') if await pg.locator('.fsize').count() else None
            check(await pg.evaluate("document.documentElement.scrollWidth") <= 390, "nothing scrolls sideways at phone width")
            check(not errs, "no page errors" + ("" if not errs else ": " + "; ".join(errs)))
            await b.close()
    finally:
        srv.terminate(); shutil.rmtree(site, ignore_errors=True)
    print("RESULT:", "PASS" if not fails else f"FAIL ({len(fails)})")
    sys.exit(1 if fails else 0)

asyncio.run(main())
