// Cloud connection for Pets Home. While apiKey starts with "PASTE", the app runs in local mode
// (data only on the phone). With real values from the Firebase console it switches to cloud mode:
// sign-in with the farm account and live sync between devices.
// These values are not secret: access is protected by sign-in and the rules in firestore.rules.
window.PETSHOME_FIREBASE = {
  apiKey: "PASTE_API_KEY_HERE",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
