import type { Db } from '../db/index.js';
import { parseHouseholdDocument, type Household } from '../../household.js';
import { HouseholdRows } from './rows.js';

type Document = Record<string, unknown>;
interface Envelope {
  fields: Document;
  agents: string[];
  members?: string[];
}

/**
 * Lossless household metadata on a supplied connection. This adapter neither
 * opens/migrates a database nor selects a backend. The importer and daemon own
 * that decision; existing JSON callers remain unchanged until cutover is ready.
 * Unknown fields and omitted defaults survive for the clock/runtime export.
 */
export class HouseholdDatabase {
  constructor(private readonly db: Db) {}

  document(): Document | undefined {
    return this.db.transaction(() => {
      const envelope = new HouseholdRows<Envelope>(this.db, 'settings').get('household-envelope');
      if (!envelope) return undefined;
      const agents = new HouseholdRows<string>(this.db, 'agents');
      const members = new HouseholdRows<Document>(this.db, 'members');
      const required = <T>(value: T | undefined, id: string): T => {
        if (value === undefined) throw new Error(`missing household row: ${id}`);
        return value;
      };
      const out: Document = { ...envelope.fields, agents: envelope.agents.map(id => required(agents.get(id), id)) };
      if (envelope.members !== undefined) out.members = envelope.members.map(id => required(members.get(id), id));
      return out;
    })();
  }

  household(home: string): Household | null {
    const raw = this.document();
    return raw === undefined ? null : parseHouseholdDocument(home, raw);
  }

  /** Import/change transaction must include all other concerns and its receipt. */
  replace(home: string, raw: Document): void {
    if (!this.db.inTransaction) throw new Error('household replacement requires a transaction');
    // Validate before any row is changed; defaults belong to the parsed view,
    // never to the source document or the generated export.
    parseHouseholdDocument(home, raw);
    const fields = { ...raw };
    const agents = raw.agents as string[];
    delete fields.agents;
    const members = raw.members as Array<Document & { person: string }> | undefined;
    delete fields.members;
    this.sync(new HouseholdRows(this.db, 'agents'), agents.map(id => [id, id]));
    this.sync(new HouseholdRows(this.db, 'members'), (members ?? []).map(m => [m.person, m]));
    new HouseholdRows<Envelope>(this.db, 'settings').put('household-envelope', {
      fields, agents, ...(members === undefined ? {} : { members: members.map(m => m.person) }),
    });
  }

  change<T>(home: string, fn: (raw: Document) => T): T {
    return this.db.transaction(() => {
      const raw = this.document();
      if (!raw) throw new Error('household has not been imported');
      const result = fn(raw);
      this.replace(home, raw);
      return result;
    }).immediate();
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
