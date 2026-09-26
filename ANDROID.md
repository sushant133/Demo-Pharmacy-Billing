# Android app (Capacitor)

The Android app is a thin native shell around the deployed Next.js app.

This project is a full-stack Next.js server - Edge middleware, route handlers
and Mongoose - so there is no static bundle to ship inside the APK. The shell
loads `server.url` over https instead. The WebView's origin becomes the real
domain, which is what keeps the httpOnly session cookie behaving exactly as it
does in a browser: no CORS, no token plumbing, no second auth path.

`capacitor-shell/` is **not** the app. It holds one page, `offline.html`,
shown when the server cannot be reached.

## One-time setup

**JDK 21 is required.** Capacitor 8 compiles at source level 21; a system JDK
17 fails with `invalid source release: 21`. Android Studio bundles one:

```
setx JAVA_HOME "C:\Program Files\Android\Android Studio\jbr"
```

Then point the build at the URL the app should load. Edit `SERVER_URL` in
`capacitor.config.ts`, or set it per build:

```
set CAP_SERVER_URL=https://your-domain.vercel.app
npm run cap:sync
```

### Signing keystore

Create it once and back it up in two places. Losing this file means never
being able to update the app on Play under the same listing again.

```
keytool -genkey -v -keystore C:\keystores\pharmacy-counter-release.jks ^
  -alias pharmacy-counter -keyalg RSA -keysize 2048 -validity 10000
```

Copy `android/keystore.properties.example` to `android/keystore.properties`
and fill in the four values. Both the properties file and `*.jks` are
gitignored.

## Release checklist

1. Bump the version in **two** places, to the same number:
   - `android/app/build.gradle` - `versionCode` and `versionName`
   - `lib/android-release.ts` - `versionCode`, `versionName`, `notes`

   `versionCode` must be higher than any build Play has already seen. The
   copy in `lib/android-release.ts` is what tells tills already in the field
   that an update exists.

2. Deploy the web app first, so `/android-app-version.json` is live before
   anyone can install the build that reads it.

3. Build the bundle:

   ```
   npm run android:aab
   ```

   Output: `android/app/build/outputs/bundle/release/app-release.aab`

   To do it from the IDE instead: `npm run android:open`, then
   **Build > Generate Signed App Bundle / APK > Android App Bundle**.

4. Upload the `.aab` to Play Console > Closed testing > Create new release.

`npm run android:apk` produces a signed APK for sideloading onto a till for
testing; Play only accepts the `.aab`.

## What runs natively

| | Browser | Android app |
|---|---|---|
| Print sheet | `window.print()` | `SystemPrint` plugin → Android PrintManager |
| 80mm roll | Web Bluetooth | `@capacitor-community/bluetooth-le` |
| Splash | - | `@capacitor/splash-screen` |
| Alert notifications | - | `AlertNotify` plugin → WorkManager checks `/api/reports/alerts` every ~15 min and notifies on new expired/expiring/out-of-stock items |
| Back button | - | walks history, exits only at the root |
| Update prompt | - | `/android-app-version.json` vs installed build |

The Android WebView implements **neither** `window.print()` nor Web
Bluetooth - both fail silently, which on a till reads as a printer that has
stopped working. `components/bills/print-transport.ts` is the switch; it picks
the route the current shell supports, and everything above it is unchanged.

`lib/native.ts` reads the injected `window.Capacitor` global rather than
importing `@capacitor/core`, and every Capacitor package is behind a dynamic
import, so the browser bundle and server rendering are untouched.

## Bluetooth printing notes

`AndroidManifest.xml` declares `BLUETOOTH_SCAN` with
`neverForLocation`, so the app never asks for location - the pre-Android-12
permissions are capped at `maxSdkVersion="30"` for older phones.

Writes are chunked to 20 bytes with a 12ms pause. That is the BLE floor every
peripheral supports; a receipt takes about a second. If a specific printer
model turns out to negotiate a larger MTU, `CHUNK` in
`components/bills/print-bluetooth-native.ts` is the one number to raise.

## Icons and splash

The launch screen, its full-screen fallback and the adaptive-icon foreground
are rendered from `public/mantramed-logo.png` at every density:

```
npx tsx scripts/generate-android-splash.ts
```

The launch screen is drawn by the AndroidX SplashScreen API from two theme
attributes in `res/values/styles.xml` - `windowSplashScreenBackground` and
`windowSplashScreenAnimatedIcon` (`@drawable/splash_icon`). Do not put a
full-screen bitmap back on the launch theme's `android:background`: it is
stretched to the window's aspect ratio and distorts the logo.

Other sources live in `assets/`. To regenerate every density after changing them:

```
npx capacitor-assets generate --android --iconBackgroundColor "#0f766e" --splashBackgroundColor "#f1f5f9" --splashBackgroundColorDark "#0b1220"
```
