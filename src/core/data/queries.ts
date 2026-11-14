import type Database from 'better-sqlite3';
import { and, createTableRelationsHelpers, getOperators, getTableName, is, Relations, type AnyColumn, SQL, sql } from 'drizzle-orm';
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { buildSchema } from 'drizzle-graphql';
import { GraphQLError, Kind, type GraphQLResolveInfo, type SelectionSetNode } from 'graphql/index.js';
import { schema, tables } from './schema.js';

type TableName = keyof typeof tables;
type Fields = Record<string, AnyColumn>;
type Where = SQL | ((fields: Fields, operators: ReturnType<typeof getOperators>) => SQL | undefined);
type ReadConfig = {
  where?: Where;
  with?: Record<string, ReadConfig | boolean | undefined>;
  [key: string]: unknown;
};

/** Required SQL predicates, keyed by application table name. Never use a JS row
 * filter here: the predicate must constrain filtering, sorting, pagination and
 * each connected read before SQLite returns anything. Identity/authentication
 * and choosing these predicates belong to the caller at the outside door.
 */
export type QueryVisibility = Partial<Record<TableName, (fields: Fields) => SQL>>;

/** Generate a read-only GraphQL schema from an explicit subset of the shared
 * tables. This is a query module, not an authenticated HTTP endpoint. Construct
 * one for a caller's SQL policy; do not share it across different identities.
 * Installed modules can explicitly supply `() => sql\`true\`` as their policy.
 * No table (including internal plumbing) is exposed by default. Every selected
 * table must have a predicate, and relations outside the subset are removed.
 */
export function dataQueries(client: Database.Database, options: {
  tables: readonly TableName[];
  visibility: QueryVisibility;
  relationsDepthLimit?: number;
}) {
  if (!options.tables.length) throw new Error('Select at least one query table');
  const depth = options.relationsDepthLimit ?? 2;
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new Error('Query relation depth must be between 0 and 3');
  const selected = new Set(options.tables);
  const readSchema: Record<string, AnySQLiteTable | Relations> = {};
  const names = new Map<string, TableName>();
  // Snapshot the functions: later mutation of the options object must not
  // silently change the authority of an already-built query schema.
  const visibility = { ...options.visibility };
  for (const name of selected) {
    if (!Object.hasOwn(tables, name)) throw new Error(`Unknown query table: ${name}`);
    if (typeof visibility[name] !== 'function') throw new Error(`Missing SQL visibility for ${name}`);
    readSchema[name] = tables[name];
    names.set(getTableName(tables[name]), name);
  }
  for (const [name, value] of Object.entries(schema)) {
    if (!is(value, Relations) || !names.has(getTableName(value.table))) continue;
    readSchema[name] = new Relations(value.table, helpers => Object.fromEntries(
      Object.entries(value.config(helpers)).filter(([, relation]) => names.has(getTableName(relation.referencedTable))),
    ));
  }
  const db = drizzle(client, { schema: readSchema });
  const relations = new Map<TableName, Record<string, TableName>>();
  for (const value of Object.values(readSchema)) {
    if (!is(value, Relations)) continue;
    relations.set(names.get(getTableName(value.table))!, Object.fromEntries(
      Object.entries(value.config(createTableRelationsHelpers(value.table))).map(([key, relation]) => [key, names.get(getTableName(relation.referencedTable))!]),
    ));
  }
  function constrain(name: TableName, input: ReadConfig | true): ReadConfig {
    const config = input === true ? {} : input;
    const predicate = visibility[name]!;
    return {
      ...config,
      where: (fields: Fields, operators: ReturnType<typeof getOperators>) => {
        const allowed = predicate(fields);
        // An accidental undefined from a policy must fail closed, never become
        // an unconstrained query through Drizzle's optional-where semantics.
        if (!is(allowed, SQL)) throw new Error(`SQL visibility required for ${name}`);
        const requested = typeof config.where === 'function' ? config.where(fields, operators) : config.where;
        // Drizzle recursively rewrites ALL Column chunks in a where SQL to
        // this relation alias, including unrelated columns inside subqueries.
        // A SQLWrapper defers rendering past that rewrite. fields are already
        // aliased by the relational builder; inner subquery tables stay intact.
        return and(sql`${{ getSQL: () => allowed }}`, requested);
      },
      with: config.with && Object.fromEntries(Object.entries(config.with).map(([key, nested]) => {
        if (!nested) return [key, nested];
        const target = relations.get(name)?.[key];
        if (!target) throw new Error(`Unknown query relation: ${name}.${key}`);
        return [key, constrain(target, nested)];
      })),
    };
  }
  // The generator captures findMany/findFirst while constructing resolvers.
  // Decorate only this private Drizzle instance. Both calls still execute the
  // library's relational query; there are no per-row resolvers or extra reads.
  for (const name of selected) {
    const query = (db.query as Record<string, {
      findMany(config: ReadConfig): unknown;
      findFirst(config: ReadConfig): unknown;
    }>)[name];
    const many = query.findMany.bind(query);
    const first = query.findFirst.bind(query);
    query.findMany = ((config: ReadConfig = {}) => many(constrain(name, config))) as typeof query.findMany;
    query.findFirst = ((config: ReadConfig = {}) => first(constrain(name, config))) as typeof query.findFirst;
  }
  const generated = buildSchema(db, { mutations: false, relationsDepthLimit: depth }).schema;
  for (const field of Object.values(generated.getQueryType()!.getFields())) {
    const resolve = field.resolve!;
    field.resolve = (source, args, context, info) => {
      rejectRelationAliases(info);
      return resolve(source, args, context, info);
    };
  }
  return generated;
}

/** drizzle-graphql 0.8.5 conflates relation aliases, using only one alias's
 * arguments. Refuse that unsupported shape instead of returning the wrong
 * rows. Root aliases and scalar aliases remain supported. Inspect fragments
 * too, before any SQL for this root field. */
function rejectRelationAliases(info: GraphQLResolveInfo) {
  const visited = new Set<string>();
  function check(set: SelectionSetNode | undefined) {
    for (const selection of set?.selections ?? []) {
      if (selection.kind === Kind.FIELD) {
        if (selection.selectionSet && selection.alias) {
          throw new GraphQLError('Nested relation aliases are not supported; use the relation field name');
        }
        check(selection.selectionSet);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        check(selection.selectionSet);
      } else if (!visited.has(selection.name.value)) {
        visited.add(selection.name.value);
        check(info.fragments[selection.name.value]?.selectionSet);
      }
    }
  }
  for (const node of info.fieldNodes) check(node.selectionSet);
}
