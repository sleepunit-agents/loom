import { useEffect, useState } from 'react';
/** A mounted tile can be hidden independently of its browser tab. */
export function useReadingVisible(visible = true): boolean {
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  return visible && pageVisible;
}
