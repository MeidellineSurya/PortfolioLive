"use client";

import { useEffect } from "react";

const AUTO_DISMISS_MS = 6000;

export type ToastMessage = {
  id: string;
  text: string;
};

type ToastStackProps = {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
};

export default function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }) {
  // Each toast owns its own dismiss timer rather than page.tsx tracking
  // timers for a list it doesn't otherwise need to know the lifecycle
  // of — keeps the "how long has this been visible" concern local to
  // the thing being timed.
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div className="flex max-w-sm items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      <span aria-hidden>🔔</span>
      <span className="flex-1">{toast.text}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
