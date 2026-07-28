// Minimal service worker. It exists only to satisfy Chrome/Android's PWA
// installability criteria (a registered `fetch` handler is part of that
// checklist) and to give static assets a light cache-first speedup on
// repeat visits. Deliberately does nothing else: this app is
// WebSocket-driven live data (backend/websocket_manager.py), and caching
// API responses here would mean showing stale portfolio/price data as if
// it were live. WebSocket connections aren't `fetch` requests at all, so
// they're never seen by this handler regardless of what it does.

const CACHE_NAME = "portfoliolive-static-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Only same-origin static build output and this feature's own icon files
// are eligible for caching. Everything else — every REST call to the
// backend (a different origin: the Vercel-hosted frontend talks to a
// separate GCP-hosted backend), every WS upgrade, every navigation — is
// left completely alone: no respondWith() call at all, so the browser
// handles it exactly as if no service worker were installed.
function isCacheableStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || !isCacheableStaticAsset(url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    })
  );
});

// Push payload shape sent by backend/push_service.py:
// {"title": string, "body": string, "url": string}. Falls back to
// generic text if the payload is missing/malformed rather than throwing
// — a malformed push must still surface *something* to the user, not
// silently vanish.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Not JSON — show it anyway with a generic title rather than drop it.
  }
  const title = payload.title || "PortfolioLive";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an already-open tab rather than opening a duplicate one,
      // if one happens to already be showing the app.
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
