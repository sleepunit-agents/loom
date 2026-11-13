import type { Db } from '../db/index.js';
import { parseTokenDocument, type TokenPersistence, type TokenRecord } from '../../household.js';
import { HouseholdRows } from './rows.js';

type TokenDocument = ReturnType<typeof parseTokenDocument>;
interface Envelope { fields: Record<string, unknown>; digests: string[] }

/** Supplied connection only: no opening, migration, activation or JSON IO. */
export class TokenDatabase implements TokenPersistence {
  constructor(private readonly db: Db) {}

  /** Duplicate digests remain ordered: legacy resolution chooses the first live record. */
  records(digest: string): TokenRecord[] {
    return new HouseholdRows<TokenRecord[]>(this.db, 'tokens').get(digest) ?? [];
  }

  document(): TokenDocument | undefined {
    return this.db.transaction(() => {
      const envelope = new HouseholdRows<Envelope>(this.db, 'settings').get('token-envelope');
      if (!envelope) return undefined;
      const groups = new Map<string, TokenRecord[]>();
      const offsets = new Map<string, number>();
      const tokens = envelope.digests.map(digest => {
        if (!groups.has(digest)) groups.set(digest, this.records(digest));
        const index = offsets.get(digest) ?? 0;
        offsets.set(digest, index + 1);
        const record = groups.get(digest)![index];
        if (!record) throw new Error(`missing household token row: ${digest}/${index}`);
        return record;
      });
      return parseTokenDocument({ ...envelope.fields, tokens });
    })();
  }

  used(): Record<string, string> {
    return Object.fromEntries(new HouseholdRows<string>(this.db, 'token_use').entries());
  }

  /** Administrative view; authentication uses records(digest), never enumeration. */
  list(): TokenRecord[] {
    return this.db.transaction(() => {
      const used = this.used();
      return (this.document()?.tokens ?? []).map(({ last_used: _ignored, ...record }) =>
        used[record.sha256] ? { ...record, last_used: used[record.sha256] } : record);
    })();
  }

  /** Caller transaction includes all imported concerns and the cutover receipt. */
  replace(raw: unknown, used: Record<string, string>): void {
    if (!this.db.inTransaction) throw new Error('token replacement requires a transaction');
    const doc = parseTokenDocument(raw);
    if (Object.values(used).some(value => typeof value !== 'string')) throw new Error('token usage must contain strings');
    const groups = new Map<string, TokenRecord[]>();
    for (const record of doc.tokens) {
      const group = groups.get(record.sha256) ?? [];
      group.push(record); groups.set(record.sha256, group);
    }
    this.sync(new HouseholdRows<TokenRecord[]>(this.db, 'tokens'), [...groups]);
    this.sync(new HouseholdRows<string>(this.db, 'token_use'), Object.entries(used));
    const { tokens, ...fields } = doc;
    new HouseholdRows<Envelope>(this.db, 'settings').put('token-envelope', { fields, digests: tokens.map(t => t.sha256) });
  }

  change<T>(fn: (tokens: TokenRecord[]) => T): T {
    return this.db.transaction(() => {
      const doc = this.document();
      if (!doc) throw new Error('tokens have not been imported');
      const result = fn(doc.tokens);
      // As with legacy saveTokens, usage belongs exclusively to token_use.
      doc.tokens = doc.tokens.map(({ last_used: _ignored, ...record }) => record);
      this.replace(doc, this.used());
      return result;
    }).immediate();
  }

  touch(digest: string, when: string): void {
    new HouseholdRows<string>(this.db, 'token_use').put(digest, when);
  }

  private sync<T>(rows: HouseholdRows<T>, next: Array<[string, T]>): void {
    const before = new Map(rows.entries());
    for (const [id, value] of next) {
      if (!before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(value)) rows.put(id, value);
      before.delete(id);
    }
    for (const id of before.keys()) rows.remove(id);
  }
}
