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

// Wraps fetch with the Authorization header and a single shared 401
// reaction (drop the stale/expired token, send the user back to login)
// so every call site doesn't need its own copy of that logic.
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401 && typeof window !== "undefined") {
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
