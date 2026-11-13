# Turning on cloud sync (Firebase, free)

Until this is done, the app keeps working in local mode on each phone. It takes about 10 minutes on a computer, once.

## 1. Create the project

1. Go to **https://console.firebase.google.com** and click **Create a project**. Name it `pets-home`. You can turn Google Analytics off.
2. Turn on sign-in: **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save**.
3. Create the farm account: **Authentication → Users → Add user**.
   - Email: `hegazy@petshome.local`
   - Password: the password you chose for the Hegazy account
4. Leave **Authentication → Settings → User actions → Enable create (sign-up)** ticked. The app needs it to make employee logins. A login made any other way gets no access, because the rules only let in the Hegazy account and logins the manager switched on in the app.

## 2. Create the database

1. Go to **Build → Firestore Database → Create database**.
2. For location, choose `europe-west1` (Belgium), which is close to Egypt. This can't be changed later.
3. Start in **production mode**.
4. Open the **Rules** tab. Replace everything with the contents of `firestore.rules` from this repository, then click **Publish**.

## 3. Send the connection settings

1. Click the gear icon, then **Project settings**. Under **Your apps**, click the web icon `</>`.
2. Register the app as `Pets Home`. Leave **Firebase Hosting** unticked.
3. Copy the `firebaseConfig` block it shows (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId) and send it to Claude. Claude puts it in `firebase-config.js` and publishes. These values aren't secret, because the rules only let the Hegazy account in.

## 4. On the phones

- **Mohamed's phone:** refresh the app and sign in with **Hegazy** and the password. The app offers to upload everything already saved on the phone. Tap **رفع البيانات** (upload). The phone keeps its own copy too.
- **Any other phone or laptop:** open the same link and sign in with the same account. It shows the same data, updated live.
- **No internet at the farm:** keep using the app normally. Entries upload automatically when the connection returns. Each new device needs internet for its first sign-in.

The password can be changed from **المزيد → حسابي** (More → My account).

## 5. Employee logins (from v4)

Do this once:

1. **Authentication → Settings → User actions**: tick **Enable create (sign-up)** and click **Save**.
2. **Firestore Database → Rules**: replace everything with the new `firestore.rules` from this repository and click **Publish**.

After that, Mohamed opens **المرتبات** (payroll) and taps an employee. Under **دخول للتطبيق** (app login) he chooses a username, a password and what the employee may do (production, orders, payments, expenses and so on). The app shows the login details with a WhatsApp button to send them.

- Employees never see salaries, payroll, the employee list or reports, and can't delete anything.
- To block someone, stop their login from the same place, or mark the employee as no longer working.
- A forgotten employee password can't be reset from the app. Stop that login and make a new username.
