/**
 * The Android release the server expects installed devices to be on.
 *
 * Bump `versionCode` here in the same commit that bumps it in
 * `android/app/build.gradle`, then deploy. Installed apps poll
 * `/android-app-version.json` on launch and prompt when they are behind.
 *
 * `minimumVersionCode` is the oldest build still allowed to run. Raise it
 * only for a release that breaks older clients (an API shape change, say) -
 * it turns the prompt into a wall the cashier cannot dismiss.
 */
export const ANDROID_RELEASE = {
  versionCode: 5,
  versionName: "1.0.1",
  minimumVersionCode: 1,
  storeUrl: "https://play.google.com/store/apps/details?id=tech.mantramed",
  notes: "Sharper launch screen, faster start-up, and screens that fit every phone.",
} as const;

export type AndroidRelease = typeof ANDROID_RELEASE;
