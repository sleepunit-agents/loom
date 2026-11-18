import type Database from 'better-sqlite3';
import { taskShelved } from './project-in-use.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, createTableRelationsHelpers, getOperators, getTableColumns, getTableName, is, Relations, type AnyColumn, SQL, sql } from 'drizzle-orm';
import { alias, type AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { buildSchema } from 'drizzle-graphql';
import { GraphQLError, GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLString, GraphQLNonNull, GraphQLSkipDirective, GraphQLIncludeDirective, getDirectiveValues, getNamedType, isObjectType, Kind, type GraphQLResolveInfo, type SelectionSetNode } from 'graphql/index.js';
import { schema, tables, taskComments, taskLinks, tasks } from './schema.js';

type TableName = keyof typeof tables;
type Fields = Record<string, AnyColumn>;
type Where = SQL | ((fields: Fields, operators: ReturnType<typeof getOperators>) => SQL | undefined);
type ReadConfig = {
  where?: Where;
  with?: Record<string, ReadConfig | boolean | undefined>;
  [key: string]: unknown;
};
// One context carrier, with independent stores for concurrent root resolvers.
// dataQueries is also constructed per HTTP request; do not allocate hook
// instances that would need a later disable() for each generated schema.
const querySelection = new AsyncLocalStorage<GraphQLResolveInfo>();

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
  const readiness = (fields: Fields) => {
    const blocker = alias(tasks, 'data_ready_blocker');
    // A shelved task is not ready: its project is retired (project-in-use.ts, `taskShelved`).
    return sql`${fields.status} = 'open' and ${fields.type} <> 'epic' and not ${taskShelved({ status: fields.status, project: fields.project })} and not exists (select 1 from ${taskLinks} inner join ${tasks} as ${sql.identifier("data_ready_blocker")} on ${blocker.id} = ${taskLinks.dependsOn} where ${taskLinks.task} = ${fields.id} and ${taskLinks.type} = 'blocks' and ${blocker.status} <> 'closed')`;
  };
  function constrain(name: TableName, input: ReadConfig | true, sets = querySelection.getStore()?.fieldNodes.flatMap(node => node.selectionSet ? [node.selectionSet] : []) ?? [], root = true): ReadConfig {
    const config = input === true ? {} : input;
    const predicate = visibility[name]!;
    const fieldsSelected = selectedFields(sets, querySelection.getStore()!);
    return {
      ...config,
      ...(name === 'tasks' && (fieldsSelected.has('isReady') || fieldsSelected.has('isShelved') || selected.has('taskComments') && fieldsSelected.has('commentCount')) ? {
        extras: (fields: Fields) => {
          const extras: Record<string, SQL.Aliased> = {};
          if (fieldsSelected.has('isReady')) {
            const ready = readiness(fields);
            extras.isReady = sql`${{ getSQL: () => ready }}`.mapWith(Boolean).as('data_is_ready');
          }
          if (fieldsSelected.has('isShelved')) {
            const shelved = taskShelved({ status: fields.status, project: fields.project });
            extras.isShelved = sql`${{ getSQL: () => shelved }}`.mapWith(Boolean).as('data_is_shelved');
          }
          if (selected.has('taskComments') && fieldsSelected.has('commentCount')) {
            const allowed = visibility.taskComments!(getTableColumns(taskComments));
            if (!is(allowed, SQL)) throw new Error('SQL visibility required for taskComments');
            const count = sql`(select count(*) from ${taskComments} where ${taskComments.task} = ${fields.id} and ${allowed})`;
            extras.commentCount = sql`${{ getSQL: () => count }}`.mapWith(Number).as('data_comment_count');
          }
          return extras;
        },
      } : {}),
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
        // Readiness is a property of the visible task, not of the subset of
        // blockers the caller can read. Never return hidden blocker rows/IDs.
        const ready = root && name === 'tasks' && querySelection.getStore()?.fieldName === 'readyTasks'
          ? readiness(fields) : undefined;
        return and(sql`${{ getSQL: () => allowed }}`, ready ? sql`${{ getSQL: () => ready }}` : undefined, requested);
      },
      with: config.with && Object.fromEntries(Object.entries(config.with).map(([key, nested]) => {
        if (!nested) return [key, nested];
        const target = relations.get(name)?.[key];
        if (!target) throw new Error(`Unknown query relation: ${name}.${key}`);
        return [key, constrain(target, nested, fieldsSelected.get(key) ?? [], false)];
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
  // Relation output types are distinct generated objects. Walk their actual
  // edges rather than guessing type names or defining a second task shape.
  const visited = new Set<object>();
  function addCounts(name: TableName, output: ReturnType<typeof getNamedType>) {
    if (!output || !isObjectType(output) || visited.has(output)) return;
    visited.add(output);
    const fields = output.getFields();
    // drizzle-graphql returns SQLite JSON arrays intact but declares them as scalar strings.
    if (name === 'triggers' || name === 'jobs' || name === 'agentRunSettings' || name === 'boxes') {
      for (const key of name === 'triggers' ? ['needs', 'prefers'] : name === 'boxes' ? ['readers'] : ['prefers']) {
        fields[key].type = new GraphQLList(new GraphQLNonNull(GraphQLString));
      }
    }
    if (name === 'tasks') fields.isReady = {
      name: 'isReady', type: new GraphQLNonNull(GraphQLBoolean), args: [],
      description: 'Open non-epic task with no unclosed blocker, computed in this SQL statement.',
      resolve: row => row.isReady,
      extensions: {}, astNode: undefined, deprecationReason: undefined,
    };
    if (name === 'tasks') fields.isShelved = {
      name: 'isShelved', type: new GraphQLNonNull(GraphQLBoolean), args: [],
      description: 'Unfinished task of a retired project: kept as it is, and not work until the project is revived. Computed in this SQL statement.',
      resolve: row => row.isShelved,
      extensions: {}, astNode: undefined, deprecationReason: undefined,
    };
    if (name === 'tasks' && selected.has('taskComments')) fields.commentCount = {
      name: 'commentCount', type: new GraphQLNonNull(GraphQLInt), args: [],
      description: 'Number of visible comments on this task, counted in the same SQL statement.',
      resolve: row => row.commentCount,
      extensions: {}, astNode: undefined, deprecationReason: undefined,
    };
    for (const [key, target] of Object.entries(relations.get(name) ?? {})) {
      if (fields[key]) addCounts(target, getNamedType(fields[key].type));
    }
  }
  for (const name of selected) for (const key of [name, `${name}Single`]) {
    addCounts(name, getNamedType(generated.getQueryType()!.getFields()[key].type));
  }
  const rootFields = generated.getQueryType()!.getFields();
  // Reuse the generator's Tasks shape and arguments; this is another SQL
  // selection of the same table, not a separately maintained row definition.
  if (selected.has('tasks')) rootFields.readyTasks = { ...rootFields.tasks, name: 'readyTasks',
    description: 'Visible open non-epic tasks with no unclosed blocker, none of them shelved, filtered in SQL before pagination.' };
  for (const field of Object.values(rootFields)) {
    const resolve = field.resolve!;
    field.resolve = (source, args, context, info) => {
      rejectRelationAliases(info);
      return querySelection.run(info, () => resolve(source, args, context, info));
    };
  }
  return generated;
}

/** Merge field selections by schema field name: scalar aliases, directives
 * and fragments must request the same SQL extra. */
function selectedFields(sets: readonly SelectionSetNode[], info: GraphQLResolveInfo) {
  const fields = new Map<string, SelectionSetNode[]>();
  const fragments = new Set<string>();
  function visit(set: SelectionSetNode) {
    for (const node of set.selections) {
      if (getDirectiveValues(GraphQLSkipDirective, node, info.variableValues)?.if === true ||
          getDirectiveValues(GraphQLIncludeDirective, node, info.variableValues)?.if === false) continue;
      if (node.kind === Kind.FIELD) {
        const nested = fields.get(node.name.value) ?? [];
        if (node.selectionSet) nested.push(node.selectionSet);
        fields.set(node.name.value, nested);
      } else if (node.kind === Kind.INLINE_FRAGMENT) visit(node.selectionSet);
      else if (!fragments.has(node.name.value)) {
        fragments.add(node.name.value);
        const fragment = info.fragments[node.name.value];
        if (fragment) visit(fragment.selectionSet);
      }
    }
  }
  sets.forEach(visit);
  return fields;
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

/** Selected schema field names, respecting aliases, fragments and directives.
 * Custom display projections share the generated reader's selection walker.
 */
export function selectedQueryFields(info: GraphQLResolveInfo, path: readonly string[] = []) {
  let sets = info.fieldNodes.flatMap(node => node.selectionSet ? [node.selectionSet] : []);
  for (const name of path) sets = selectedFields(sets, info).get(name) ?? [];
  return new Set(selectedFields(sets, info).keys());
}
