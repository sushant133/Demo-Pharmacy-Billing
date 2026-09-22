/**
 * Runs before the site loads, isolated from it.
 *
 * Exposes only a read-only marker so the site can tell it is inside the
 * desktop app (to hide "Download the desktop app", for example). No Node or
 * Electron APIs reach the page.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("mantramedDesktop", {
  isDesktopApp: true,
  platform: process.platform,
});
