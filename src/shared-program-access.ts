/** Schema-owned grant reader. A restricted token with no grants MUST return
 * empty lists, never undefined: the durable program marker outlives its grants.
 * Names are canonical shared table keys and registered piece.operation names.
 * This is trusted same-connection persistence, never request-supplied claims. */
export interface ProgramGrants { records: readonly string[]; operations: readonly string[] }
export type ProgramGrantReader = (fingerprint: string) => ProgramGrants | undefined;
export function programSnapshot(read: ProgramGrantReader, fingerprint: string): Readonly<ProgramGrants> | undefined {
  const value = read(fingerprint);
  if (!value) return;
  return Object.freeze({
    records: Object.freeze([...new Set(value.records)].sort()),
    operations: Object.freeze([...new Set(value.operations)].sort()),
  });
}
export const sameProgramGrants = (a: ProgramGrants | undefined, b: ProgramGrants | undefined) => JSON.stringify(a) === JSON.stringify(b);
