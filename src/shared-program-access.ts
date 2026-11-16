/** Schema-owned grant reader. A restricted token with no grants MUST return
 * empty lists, never undefined: the durable program marker outlives its grants.
 * Names are canonical shared table keys and registered piece.operation names.
 * This is trusted same-connection persistence, never request-supplied claims. */
export interface ProgramGrants { records: readonly string[]; operations: readonly string[] }
export type ProgramGrantReader = (fingerprint: string) => ProgramGrants | undefined;
export function programSnapshot(read: ProgramGrantReader, fingerprint: string): Readonly<ProgramGrants> | undefined {
  const value = read(fingerprint);
  if (!value) return;
  return normalizeProgramGrants(value);
}
export function normalizeProgramGrants(value:ProgramGrants):Readonly<ProgramGrants>{
 return Object.freeze({records:Object.freeze([...new Set(value.records)].sort()),operations:Object.freeze([...new Set(value.operations)].sort())});
}
export const sameProgramGrants = (a: ProgramGrants | undefined, b: ProgramGrants | undefined) => JSON.stringify(a) === JSON.stringify(b);
/** Production read/write are synchronous SQLite operations on the token DB
 * connection, inside its current transaction. No Map, file, legacy fallback,
 * queued work or asynchronous writes: rollback must include marker and grants.
 * Explicit test ports do not prove persistence. Empty lists retain the marker;
 * callers publish committed writes. The writer completes before returning. */
export interface ProgramGrantStore {
  read: ProgramGrantReader;
  /** Synchronous, coherent batch used by owner setup; absent and empty differ. */
  readMany(fingerprints: readonly string[]): ReadonlyMap<string, Readonly<ProgramGrants>>;
  write(fingerprint:string, grants:ProgramGrants):undefined;
}
/** Reserved credential and grant-editor namespaces are never delegated.
 * Other domain lifecycle operations still use explicit grants and label policy. */
export const isReservedProgramOperation = (name:string) => ['signin','token','sessions','account','program'].includes(name.split('.')[0]);
