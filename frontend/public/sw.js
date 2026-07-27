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
// backend (a different origin in both dev and the intended Railway/Vercel
// deploy split), every WS upgrade, every navigation — is left completely
// alone: no respondWith() call at all, so the browser handles it exactly
// as if no service worker were installed.
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
