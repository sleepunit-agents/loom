/** The worker supplies its own bearer and the credential bound to the body on
 * its socket. Neither credential alone can receive a helper's secret inputs. */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { kitUses, secretChanges, secretWriteJournal } from './core/data/schema.js';
import { secretHasValue } from './pieces/secrets/presence.js';
import { secretValueSize } from './pieces/secrets/input.js';
import type { SecretValueSource } from './pieces/secrets/role.js';
import { SHA256_HEX } from './core/sha256-hex.js';
import { kitTool } from './runtime/kit-manifest.js';
import { householdId } from './slug.js';
import type { sharedCredentials } from './shared-credentials.js';
import {kitAvailabilityReport,kitPin,type KitUnavailable} from './runtime/kit-availability.js';
import {recordKitAvailability} from './shared-kit-notices.js';
import { currentKitJob } from './shared-kit-access.js';

type Credentials = ReturnType<typeof sharedCredentials>;
type Target = NonNullable<ReturnType<typeof currentKitJob>>;
const cursor = z.strictObject({kit:householdId,tool:kitTool.shape.name});
const list = kitPin.extend({after:cursor.optional()});
const matchesPin=(tool:z.infer<typeof kitTool>,pin:z.infer<typeof kitPin>)=>
  tool.repository===pin.repository && tool.commit===pin.commit && tool.image===pin.image;
