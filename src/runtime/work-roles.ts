import { createHash } from 'node:crypto';
import { z } from 'zod';
import { householdId, slug } from '../slug.js';
import { lineName } from '../core/line-name.js';
import type { ModelRole } from './placement.js';

/** The household names the jobs each agent may request and the model pool for each. */
export const workRoleId = slug(64);
export const workRoleCatalog = z.array(z.object({
  agent: householdId, id: workRoleId, description: z.string().trim().min(1).max(2000),
  models: z.array(lineName).max(32).default([]), providers: z.array(lineName).max(8).default([]),
}).strict().refine(role => role.models.length + role.providers.length > 0, 'Name an eligible model or provider'))
  .max(256).refine(rows => new Set(rows.map(row => row.agent + '/' + row.id)).size === rows.length, 'Duplicate work role');
export type WorkRoleConfig = z.input<typeof workRoleCatalog>;
export type WorkRole = z.infer<typeof workRoleCatalog>[number];
export function roleRevision(role: WorkRole) {
  return createHash('sha256').update(JSON.stringify(role)).digest('hex');
}
export function eligibleModels(role: WorkRole, catalog: readonly ModelRole[]) {
  return catalog.filter(model => (model.harness === 'claude' || model.harness === 'codex') &&
    (role.models.includes(model.model) || role.providers.includes(model.provider)));
}
