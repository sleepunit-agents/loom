import { useContext, useEffect, useState } from 'react';
import { DeskMember } from '../signin/desk-member';
import { memberOperation } from '../data/operation';
import { Facts } from './entity-facts';
import type { EntityTarget } from './entities';

/** These owner-only records are served by machine operations. Recheck whenever the live machine or reader grants change. */
export function MachineAccess({ target, row }: { target: EntityTarget; row: Record<string, unknown> }) {
  const member = useContext(DeskMember);
  const [open, setOpen] = useState(target.part?.[0] === 'machine');
  const [revision, refresh] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: Record<string, unknown> }>();
  const key = JSON.stringify([member, row.id, row.owner, row.revokedAt, row.readers, revision]);
  const own = member === row.owner;
  useEffect(() => {
    if (!own || !open) return;
    let current = true;
    Promise.all([
      memberOperation<unknown[]>('machine.history', { machine: row.id }),
      row.revokedAt
        ? Promise.resolve([])
        : memberOperation<unknown[]>('machine.readerCards', { machine: row.id }),
    ]).then(
      ([history, requests]) => {
        if (current) setResult({ key, data: { history, requests } });
      },
      () => {
        if (current) setResult({ key });
      },
    );
    return () => {
      current = false;
    };
  }, [key, own, open]);
  if (!own) return null;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Read history and grant requests</summary>
      {open && (
        <>
          <button onClick={() => refresh((v) => v + 1)}>Refresh</button>
          {result?.key !== key ? (
            <p>Loading…</p>
          ) : result.data ? (
            <Facts row={result.data} section="machine" />
          ) : (
            <p>Machine access records unavailable.</p>
          )}
        </>
      )}
    </details>
  );
}
