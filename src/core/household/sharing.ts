import { z } from 'zod';
import type { Db } from '../db/index.js';
import { OperationError } from '../operations/index.js';
import type { Sharing } from '../../policy.js';
import type { Household } from '../../household.js';
import { HouseholdDatabase } from './document.js';
import { HouseholdRows } from './rows.js';

export const projectSlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(100);
export const projectSchema = z.object({
  slug: projectSlug,
  name: z.string().trim().min(1).max(200),
  repositories: z.array(z.string().min(1).max(500)).max(100),
  members: z.array(projectSlug).max(100),
  agents: z.array(z.string()).max(100),
}).passthrough();
export type HouseholdProject = z.infer<typeof projectSchema>;

/** Supplied daemon/importer connection only. No filesystem IO or backend selection. */
export class SharingDatabase {
  constructor(private readonly db: Db, private readonly home: string,
    private readonly household: () => Household | null | undefined = () => new HouseholdDatabase(db).household(home)) {}

  project(slug: string): HouseholdProject | undefined {
    const raw = new HouseholdRows<unknown>(this.db, 'projects').get(slug);
    if (raw === undefined) return;
    const project = projectSchema.parse(raw);
    if (project.slug !== slug) throw new Error('household project key mismatch');
    return project;
  }

  projectIds(): string[] { return new HouseholdRows<unknown>(this.db, 'projects').entries().map(([id]) => id); }

  /** One snapshot supplies the central policy; project membership never implies ownership. */
  sharing(): Sharing {
    return this.db.transaction(() => {
      const h = this.household();
      if (!h) return { members: {}, projects: {}, services: {} };
      const projects = new HouseholdRows<unknown>(this.db, 'projects').entries().map(([id]) => {
        const p = this.project(id)!;
        // Removed members and agents must not keep project access through stale references.
        return [id, { members: p.members.filter(id => h.members.some(m => m.person === id)), agents: p.agents.filter(id => h.agents.includes(id)) }] as const;
      });
      return {
        members: Object.fromEntries(h.members.map(m => [m.person, { owner: m.agents === '*', agents: m.agents === '*' ? h.agents : m.agents }])),
        projects: Object.fromEntries(projects),
        services: {},
      };
    })();
  }

  /** The operation/importer owns the transaction, including retry state and access events. */
  create(input: HouseholdProject): HouseholdProject {
    this.requireTransaction();
    const p = this.validate(input);
    if (this.project(p.slug)) throw new OperationError('conflict', 'Project already exists');
    new HouseholdRows(this.db, 'projects').put(p.slug, p);
    return p;
  }

  setMembers(slug: string, members: string[]): HouseholdProject { return this.change(slug, { members }); }
  setAgents(slug: string, agents: string[]): HouseholdProject { return this.change(slug, { agents }); }

  private change(slug: string, values: Partial<HouseholdProject>): HouseholdProject {
    this.requireTransaction();
    const before = this.project(slug);
    if (!before) throw new OperationError('not-found', 'Project does not exist');
    const p = this.validate({ ...before, ...values });
    new HouseholdRows(this.db, 'projects').put(slug, p);
    return p;
  }

  private requireTransaction(): void {
    if (!this.db.inTransaction) throw new Error('project change requires a transaction');
  }

  private validate(input: HouseholdProject): HouseholdProject {
    const parsed = projectSchema.safeParse(input);
    if (!parsed.success) throw new OperationError('invalid', 'Invalid household project');
    const p = parsed.data;
    const h = this.household();
    if (!h) throw new OperationError('unavailable', 'Household has not been imported or supplied');
    if (p.members.some(id => !h.members.some(m => m.person === id))) throw new OperationError('invalid', 'Project names an unknown member');
    if (p.agents.some(id => !h.agents.includes(id))) throw new OperationError('invalid', 'Project names an unknown agent');
    return { ...p, repositories: [...new Set(p.repositories)], members: [...new Set(p.members)], agents: [...new Set(p.agents)] };
  }
}
