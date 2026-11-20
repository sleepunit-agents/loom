import { getTableName } from 'drizzle-orm';
import { polymorphicReferences, immutableTables, expiringUniqueKeys, deletionMarkers } from './schema.js';

/** SQLite does not have polymorphic FKs. Generate equivalent reference guards
 * from the schema's declared kind/id targets, including parent delete/key edits.
 */
export function referenceStatements(): string[] {
  const q = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const statements = polymorphicReferences.flatMap(ref => {
    const child = getTableName(ref.table);
    const kind = 'kind' in ref ? ref.kind : undefined;
    const targets = Object.entries(ref.targets);
    const newValue = 'NEW.' + q(ref.id);
    const emptyIsAbsent = 'emptyIsAbsent' in ref;
    const present = `${newValue} IS NOT NULL${emptyIsAbsent ? ` AND ${newValue} <> ''` : ''}`;
    const statements = targets.flatMap(([tag, target]) => {
      const parent = getTableName(target);
      const match = kind ? ` AND ${q(kind)} = ${literal(tag)}` : '';
      const condition = kind ? `NEW.${q(kind)} = ${literal(tag)} AND ` : '';
      const prefix = `${child}_${ref.id}_${tag || 'member'}`;
      return [
        ...['INSERT', 'UPDATE'].map(event => `CREATE TRIGGER ${q(prefix + '_' + event.toLowerCase())} BEFORE ${event} ON ${q(child)} WHEN ${condition}${present} AND NOT EXISTS (SELECT 1 FROM ${q(parent)} WHERE id = ${newValue}) BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;`),
        ...['DELETE', 'UPDATE OF id'].map(event => `CREATE TRIGGER ${q(prefix + '_parent_' + event.split(' ')[0].toLowerCase())} BEFORE ${event} ON ${q(parent)} WHEN ${event === 'DELETE' ? '1' : 'OLD.id <> NEW.id'} AND EXISTS (SELECT 1 FROM ${q(child)} WHERE ${q(ref.id)} = OLD.id${match}) BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END;`),
      ];
    });
    // Optional kind/id pairs are absent together. A household owner has no id.
    if (kind) {
      const household = targets.some(([tag]) => tag === 'member') && ref.id === 'owner';
      const valid = `(${newValue} IS NULL AND NEW.${q(kind)} IS NULL)${household ? ` OR (${newValue} IS NULL AND NEW.${q(kind)} = 'household')` : ''} OR (${newValue} IS NOT NULL AND NEW.${q(kind)} IN (${targets.map(([tag]) => literal(tag)).join(', ')}))`;
      for (const event of ['INSERT', 'UPDATE']) statements.push(`CREATE TRIGGER ${q(child + '_' + ref.id + '_pair_' + event.toLowerCase())} BEFORE ${event} ON ${q(child)} WHEN NOT coalesce((${valid}), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END;`);
    }
    return statements;
  });
  for (const table of immutableTables) {
    const name = getTableName(table);
    for (const event of ['UPDATE', 'DELETE']) statements.push(`CREATE TRIGGER ${q(name + '_immutable_' + event.toLowerCase())} BEFORE ${event} ON ${q(name)} BEGIN SELECT RAISE(ABORT, 'permanent record cannot be edited'); END;`);
  }
  for (const rule of expiringUniqueKeys) {
    const table = q(getTableName(rule.table));
    const live = (prefix: string) => `${prefix}${q(rule.revoked)} IS NULL AND (${prefix}${q(rule.expires)} IS NULL OR julianday(${prefix}${q(rule.expires)}) > julianday(loom_now()))`;
    for (const event of ['INSERT', 'UPDATE']) statements.push(`CREATE TRIGGER ${q(getTableName(rule.table) + '_live_key_' + event.toLowerCase())} BEFORE ${event} ON ${table} WHEN ${live('NEW.')} AND EXISTS (SELECT 1 FROM ${table} WHERE ${q(rule.key)} = NEW.${q(rule.key)} AND ${q(rule.identity)} <> NEW.${q(rule.identity)} AND ${live('')}) BEGIN SELECT RAISE(ABORT, 'live label must be unique'); END;`);
  }
  for (const rule of deletionMarkers) {
    const name = getTableName(rule.table), table = q(name), marker = q(getTableName(rule.marker)), id = q(rule.identity);
    statements.push(`CREATE TRIGGER ${q(name + '_no_reuse')} BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${marker} WHERE ${id} = NEW.${id}) BEGIN SELECT RAISE(ABORT, 'deleted id cannot be reused'); END;`);
    statements.push(`CREATE TRIGGER ${q(name + '_fixed_id')} BEFORE UPDATE OF ${id} ON ${table} WHEN NEW.${id} <> OLD.${id} BEGIN SELECT RAISE(ABORT, 'id cannot be changed'); END;`);
    const copy = rule.copy.map(q);
    statements.push(`CREATE TRIGGER ${q(name + '_mark_deleted')} AFTER DELETE ON ${table} BEGIN INSERT OR IGNORE INTO ${marker} (${[id, ...copy, q(rule.at)].join(', ')}) VALUES (${[id, ...copy].map(c => 'OLD.' + c).join(', ')}, loom_now()); END;`);
  }
  return statements;
}
