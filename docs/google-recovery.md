# Google login and recovery backups

This integration uses Firebase Authentication and the Google Drive API. It can
run on Firebase's no-cost Spark plan without Cloud Run, Cloud SQL, Cloud Functions,
or a billing account. Hosting can remain on the existing web server.

## Create the Google project

1. Create a project at <https://console.firebase.google.com/>. Keep its billing
   plan on **Spark**. Google Analytics is optional.
2. In **Project settings → General**, register a **Web app**. Copy the public Web
   app configuration into `web-wallet/.env.local`:

   ```dotenv
   VITE_FIREBASE_API_KEY=your-public-web-api-key
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project
   VITE_FIREBASE_APP_ID=your-web-app-id
   ```

   These are browser configuration values, not service-account credentials. Never
   put a service-account key or OAuth client secret in a `VITE_` variable.

3. In **Authentication → Sign-in method**, enable **Google** and choose a project
   support email.
4. In **Authentication → Settings → Authorized domains**, add the wallet's public
   hostname. For local development, also add `localhost` and `127.0.0.1`.
5. Open the same project in <https://console.cloud.google.com/> and enable the
   **Google Drive API** under **APIs & Services → Library**.
6. Under **Google Auth Platform**, complete Branding/Audience and add
   `https://www.googleapis.com/auth/drive.appdata` under Data Access. During
   testing, add the Google accounts you will use as test users. Complete the
   console's publishing requirements before wider release.
7. Use the Web OAuth client configured by Firebase's Google provider. Its
   authorized redirect URI is
   `https://your-project.firebaseapp.com/__/auth/handler`. Keep that Firebase
   auth domain unless you also configure a custom Firebase auth domain and update
   the wallet's Content Security Policy.
8. Rebuild the frontend (`npm run build` in `web-wallet`) and publish its `dist/`.
   The Google recovery panel appears only when all four configuration values
   exist. Open Settings, select **Continue with Google**, and grant app-data access.

This first integration does not need a Firestore database or security rules.
Shared-wallet coordination is a separate change.

## Backup behavior

The wallet supports two explicit choices:

- **Encrypt with a passphrase** (default): at least 12 characters. Encryption uses
  the existing authenticated backup format. Losing the passphrase prevents
  recovery of that copy; Google sign-in cannot reset it.
- **Save without encryption**: the recovery file contains wallet secrets in
  plaintext. Anyone able to read the file can access those secrets.

An empty passphrase never selects plaintext automatically. Both modes save the
complete wallet state: denomination proofs, backing preimages, funding recovery
data, pending operations and their exact requests/output secrets, and activity.
Tokens retain their backing deadlines even in backups.

After enabling automatic backups, wallet changes produce recovery copies in
Drive's hidden `appDataFolder`, accessible through this app. Each upload creates
a new copy, so a delayed upload cannot overwrite an earlier recovery file. The
restore picker lists the newest 20 copies. Copies remain in Drive until deleted
through the app's Google Drive data-management settings and consume the user's
Drive storage quota.

Automatic backups continue while navigating the wallet, but require the page to
remain open. The Google API token and encryption key stay in memory, and are
discarded on sign-out or page close. Reconnect Drive and unlock backups after
reopening; Drive also requires reconnection when its access token expires. A
failed upload leaves the wallet in browser storage and displays a retry message.
Successful local operations do not wait for Drive to become available.

Restore accepts downloaded files or Google Drive copies, detects protection from
the file, and requires an empty destination wallet. Encrypted files require their
passphrase. Restored claims are checked against the mint and their backing HTLCs.

Backups do **not** coordinate spending between devices. Running two restored
copies remains subject to bearer-token conflicts until shared-wallet
coordination is enabled. A Drive upload is a recovery copy, not a spend lock.

## Verification

Run `npm test`, `npm run build`, and
`npm run test:e2e -- --grep 'exports a real'` in `web-wallet`. Unit tests cover
Google authorization, Drive's app-data requests, encrypted compatibility,
plaintext validation, and session-key behavior. Browser tests export and restore
real funded wallets in both formats. Actual Google sign-in/Drive access requires
the project configuration and user consent described above.

References: [Firebase Spark plan](https://firebase.google.com/pricing),
[Google sign-in](https://firebase.google.com/docs/auth/web/google-signin),
[Drive app data](https://developers.google.com/workspace/drive/api/guides/appdata).
