/**
 * Where the desktop installer is downloaded from.
 *
 * The installer is built from `desktop/` (see desktop/README.md) and uploaded
 * to a GitHub Release. The file name is kept the same on every release, so
 * the `latest/download` link always serves the newest one and nothing here
 * needs changing when a new version ships.
 *
 * The app itself loads the live site, so a normal deploy already reaches
 * desktop users - a new installer is only needed when `desktop/` changes.
 */
export const DESKTOP_RELEASE = {
  windowsUrl:
    "https://github.com/sushant133/Demo-Pharmacy-Billing/releases/latest/download/MantraMed-Setup.exe",
} as const;
