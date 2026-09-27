/*
  MantraMed service worker.

  What makes the browser offer "Install app", and a friendly page instead of
  the browser's dinosaur when the till loses its connection. Deliberately
  nothing more: every screen is live, per-pharmacy data behind a session
  cookie, so no page, API response or RSC payload is ever cached here - a
  cached bill or stock list would be wrong the moment it was stored, and on a
  shared device could be someone else's.

  Only the offline page and its logo are kept. Everything else goes straight
  to the network, exactly as it would with no worker installed.

  Registered by components/PwaRegister.tsx. Served uncached (next.config.ts)
  so a change here reaches every browser on its next visit; bump VERSION when
  the precached files change.
*/

const VERSION = "v1";
const CACHE = `mantramed-offline-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/mantramed-logo.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("mantramed-offline-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // The offline page's own logo: the network copy when there is one, the
  // precached one when there is not.
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname === "/mantramed-logo.png") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/mantramed-logo.png")) || Response.error()),
    );
    return;
  }

  // Only full page loads get the offline fallback. API calls, form posts,
  // client-side navigations and other assets are left entirely to the browser.
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL);
      return cached || Response.error();
    }),
  );
});
