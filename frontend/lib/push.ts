"use client";

import { authFetch } from "./auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// PushManager.subscribe's applicationServerKey wants raw bytes, not the
// base64url string the VAPID key is generated/shipped as (see
// backend/.env.example) — standard boilerplate conversion, no library
// pulled in just for this.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const bytes = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    bytes[i] = rawData.charCodeAt(i);
  }
  return bytes;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription !== null;
}

// Permission is requested here, not on page load — browsers expect the
// prompt to follow a real user gesture (this is called from a click
// handler), and auto-prompting on every visit is exactly the pattern
// most browsers actively discourage/may suppress.
export async function subscribeToPush(): Promise<boolean> {
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey || !isPushSupported()) return false;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const json = subscription.toJSON();
  const res = await authFetch(`${API_URL}/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  if (!res.ok) {
    // Don't leave the browser subscribed if the backend never learned
    // about it — that subscription would just be dead weight, never
    // receiving anything.
    await subscription.unsubscribe();
    return false;
  }
  return true;
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await authFetch(`${API_URL}/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`, { method: "DELETE" });
}
