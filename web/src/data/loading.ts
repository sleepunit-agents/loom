import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react';

/** The enclosing desk or window counts mounted reads, including independent reads of the same query. */
export const DeskOpening = createContext(false);
export const LoadContext = createContext<(() => () => void) | undefined>(undefined);

export function usePendingRead(pending: boolean) {
  const start = useContext(LoadContext);
  useLayoutEffect(() => pending ? start?.() : undefined, [pending, start]);
}

export function useLoadCount() {
  const [count, setCount] = useState(0);
  const start = useCallback(() => {
    setCount(n => n + 1);
    return () => setCount(n => n - 1);
  }, []);
  return { busy: count > 0, start };
}
