/**
 * MantraMed desktop shell (Electron).
 *
 * Same idea as the Android app (see capacitor.config.ts): the system is a
 * full-stack Next.js server, so the window loads the live deployment rather
 * than bundling it. Every deploy reaches desktop users on their next launch
 * or reload, with no new installer; one is only needed when this shell
 * itself changes.
 *
 * Point a build at another server with MANTRAMED_URL, e.g. for local testing:
 *   MANTRAMED_URL=http://localhost:3000 npm start
 */

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const APP_URL = (process.env.MANTRAMED_URL || "https://mantramed.tech").replace(/\/+$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;

/** Same-origin pages stay in the app; everything else goes to the browser. */
function isAppUrl(url) {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

// --- Window size and position, remembered between launches ------------------

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return { width: 1366, height: 820, maximized: true };
  }
}

function saveWindowState(win) {
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
    );
  } catch {
    // Not worth failing a quit over.
  }
}

// --- Offline fallback -------------------------------------------------------

function showOffline(win) {
  win.loadFile(path.join(__dirname, "offline.html"), {
    query: { url: APP_URL },
  });
}

// --- Bluetooth receipt printers ---------------------------------------------

/*
  The web app prints to an 80mm roll over Web Bluetooth. Chrome shows its own
  device chooser for that; Electron has none, and without a handler the
  request never resolves. Devices are reported a few at a time while the scan
  runs, so collect for a few seconds, then let the cashier pick one.
*/
function handleBluetooth(win) {
  let pending = null;

  win.webContents.on("select-bluetooth-device", (event, devices, callback) => {
    event.preventDefault();

    if (!pending) {
      pending = { callback, devices: new Map() };
      setTimeout(async () => {
        const current = pending;
        pending = null;
        const list = [...current.devices.values()];
        if (list.length === 0) {
          await dialog.showMessageBox(win, {
            type: "info",
            message: "No Bluetooth printer found",
            detail: "Turn the printer on, make sure Bluetooth is enabled on this computer, then try again.",
          });
          current.callback("");
          return;
        }
        const { response } = await dialog.showMessageBox(win, {
          type: "question",
          message: "Choose a printer",
          buttons: [...list.map((d) => d.deviceName || d.deviceId), "Cancel"],
          cancelId: list.length,
        });
        current.callback(response < list.length ? list[response].deviceId : "");
      }, 4000);
    }

    pending.callback = callback;
    for (const device of devices) pending.devices.set(device.deviceId, device);
  });
}

// --- Windows -----------------------------------------------------------------

function webPreferences() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
}

function wireNavigation(win) {
  // Bills and credit notes open in a new tab on the web; here, a new window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 900,
          height: 900,
          autoHideMenuBar: true,
          webPreferences: webPreferences(),
        },
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return; // the offline page
    if (!isAppUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.on("did-create-window", (child) => wireNavigation(child));
}

function createMainWindow() {
  const state = loadWindowState();

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1000,
    minHeight: 640,
    title: "MantraMed",
    backgroundColor: "#f1f5f9",
    show: false,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });

  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("close", () => saveWindowState(win));

  wireNavigation(win);
  handleBluetooth(win);

  win.webContents.on("did-fail-load", (_event, code, _desc, url, isMainFrame) => {
    // -3 is an aborted load (a redirect, a navigation replacing another).
    if (isMainFrame && code !== -3 && isAppUrl(url)) showOffline(win);
  });

  win.loadURL(APP_URL);
  return win;
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Home",
          accelerator: "CmdOrCtrl+H",
          click: (_item, win) => win && win.loadURL(APP_URL),
        },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: `About MantraMed ${app.getVersion()}`,
          click: (_item, win) =>
            dialog.showMessageBox(win, {
              type: "info",
              message: `MantraMed ${app.getVersion()}`,
              detail: `Connected to ${APP_ORIGIN}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Lifecycle -----------------------------------------------------------------

// One copy at a time: a second launch focuses the window already open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Lets the site tell it is running inside the desktop app.
    app.userAgentFallback = `${app.userAgentFallback} MantraMedDesktop/${app.getVersion()}`;
    buildMenu();
    mainWindow = createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
