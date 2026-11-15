/** The executable's shared home. No interim tables, credential copies or /live. */
import Database from 'better-sqlite3';
import { constants, openSync, closeSync, fchmodSync, fstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createDataSchema, dataDatabase } from './core/data/database.js';
import { members, agents, memberAgents, household, tokens, sessions } from './core/data/schema.js';
import { clock as realClock, type Clock } from './core/clock.js';
import { ownHome } from './core/daemon-home.js';
import { assertHomeReady } from './core/home-state.js';
import { sharedSigninLinks } from './core/signin/shared-links.js';
import { sameOrigin, relyingParty } from './core/signin/index.js';
import { loadKey } from './pieces/comms/crypto.js';
import { serveShared } from './shared-serve.js';

export async function startSharedLoom(options: {home:string; host?:string[]; port?:number; staging?:boolean; clock?:Clock; webRoot?:string; stdout?:(text:string)=>void}) {
  const home = resolve(options.home), clock = options.clock ?? realClock;
  assertHomeReady(home);
  mkdirSync(home, {recursive:true,mode:0o700});
  const release = await ownHome(home);
  let client: Database.Database | undefined;
  let server: Awaited<ReturnType<typeof serveShared>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async()=>{try {await server?.close();} finally {try {client?.close();} finally {await release();}}})();
  try {
    const entries = readdirSync(home);
    if (!entries.includes('loom.db') && entries.length)
      throw new Error('A nonempty home needs the separate data move');
    // Set the file mode before SQLite creates its WAL/SHM files. Never follow
    // a DB symlink, or create the old foundation's migration tables here.
    for (const suffix of ['', '-wal', '-shm']) {
      let fd:number;
      try {fd=openSync(join(home,'loom.db'+suffix),constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK|(suffix ? 0 : constants.O_CREAT),0o600);}
      catch(error){if(suffix&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      try {if(!fstatSync(fd).isFile())throw new Error('Database must be a regular file');fchmodSync(fd,0o600);} finally {closeSync(fd);}
    }
    client = new Database(join(home,'loom.db'));
    const fresh = !client.prepare('SELECT name FROM sqlite_schema LIMIT 1').get();
    if (fresh && entries.some(name=>name!=='loom.db')) throw new Error('A nonempty home needs the separate data move');
    const db = fresh ? createDataSchema(client,()=>new Date(clock.now()).toISOString()) : dataDatabase(client,()=>new Date(clock.now()).toISOString());
    if (!fresh && !client.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migrations'").get())
      throw new Error('This home needs the separate data move before starting the shared program');
    client.pragma('journal_mode = WAL'); client.pragma('foreign_keys = ON');
    const commsKey = await loadKey(home);
    let link: string | undefined;
    if (!db.select().from(members).get()) db.transaction(()=>{
      const at = new Date(clock.now()).toISOString(), username = userInfo().username;
      const member = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(username) ? username : 'owner';
      db.insert(members).values({id:member,role:'owner',fullOwner:true,joinedAt:at}).run();
      db.insert(agents).values({id:'assistant',about:'Help with the work you are given.',markBg:'#313244',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
      db.insert(memberAgents).values({member,agent:'assistant'}).run();
      db.insert(household).values({defaultAgent:'assistant'}).run();
      const fingerprint = createHash('sha256').update(randomBytes(32)).digest('hex');
      db.insert(tokens).values({fingerprint,label:'First sign-in',kind:'owner',member,createdAt:at}).run();
    });
    // A failed listen or a lost first print must not strand a new home. The
    // local owner can restart until the first browser has redeemed a link.
    if (!db.select().from(sessions).get()) {
      const first = db.select().from(tokens).all().find(t=>t.label==='First sign-in' && !t.revokedAt);
      if (first) link=db.transaction(()=>sharedSigninLinks(db,clock).makeLink(first.fingerprint).path);
    }
    const hosts = options.host ?? ['127.0.0.1'];
    if (hosts.length !== 1) throw new Error('The shared listener requires one bind address');
    server = await serveShared({db,clock,host:hosts[0],port:options.port,webRoot:options.webRoot ?? resolve(import.meta.dirname,'../dist/web'),commsKey,
      publicOrigin:relyingParty(process.env)?.origin,originAllowed:sameOrigin,
      ...(options.staging ? {tempo:{admit:()=>false}} : {}),reportError:()=>{process.stderr.write('loom: shared operation unavailable\n');}});
    server.http.get('/health',c=>c.json({ok:true,next:true,staging:!!options.staging}));
    if (link) (options.stdout ?? (text=>process.stdout.write(text)))(new URL(link,server.url).href+'\n');
    return {...server,db,close};
  } catch (error) {await close();throw error;}
}
