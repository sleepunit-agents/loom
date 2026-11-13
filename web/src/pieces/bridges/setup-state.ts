import { useState } from 'react';

/** App-owned observations survive editor unmounts and keep removed creations removed. */
export function useSetupState(current: Map<string, string>, selected: string | undefined, saved: string | undefined) {
  const [known, setKnown] = useState(new Set<string>());
  const nextKnown = new Set([...known, ...current.keys(), ...(saved ? [saved] : [])]);
  if (nextKnown.size !== known.size) setKnown(nextKnown);
  const [guards, setGuards] = useState(new Map<string, { signature: string | null; stale: boolean }>());
  const next = new Map(guards);
  let changed = false;
  for (const [key, before] of guards) {
    const signature = current.get(key) ?? null;
    if (signature !== before.signature) {
      next.set(key, { signature, stale: true }); changed = true;
    }
  }
  if (selected && !next.has(selected)) {
    next.set(selected, { signature: current.get(selected) ?? null, stale: false }); changed = true;
  }
  if (changed) setGuards(next);
  return {
    known: nextKnown,
    stale: (key: string) => next.get(key)?.stale ?? false,
    reload: (key: string) => {
      const signature = current.get(key);
      if (signature !== undefined) setGuards(new Map(next).set(key, { signature, stale: false }));
    },
  };
}
