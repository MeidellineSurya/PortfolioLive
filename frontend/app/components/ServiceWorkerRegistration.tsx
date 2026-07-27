"use client";

import { useEffect } from "react";

// Registers the static-asset-only service worker (public/sw.js) — a
// prerequisite for Chrome/Android's automatic "install app" prompt.
// Split into its own client component rather than making the whole root
// layout a client component just for this one effect.
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Not fatal — the app works identically without it, just without
      // the install-prompt eligibility and the static-asset cache.
    });
  }, []);

  return null;
}
