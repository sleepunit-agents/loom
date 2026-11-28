/** Fields read from outside the database: a field whose resolver waits on something outside loom (GitHub, say) each
 * time it is read. Such a field is asked once, through the HTTP door or a direct read on the socket, and never held as
 * a live selection: an open selection is read again on every commit, so each commit would be a call outside, with no
 * member asking. `observe` refuses a selection that names one, wherever in it, fragments included (./live.ts). */
import { TypeInfo, visit, visitWithTypeInfo, type DocumentNode, type GraphQLFieldConfig, type GraphQLSchema } from 'graphql/index.js';

/** The field extension that marks one. Its value says what is read, for the refusal. */
export const OUTSIDE_READ = 'loomOutsideRead';

/** The same field, marked as read from outside the database. */
export function outsideRead<F extends GraphQLFieldConfig<any, any>>(field: F, what: string): F {
  return { ...field, extensions: { ...field.extensions, [OUTSIDE_READ]: what } };
}

/** The first field of the document marked as read from outside, as `name (what)`; undefined where there is none.
 * The document must already be valid against the schema. */
export function outsideReadIn(schema: GraphQLSchema, document: DocumentNode): string | undefined {
  const info = new TypeInfo(schema);
  let found: string | undefined;
  visit(document, visitWithTypeInfo(info, { Field() {
    const what = info.getFieldDef()?.extensions?.[OUTSIDE_READ];
    if (found === undefined && typeof what === 'string') found = `${info.getFieldDef()!.name} (${what})`;
  } }));
  return found;
}
