"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const TOKEN_KEY = "portfoliolive_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Wraps fetch with the Authorization header and a single shared
// not-authenticated reaction (drop any token, send the user back to
// login) so every call site doesn't need its own copy of that logic.
//
// Both 401 *and* 403 are treated as "not authenticated," not just 401:
// the backend's HTTPBearer() dependency (backend/main.py) returns 403
// specifically when the Authorization header is missing entirely, and
// only returns this app's own 401 for a token that's present but invalid
// or expired (documented in DECISION_LOG.md, commit 20 — noted there but
// not, originally, acted on here). A brand-new browser with no token yet
// hits exactly the 403 case on its very first request.
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if ((res.status === 401 || res.status === 403) && typeof window !== "undefined") {
    clearToken();
    window.location.href = "/login";
  }
  return res;
}

// Gates a page behind login. Returns false (render nothing, or a
// loading state) until confirmed there's a token. The check runs in an
// effect rather than directly during render for two reasons: Next.js
// renders this component's first pass on the server, where there's no
// token to find yet (`getToken` returns null there) — checking during
// render would either redirect based on that false negative or cause a
// hydration mismatch between server and client output; and `router`
// navigation needs to happen as a side effect, not synchronously mid-render.
export function useRequireAuth(): boolean {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [router]);

  return ready;
}
