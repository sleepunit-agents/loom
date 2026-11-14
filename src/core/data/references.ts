import { getTableName } from 'drizzle-orm';
import { polymorphicReferences } from './schema.js';

/** SQLite does not have polymorphic FKs. Generate equivalent reference guards
 * from the schema's declared kind/id targets, including parent delete/key edits.
 */
export function referenceStatements(): string[] {
  const q = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  return polymorphicReferences.flatMap(ref => {
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
}
