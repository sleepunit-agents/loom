/** Operator configuration, never inferred from model names or outside callers.
 * JSON loading is kept separate so the server entry owns file access. */
import { z } from 'zod';
import type { ModelRole } from './placement.js';
const name = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\0\r\n]/.test(value));
const catalog = z.array(z.object({ model:name, provider:name, harness:name, series:name, tag:name.optional() }).strict())
  .refine(rows => new Set(rows.map(row => row.model)).size === rows.length);
export function modelCatalog(input: unknown): readonly Readonly<ModelRole>[] {
  const parsed = catalog.safeParse(input);
  if (!parsed.success) throw new Error('Invalid model role catalog');
  return Object.freeze(parsed.data.map(row => Object.freeze(row)));
}
export function modelCatalogJson(input: string): readonly Readonly<ModelRole>[] {
  try {
    if (Buffer.byteLength(input) > 1_048_576) throw new Error();
    return modelCatalog(JSON.parse(input));
  } catch { throw new Error('Invalid model role catalog'); }
}
