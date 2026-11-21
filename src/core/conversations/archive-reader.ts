/** Queries used by the original Comms stores. A stopped snapshot and the import
 * fixtures use different SQLite drivers, but neither needs a write operation. */
export interface ArchiveReader {
  readonly readonly: boolean;
  prepare(sql: string): {
    get(...args: (string | number)[]): unknown;
    all(...args: (string | number)[]): unknown[];
    iterate(...args: (string | number)[]): Iterable<unknown>;
  };
}
