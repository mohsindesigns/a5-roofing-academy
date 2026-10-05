import { useCallback, useEffect, useRef, useState } from 'react';

type Clock = () => number;

export interface ServerCountdown {
  /** Whole seconds left (rounded up), or null when the attempt is untimed. */
  remaining: number | null;
  /**
   * Adopt the server's remaining time. The server owns the deadline: call this with every
   * `timeRemainingSeconds` it returns so the display never drifts from it.
   */
  sync: (seconds: number | null) => void;
}

/**
 * Countdown that follows the server. It starts from the server's remaining seconds, ticks locally
 * (using the wall clock, which keeps counting while a laptop sleeps) and fires `onExpire` once
 * when it reaches zero. The server still enforces the deadline; this only drives the display and
 * the automatic submit.
 */
export function useServerCountdown(
  initialSeconds: number | null,
  onExpire: () => void,
  clock: Clock = Date.now,
): ServerCountdown {
  const deadline = useRef<number | null>(
    initialSeconds === null ? null : clock() + initialSeconds * 1000,
  );
  const [remaining, setRemaining] = useState<number | null>(initialSeconds);
  const fired = useRef(false);
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });

  const tick = useCallback(() => {
    if (deadline.current === null) {
      setRemaining(null);
      return;
    }
    const seconds = Math.max(0, Math.ceil((deadline.current - clock()) / 1000));
    setRemaining(seconds);
    if (seconds === 0 && !fired.current) {
      fired.current = true;
      expire.current();
    }
  }, [clock]);

  useEffect(() => {
    if (deadline.current === null) return;
    const id = setInterval(tick, 250);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tick]);

  const sync = useCallback(
    (seconds: number | null) => {
      deadline.current = seconds === null ? null : clock() + seconds * 1000;
      if (seconds !== null && seconds > 0) fired.current = false;
      tick();
    },
    [clock, tick],
  );

  return { remaining, sync };
}

/** Re-renders on an interval so relative times ("in 4 minutes") stay current. Returns epoch ms. */
export function useNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
