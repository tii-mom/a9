import { useEffect, useState } from 'react';

/** Current time, refreshed on its own interval. Only the component that calls it re-renders. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Renders format(secondsLeft) for an absolute deadline (ms since epoch).
 * Ticking lives in this leaf, so the page tree is not re-rendered every second (docs/31 §5.3).
 */
export function LiveCountdown({ targetMs, format }: { targetMs: number; format: (seconds: number) => string }) {
  const now = useNow(1000);
  return <>{format(Math.max(0, (targetMs - now) / 1000))}</>;
}
