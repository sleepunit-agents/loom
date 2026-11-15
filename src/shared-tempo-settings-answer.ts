/** Tempo's outside settings-answer adapter. Approvals owns the complete answer,
 * application, Inbox resolution and records on this same connection. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { approvalService } from './apps/approvals.js';
import type { DataDatabase } from './core/data/database.js';
import type { Operations } from './core/operations/index.js';
import { approvals, members } from './core/data/schema.js';
import { TEMPO_SETTINGS_OPERATION } from './core/tempo/settings.js';
export function registerTempoSettingsAnswer(operations: Operations, db: DataDatabase, service: ReturnType<typeof approvalService>) {
  if(operations.db!==db.$client)throw new Error('Tempo answers need the shared connection');
  operations.register({ name:'tempo.answerSettings',doors:['http'],write:true,recheckPolicy:true,
    input:z.object({id:z.string().min(1),allow:z.boolean()}).strict(),output:z.object({saved:z.literal(true)}).strict(),
    may(viewer,input){
      if(viewer.kind!=='member'||db.select({role:members.role}).from(members).where(eq(members.id,viewer.id)).get()?.role!=='owner')return false;
      const card=db.select({kind:approvals.kind,operation:approvals.operation}).from(approvals).where(eq(approvals.id,input.id)).get();
      return card?.kind==='setting'&&card.operation===TEMPO_SETTINGS_OPERATION;
    },
    run(ctx,input){
      if(input.allow)service.allow(input.id,ctx.viewer.id);else service.deny(input.id,ctx.viewer.id);
      ctx.changed('approvals',input.id);return {saved:true};
    },
  });
}
