import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor shell for the Android build.
 *
 * This app is a full-stack Next.js server (middleware, route handlers,
 * Mongoose), so it cannot be exported to static files and bundled into the
 * APK. The shell therefore loads the live deployment over https and the
 * WebView's origin becomes the real domain - which is what keeps the
 * httpOnly session cookie working exactly as it does in a browser.
 *
 * `webDir` holds only the offline fallback shown when the server is
 * unreachable; it is never the app itself.
 */

// The deployment the app points at. Override for a staging build with:
//   CAP_SERVER_URL=https://staging.example.com npx cap sync android
const SERVER_URL = process.env.CAP_SERVER_URL ?? "https://mantramed.tech";

const config: CapacitorConfig = {
  /*
    The application id is the app's identity on the Play Store and cannot be
    changed without publishing a different app that installed copies have no
    upgrade path to. It is the product domain, mantramed.tech, reversed.
  */
  appId: "tech.mantramed",
  appName: "MantraMed",
  webDir: "capacitor-shell",
  server: {
    url: SERVER_URL,
    androidScheme: "https",
    // The bills screen and API are same-origin https; nothing should downgrade.
    cleartext: false,
    errorPath: "offline.html",
  },
  android: {
    allowMixedContent: false,
    // Bill screens are text-dense; let the system font scale through.
    useLegacyBridge: false,
  },
  plugins: {
    SplashScreen: {
      // Hidden by CapacitorBoot as soon as the remote page mounts; the
      // duration is only the ceiling for a slow or offline start.
      launchAutoHide: true,
      launchShowDuration: 3000,
      launchFadeOutDuration: 200,
      backgroundColor: "#ffffffff",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      androidSpinnerStyle: "small",
    },
  },
};

export default config;
