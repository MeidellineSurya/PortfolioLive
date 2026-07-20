"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WSMessage } from "./types";

export type WebSocketReadyState = "connecting" | "open" | "closed";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function useWebSocket(url: string) {
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const [readyState, setReadyState] = useState<WebSocketReadyState>("connecting");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Distinguishes "the effect's cleanup closed this on purpose" (unmount,
  // or url change) from "the server dropped us" — only the latter should
  // trigger a reconnect.
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    function connect() {
      setReadyState("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
        setReadyState("open");
      };

      ws.onmessage = (event) => {
        try {
          setLastMessage(JSON.parse(event.data) as WSMessage);
        } catch {
          // Ignore malformed frames rather than crashing the connection.
        }
      };

      ws.onclose = () => {
        setReadyState("closed");
        if (unmountedRef.current) return;
        reconnectTimeoutRef.current = setTimeout(connect, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, MAX_RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        // onclose always follows onerror for a WebSocket; reconnect logic
        // lives there so it isn't scheduled twice.
        ws.close();
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [url]);

  const sendMessage = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  return { lastMessage, readyState, sendMessage };
}
