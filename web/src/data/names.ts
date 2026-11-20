import { useMemo } from 'react';
import { useDeskAgentDirectory } from '../pieces/attention/agent-directory';
/** Agents' display names by id, from the desk's shared directory (the same request the top bar makes). Empty until
 * it is read and where this viewer may not read it; a caller then falls back to the id (kit/words.ts). */
export function useAgentNames(): Readonly<Record<string, string>> {
  const directory = useDeskAgentDirectory();
  return useMemo(() => Object.fromEntries(directory.status === 'live' ? directory.records.map(row => [row.slug, row.name]) : []), [directory]);
}
