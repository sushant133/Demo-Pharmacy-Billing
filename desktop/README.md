# MantraMed desktop app

An Electron window around the live site (`https://mantramed.tech`). Every
deploy reaches desktop users on their next launch; a new installer is only
needed when files in this folder change.

## Build the Windows installer

```
cd desktop
npm install
npm run dist:win
```

Output: `desktop/dist/MantraMed-Setup.exe`

macOS (`npm run dist:mac`) must be built on a Mac; Linux with `npm run dist:linux`.

## Publish it

1. GitHub repo → **Releases → Draft a new release**, tag e.g. `desktop-v1.0.0`.
2. Upload `dist/MantraMed-Setup.exe` (keep that exact name).
3. Publish. The "Download the desktop app" button on the sign-in page links to
   `releases/latest/download/MantraMed-Setup.exe`, so it picks it up at once.

The repository must be **public** for that link to work for everyone.
Otherwise, host the file elsewhere and change `windowsUrl` in
`lib/desktop-release.ts`.

For a new release, bump `version` in `package.json` first.

## Try it against a local server

```
MANTRAMED_URL=http://localhost:3000 npm start
```

## Notes

- Windows shows a SmartScreen warning ("Windows protected your PC") for an
  unsigned installer. Users click **More info → Run anyway**. A code-signing
  certificate removes it.
- Printing uses the normal Windows print dialog (USB/network printers), and
  Bluetooth receipt printers work through a printer chooser.
