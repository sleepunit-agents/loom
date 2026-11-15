/** Canonical shared sign-in clients: GraphQL reads, shared commands, one-time issuance. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
const reference=z.string().regex(/^[0-9a-f]{64}$/),time=z.string();
const tokenInfo=z.object({fingerprint:reference,label:z.string(),kind:z.enum(['owner','agent','runner']),expired:z.boolean(),identity:z.string(),createdAt:time,expiresAt:time.nullable(),revokedAt:time.nullable(),lastUsedAt:time.nullable()}).strict();
const sessionInfo=z.object({ref:reference,device:z.string(),member:z.string().nullable(),tokenLabel:z.string().nullable(),isAgent:z.boolean(),ended:z.boolean(),issuedAt:time,seenAt:time}).strict();
const accountInfo=z.object({member:z.string(),passkeys:z.array(z.object({ref:reference,label:z.string(),createdAt:time,lastUsedAt:time.nullable(),ended:z.boolean()}).strict()),sessions:z.array(z.object({ref:reference,device:z.string(),issuedAt:time,seenAt:time,ended:z.boolean()}).strict()),notifications:z.object({publicKey:z.string().nullable(),devices:z.array(z.object({ref:reference,device:z.string(),createdAt:time,seenAt:time}).strict())}).strict()}).strict();
const clients={
 token:{names:['list','create','revoke'],root:'householdSetup',field:'tokens',fields:'tokens { fingerprint label kind expired identity createdAt expiresAt revokedAt lastUsedAt }',schema:z.array(tokenInfo)},
 sessions:{names:['list','revoke'],root:'householdSetup',field:'sessions',fields:'sessions { ref device member tokenLabel isAgent ended issuedAt seenAt }',schema:z.array(sessionInfo)},
 account:{names:['read','removePasskey','revokeSession'],root:'account',field:'',fields:'member passkeys { ref label createdAt lastUsedAt ended } sessions { ref device issuedAt seenAt ended } notifications { publicKey devices { ref device createdAt seenAt } }',schema:accountInfo},
};
const unknownIssuance='Token creation outcome unknown; list tokens before trying again';
const defaults: ClientRuntime = { request: (...args) => fetch(...args), retry: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export async function runAccessClient(piece: 'token'|'sessions'|'account', argv: string[], io: IOStreams, runtime: ClientRuntime & { now?: () => number } = defaults): Promise<number> {
  const binding=clients[piece],names=binding.names;
  const issuance=piece==='token'&&argv[0]==='create';
  const help=`usage: loom-${piece} <${names.join('|')}> [json-object]\n`;
  if(!argv.length||argv[0]==='--help'||argv[0]==='-h'){io.stdout(help);return 0;}
  const name=argv[0];if(!names.includes(name)||argv.length>2){io.stderr(help);return 2;}
  const read=name==='list'||name==='read';
  const inputText = argv[1] ?? '{}';
  let input: unknown;
  try {
    input = JSON.parse(inputText);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
  } catch { io.stderr(`loom-${piece}: expected a JSON object\n`); return 2; }
  if(read&&Object.keys(input as object).length){io.stderr(`loom-${piece}: read takes an empty JSON object\n`);return 2;}
  const fail = (message: string) => { io.stderr(`loom-${piece}: ${message}\n`); return 1; };
  let base: URL, token: string;
  try {
    if (!io.env.LOOM_URL) return fail('LOOM_URL is required');
    base = new URL(io.env.LOOM_URL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return fail('Invalid LOOM_URL');
    if (!io.env.LOOM_TOKEN_FILE) return fail('LOOM_TOKEN_FILE is required');
    token = (await readFile(io.env.LOOM_TOKEN_FILE, 'utf8')).trim();
    if (!token) return fail('Token file is empty');
  } catch { return fail('Cannot configure loom connection'); }
  const query=`{ ${binding.root} { ${binding.fields} } }`;
  // Keep raw validated input: reserialization changes overflow numbers to null.
  // Never journal/retry returned bearer credentials. Ordinary mutations retain
  // one stable command ID across bounded transport retries.
  const body=read?JSON.stringify({query}):issuance?inputText:`{"input":${inputText},"id":${JSON.stringify(randomUUID())}}`;
  const endpoint=read?'/graphql':issuance?'/api/signin/token':`/api/${piece}/${name}`;
  const now = runtime.now ?? (() => performance.now());
  const deadline = now() + 4000;
  for (;;) {
    if (now() >= deadline) return fail('loom daemon is unavailable');
    try {
      const response = await runtime.request(new URL(endpoint, base), {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(Math.max(1, Math.min(1500, Math.ceil(deadline - now())))),
      });
      if (!issuance && response.status >= 500 && now() < deadline) {
        await response.body?.cancel().catch(() => {});
        await runtime.retry(Math.min(500, Math.max(0, deadline - now())));
        continue;
      }
      if(!response.ok){await response.body?.cancel().catch(()=>{});return fail(response.status>=500?(issuance?unknownIssuance:'loom daemon is unavailable'):'Request refused');}
      let answer:unknown;
      try { answer=await response.json(); } catch { return fail(issuance?unknownIssuance:'Invalid daemon response'); }
      if(read){
        const parsed=z.object({data:z.record(z.string(),z.unknown()),errors:z.unknown().optional()}).safeParse(answer);
        if(!parsed.success||parsed.data.errors)return fail('Invalid daemon response');
        const value=parsed.data.data[binding.root];
        if(!value||typeof value!=='object')return fail('Request refused');
        const output=binding.field?(value as Record<string,unknown>)[binding.field]:value;
        const checked=binding.schema.safeParse(output);if(!checked.success)return fail('Invalid daemon response');io.stdout(JSON.stringify(checked.data,null,2)+'\n');
      }else{
        const schema=issuance?z.object({token:z.string().min(32),fingerprint:reference}).strict():name==='removePasskey'?z.object({removed:z.literal(true)}).strict():z.object({revoked:z.literal(true)}).strict();
        const result=z.object({ok:z.literal(true),value:schema}).strict().safeParse(answer);
        if(!result.success)return fail(issuance?unknownIssuance:'Invalid daemon response');
        io.stdout(issuance?(result.data.value as {token:string}).token+'\n':JSON.stringify(result.data.value,null,2)+'\n');
      }
      return 0;
    } catch { if (issuance) return fail(unknownIssuance); if (now() >= deadline) return fail('loom daemon is unavailable'); }
    await runtime.retry(Math.min(500, Math.max(0, deadline - now())));
  }
}