const call = cursor.extend({definition:z.string().regex(SHA256_HEX)});
const finish = z.strictObject({use:z.uuid(),outcome:z.enum(['ran','failed','refused'])});
const changed = 'This tool or its grant changed. Read the available tools for this job again.';
export function kitBroker(options: {db:DataDatabase;credentials:Credentials;source?:SecretValueSource;
  now():string;write<T>(fn:()=>T):T; readJson(request:Request,abort:AbortController):Promise<unknown>}) {
  const {db,credentials}=options;
  const app = new Hono<{Variables:{shutdown:AbortController}}>();
  const resolve = (request:Request) => {
    const bearer=request.headers.get('x-loom-body-credential'), job=request.headers.get('x-loom-kit-job');
    if (!bearer || !job || request.signal.aborted) return;
    const worker=credentials.authenticate(request,{recordUse:false,programs:'deny'});
    const box=worker && credentials.runner(worker.viewer)?.box;
    if (!box) return;
    const auth=credentials.authenticate(new Request(request.url,{headers:{authorization:'Bearer '+bearer}}),{recordUse:false,programs:'deny'});
    if (!auth) return;
    return () => {
      if (request.signal.aborted || !worker.valid() || !auth.valid()) return;
      const target=currentKitJob(db,credentials,auth.viewer);
      if (target?.job.box===box && target.job.id===job) return target;
    };
  };
  const audit = (target:Target,input:z.infer<typeof call>,outcome:string) => {
    const id=randomUUID();
    options.write(()=>db.insert(kitUses).values({id,job:target.job.id,conversation:target.job.conversation,
      agent:target.job.agent,personKind:target.word.person?.kind??null,person:target.word.person?.id??null,
      kit:input.kit,tool:input.tool,at:options.now(),outcome}).run());
    return id;
  };
  app.onError((_err,c)=>c.json({message:'Kit worker unavailable'},503));
  app.post('/:operation',async c=>{
    const request=c.req.raw, current=resolve(request);
    if (!current || !current()) return c.json({message:'The assigned worker and running job are required'},403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')) return c.json({message:'Use JSON'},415);
    const raw=await options.readJson(request,c.get('shutdown')),target=current();
    if (!target) return c.json({message:'The job ended'},403);
    const operation=c.req.param('operation');
    const credentialReady=(tool:z.infer<typeof kitTool>)=>{
      const names=Object.values(tool.secrets);
      return !names.length || !!options.source && names.every(name=>secretHasValue(db,name)) &&
        !db.select({id:secretWriteJournal.id}).from(secretWriteJournal)
          .where(and(eq(secretWriteJournal.state,'prepared'),inArray(secretWriteJournal.secret,names))).get();
    };
    if (operation==='availability') {
      const parsed=kitAvailabilityReport.safeParse(raw);
      if(!parsed.success)return c.json({message:'Invalid kit availability report'},400);
      const {pin,transport,offered:listed}=parsed.data;
      const unavailable:KitUnavailable[]=[],offered:string[]=[];
      for(const {kit,tools} of target.kits){
        const allowed=target.tools.filter(row=>row.kit===kit);
        const matching=pin ? allowed.filter(({tool})=>matchesPin(tool,pin)) : [];
        const reason=!tools.length?'empty':!allowed.length?'policy':!pin?'image':!matching.length?'house':
          !matching.some(({tool})=>credentialReady(tool))?'credential':transport!=='ready'?transport:
            !listed.includes(kit)?'catalog':undefined;
        if(reason)unavailable.push({kit,reason});
        else offered.push(kit);
      }
      options.write(()=>recordKitAvailability(db,options.now,target.job,unavailable,offered));
      return c.json({unavailable});
    }
    if (operation==='list') {
      const parsed=list.safeParse(raw);
      if (!parsed.success) return c.json({message:'Invalid mounted house or cursor'},400);
      const {after}=parsed.data;
      const ordered=target.tools.filter(({kit,tool})=>matchesPin(tool,parsed.data) && credentialReady(tool)
        && (!after || kit>after.kit || (kit===after.kit && tool.name>after.tool)))
        .sort((a,b)=>a.kit<b.kit?-1:a.kit>b.kit?1:a.tool.name<b.tool.name?-1:a.tool.name>b.tool.name?1:0);
      const first=ordered[0];
      if (!first) return c.json({tools:[]});
      // Even one full tool can contain 64 long fixed arguments. Page by one complete definition.
      const {kit,tool,definition}=first;
      return c.json({tools:[{kit,tool,definition}],...(ordered.length>1?{next:{kit,tool:tool.name}}:{})});
    }
    if (operation==='finish') {
      const result=finish.safeParse(raw);
      if (!result.success) return c.json({message:'Invalid use report'},400);
      const {use,outcome}=result.data;
      const row=db.select().from(kitUses).where(and(eq(kitUses.id,use),eq(kitUses.job,target.job.id))).get();
      if (!row || (row.outcome!=='authorized' && row.outcome!==outcome)) return c.json({message:'Unknown or finished use'},409);
      if (row.outcome!==outcome) options.write(()=>db.update(kitUses).set({outcome}).where(and(eq(kitUses.id,use),eq(kitUses.outcome,'authorized'))).run());
      return c.json({saved:true});
    }
    if (operation!=='authorize' && operation!=='refuse') return c.json({message:'Unknown kit operation'},400);
    const parsed=call.safeParse(raw);
    if (!parsed.success) return c.json({message:'Invalid kit call'},400);
    const input=parsed.data;
    if (operation==='refuse') {
      audit(target,input,'refused');
      return c.json({saved:true});
    }
    const select=(t:Target|undefined)=>t?.tools.find(row=>row.kit===input.kit && row.tool.name===input.tool && row.definition===input.definition);
    const approved=select(target);
    if (!approved) { audit(target,input,'refused'); return c.json({message:changed},403); }
    const secrets:Record<string,string>=Object.create(null);
    const names=Object.values(approved.tool.secrets);
    const generation=()=>db.select({last:sql<number>`coalesce(max(rowid),0)`}).from(secretChanges)
      .where(inArray(secretChanges.secret,names)).get()!.last;
    const ready=()=>!db.select({id:secretWriteJournal.id}).from(secretWriteJournal)
      .where(and(eq(secretWriteJournal.state,'prepared'),inArray(secretWriteJournal.secret,names))).get()
      && names.every(name=>secretHasValue(db,name));
    const snapshot=generation();
    try {
      if (!ready()) throw Error('Credential unavailable');
      for (const [alias,name] of Object.entries(approved.tool.secrets)) {
        if (!select(current())) { audit(target,input,'refused'); return c.json({message:changed},403); }
        if (!options.source) throw Error('No holder');
        const bytes=await options.source.read(name);
        try { if (!secretValueSize(bytes.byteLength)) throw Error('Credential unavailable');
          secrets[alias]=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64'); }
        finally { bytes.fill(0); }
      }
    } catch { audit(target,input,'refused'); return c.json({message:'A required tool credential is unavailable'},503); }
    const final=current();
    if (!final || !ready() || generation()!==snapshot || !select(final) || JSON.stringify(final.word)!==JSON.stringify(target.word)) {
      audit(target,input,'refused'); return c.json({message:changed},403);
    }
    const use=audit(final,input,'authorized');
    return c.json({use,tool:approved.tool,secrets});
  });
  return app;
}
