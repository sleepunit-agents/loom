import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { generateX25519Identity } from 'age-encryption';
import { expect, it } from 'vitest';
import { wordsKey } from '../../pieces/comms/crypto.js';
import { createDataSchema } from '../data/database.js';
import { agentPosts, agentPostThreads, agents, members, threads } from '../data/schema.js';
import { agentPostHistory, agentPostPreviews, prepareAgentPost } from './agent-posts.js';
import { Threads } from './threads.js';

it('keeps both activities in one session distinct across replies and renames', async () => {
  const client = new Database(':memory:');
  try {
    const at = '2026-11-22T17:00:00Z';
    const db = createDataSchema(client, () => at);
    const key = wordsKey(await generateX25519Identity());
    db.insert(members).values({id:'sam',role:'member',joinedAt:at}).run();
    db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
    const source = new Threads(db, () => at).open({ agent:'art', member:'sam', title:'Terminal', venue:'terminal' });
    const prepare = (input: Parameters<typeof prepareAgentPost>[3]) => prepareAgentPost(db, key, source.id, input);
    const boot = (await prepare({ action:'open', words:'Giving boot a console.' }))(at);
    const disk = (await prepare({ action:'open', words:'What filled the disk?' }))(at);
    expect(await key.open(db.select().from(agentPostThreads).where(eq(agentPostThreads.id,disk)).get()!.title)).toBe('What filled the disk?');
    (await prepare({ action:'rename', thread:disk, title:'The missing disk space' }))(at);
    expect((await prepare({ action:'reply', thread:boot, words:'It scrolls.' }))(at)).toBe(boot);
    const preview = (sourceId: string, count: number) => agentPostPreviews(db,key,eq(agentPostThreads.source,sourceId),count);
    expect(await preview(source.id,2)).toMatchObject([
      {thread:boot, latest:{words:'It scrolls.'}, parent:{words:'Giving boot a console.'}},
      {thread:disk, title:'The missing disk space', latest:{words:'What filled the disk?'}, parent:null},
    ]);
    expect(await preview(source.id,1)).toHaveLength(1);
    expect(await preview('another-source',2)).toEqual([]);
    const visible = eq(agentPostThreads.source, source.id);
    const [first] = await agentPostHistory(db,key,visible,boot,0,1);
    expect(first.words).toBe('Giving boot a console.');
    expect(await agentPostHistory(db,key,visible,boot,Number(first.id),5)).toMatchObject([{words:'It scrolls.'}]);
    const rows = db.select().from(agentPosts).orderBy(agentPosts.seq).all();
    expect(rows.map(r=>r.thread)).toEqual([boot,disk,boot]);
    expect(await Promise.all(rows.map(r=>key.open(r.words)))).toEqual(['Giving boot a console.','What filled the disk?','It scrolls.']);
    expect(rows[0].words.includes(Buffer.from('Giving boot'))).toBe(false);

    const foreign = await prepareAgentPost(db,key,'another-source',{action:'reply',thread:disk,words:'wrong thread'});
    expect(()=>foreign(at)).toThrow('unavailable');
    const invalid = await prepare({action:'open', words:'roll this one back'});
    expect(()=>invalid('bad timestamp')).toThrow();
    expect(db.select().from(agentPostThreads).all()).toHaveLength(2);
    db.delete(threads).where(eq(threads.id,source.id)).run();
    expect(db.select().from(agentPosts).all()).toEqual([]);
    expect(db.select().from(agentPostThreads).all()).toEqual([]);
  } finally { client.close(); }
});
