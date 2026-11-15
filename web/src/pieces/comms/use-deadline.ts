import { useEffect, useState } from 'react';
/** Schedule only the earliest retained deadline, then the next; no polling. */
export function useDeadline(values: readonly (string | null | undefined)[]): number {
  const [now, setNow] = useState(Date.now), key = JSON.stringify(values);
  useEffect(() => {
    const future = (JSON.parse(key) as (string | null)[]).map(at => Date.parse(at ?? '')).filter(at => Number.isFinite(at) && at > now);
    if (!future.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(1, Math.min(...future) - Date.now())));
    return () => clearTimeout(timer);
  }, [key, now]);
  return Math.max(now, Date.now());
}
