# Pets Home (local edition): install on the phone

This version runs entirely on one phone. There are no accounts and no database to set up, and it needs no internet after the first install. All records are saved on the phone itself.

The app has to be opened once from a web link so Chrome can install it. After that it opens from its own icon and works offline. Getting the link takes about 5 minutes with GitHub Pages (free).

## 1. Put it online (once)

1. Sign in to **github.com** (create a free account if needed) and create a new **public** repository named `pets-home`.
2. Click **Add file → Upload files**. Drag in **everything in this folder**, including the `icons` folder, and click **Commit**.
3. Go to **Settings → Pages**. Set source to **Deploy from a branch**, branch to `main`, folder to `/ (root)`, then click **Save**.
4. After about a minute the app is at **`https://YOUR-GITHUB-NAME.github.io/pets-home/`**.

**Keep this link permanent.** The phone's data belongs to this exact address. If you ever move to a different link, carry the data across with a backup file (see below).

## 2. Install on the Samsung

1. Open the link in **Chrome** on the phone.
2. Tap **⋮ → Install app** (or **Add to Home screen**, then **Install**).
3. Open **Pets Home** from the home screen. It runs full screen like a normal app, with or without internet.
4. Choose one:
   - **ابدأ**: enter the farm name and his name, and start with real data.
   - **جرّب ببيانات تجريبية أولاً**: loads a sample farm to explore first. When done, use **الإعدادات → مسح كل البيانات**, then start for real.

Long-pressing the app icon gives shortcuts: New order, Record production, New expense.

## Optional: a real APK file

Once the link works, go to **https://www.pwabuilder.com**, paste the link, and choose **Package for stores → Android → Download**. Install the APK on the phone (Android will ask to allow installing from this source). Use either the APK or the Chrome-installed app, not both. If you switch, move the data with a backup.

## Backups (important)

Data lives only on this phone. Uninstalling the app, clearing Chrome's data, or losing the phone erases it.

- Go to **المزيد → نسخة احتياطية → حفظ في Drive / واتساب** at least once a week.
- The dashboard shows a reminder when the last backup is more than 7 days old.
- To restore on a new or reset phone, install the app, then tap **عندي نسخة احتياطية، استرجعها** on the first screen. On a phone already in use, go to **نسخة احتياطية → استرجاع نسخة**.
- The same backup file will move everything into the online, multi-worker version later.

## What's in this version

Everything from the spec except worker logins:

- stock by plates
- daily production
- orders with automatic invoices (share to WhatsApp, print or save as PDF)
- customer accounts and credit
- expenses and other income
- physical counts with shortage and surplus
- reports, including P&L, customer statements and cash movement
- full audit log

Workers are a simple list of names. Pick **العامل المسؤول** on each entry, and the log and reports show who was responsible. Separate worker accounts and dashboards come with the online version.

## Updating the app

Updates are pushed to the GitHub repository. On the phone, just refresh or reopen the app while online. The farm's data stays on the phone through every update, and the app saves an automatic copy before a new version first runs. You can restore that copy from **المزيد → نسخة احتياطية**.
