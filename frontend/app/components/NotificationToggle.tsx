"use client";

import { useEffect, useState } from "react";
import { isPushSubscribed, isPushSupported, subscribeToPush, unsubscribeFromPush } from "@/lib/push";

const FAILURE_MESSAGES: Record<string, string> = {
  unsupported: "This browser doesn't support push notifications.",
  "not-configured": "Push notifications aren't set up on the server yet.",
  "permission-denied": "Notification permission was denied — check your browser's site settings to allow it.",
  "server-error": "Couldn't save the subscription — try again in a moment.",
  "browser-error": "Your browser couldn't complete the subscription — try again, or try a different browser.",
};

type NotificationToggleProps = {
  onNotify: (text: string) => void;
};

export default function NotificationToggle({ onNotify }: NotificationToggleProps) {
  // null = still checking current subscription state on mount, to avoid
  // a flash of the wrong label before we know.
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isPushSupported()) {
      setSubscribed(false);
      return;
    }
    isPushSubscribed().then(setSubscribed);
  }, []);

  if (!isPushSupported() || subscribed === null) return null;

  async function handleClick() {
    setLoading(true);
    try {
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
        onNotify("Notifications turned off.");
      } else {
        const result = await subscribeToPush();
        setSubscribed(result.ok);
        onNotify(result.ok ? "Notifications enabled — you'll get a push when an alert fires." : FAILURE_MESSAGES[result.reason]);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="text-sm font-medium text-neutral-400 hover:text-neutral-600 disabled:opacity-50 dark:hover:text-neutral-300"
    >
      {subscribed ? "Notifications on ✓" : "Enable notifications"}
    </button>
  );
}
