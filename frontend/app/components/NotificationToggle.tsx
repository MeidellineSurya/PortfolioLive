"use client";

import { useEffect, useState } from "react";
import { isPushSubscribed, isPushSupported, subscribeToPush, unsubscribeFromPush } from "@/lib/push";

export default function NotificationToggle() {
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
      } else {
        const ok = await subscribeToPush();
        setSubscribed(ok);
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
