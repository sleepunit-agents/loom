import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { OperationError, type Operations } from './core/operations/index.js';
import type { sharedCredentials } from './shared-credentials.js';
import { currentKitJob } from './shared-kit-access.js';

const text = z.string().min(1).max(800);
export function registerKitReads(operations:Operations, db:DataDatabase, credentials:ReturnType<typeof sharedCredentials>) {
  operations.register({
    name:'kits.available',input:z.strictObject({}),output:z.strictObject({
      explanation:z.string(),word:z.enum(['others','owners','own']),person:z.strictObject({kind:z.enum(['member','outside']),id:z.string()}).nullable(),
      projects:z.array(z.string()),tools:z.array(z.strictObject({
      kit:text,tool:text,description:z.string(),reasons:z.array(z.string()),
    }))}),
    may:viewer=>!!currentKitJob(db,credentials,viewer),
    run(ctx) {
      const target=currentKitJob(db,credentials,ctx.viewer);
      if (!target) throw new OperationError('denied','A running job is required');
      return {explanation:"These are the tools currently granted to this job. The named tools offered by this worker show which are usable with its mounted house. A grant added after the worker started can appear here before its named tool is available.",word:target.word.woke,person:target.word.person??null,projects:target.projects,tools:target.tools.map(({kit,tool,reasons})=>({kit,tool:tool.name,description:tool.description,reasons}))};
    },
  });
}
