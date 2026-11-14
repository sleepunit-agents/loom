import { expect, it } from 'vitest';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, parse, subscribe } from 'graphql/index.js';
import { DataLive } from './live.js';
import { dataSubscriptions } from './subscriptions.js';

it('exposes initial selection and deltas through the standard GraphQL subscription executor', async () => {
  let title = 'First';
  const read = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { title: { type: GraphQLString, resolve: () => title } } }) });
  const live = new DataLive(), schema = dataSubscriptions(read, live, () => true);
  const result = await subscribe({ schema, document: parse('subscription($selection: String!) { observe(query: $selection) { revision patches { path removed value } } }'), variableValues: { selection: '{ title }' } });
  expect(Symbol.asyncIterator in result).toBe(true);
  if (!(Symbol.asyncIterator in result)) throw new Error('Expected a subscription');
  try {
    expect((await result.next()).value).toEqual({ data: { observe: { revision: 1, patches: [{ path: [], removed: false, value: { title: 'First' } }] } } });
    title = 'Second'; live.changed();
    expect((await result.next()).value).toEqual({ data: { observe: { revision: 2, patches: [{ path: ['title'], removed: false, value: 'Second' }] } } });
  } finally { await result.return?.(); live.close(); }
});

it('keeps Memory viewer context isolated across concurrent subscriptions and refreshes current access', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SqliteKnowledgeBackend } = await import('../../backends/sqlite-knowledge.js');
  const { knowledgeQueryFields } = await import('../../pieces/mind/knowledge-query.js');
  const home = mkdtempSync(join(tmpdir(), 'memory-live-context-'));
  const backend = new SqliteKnowledgeBackend({dbPath:join(home,'knowledge.db')});
  const sharing = { members:{owner:{owner:true,agents:[]},peer:{owner:false,agents:[]}},projects:{},services:{} };
  const fields = knowledgeQueryFields({path:join(home,'knowledge.db'),sharing:()=>sharing,now:()=>Date.parse('2026-11-14T18:00:00Z')});
  const live = new DataLive();
  const schema = dataSubscriptions(new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:fields.fields})}),live,()=>true);
  const document = parse('subscription($query:String!) { observe(query:$query) { revision patches { path removed value } } }');
  const streams: AsyncIterableIterator<unknown>[] = [];
  async function open(id:string) {
    const result = await subscribe({schema,document,contextValue:{viewer:{kind:'member',id}},variableValues:{query:'{ page: memoryKnowledgePage(slug:"pump") { title body history { body } } }'}});
    if (!(Symbol.asyncIterator in result)) throw new Error(JSON.stringify(result));
    streams.push(result); return result;
  }
  try {
    await backend.writePage({slug:'pump',title:'Fictional pump',domain:'pond',body:'Fictional private words'});
    const [owner,peer] = await Promise.all([open('owner'),open('peer')]);
    const [a,b] = await Promise.all([owner.next(),peer.next()]);
    expect(a.value).toMatchObject({data:{observe:{revision:1,patches:[{path:[],value:{page:{title:'Fictional pump',body:'Fictional private words',history:[]}}}]}}});
    expect(b.value).toMatchObject({data:{observe:{revision:1,patches:[{path:[],value:{page:null}}]}}});
    await backend.writePage({slug:'pump',title:'Changed pump',domain:'pond',body:'Changed private words'});
    live.changed();
    expect((await owner.next()).value).toMatchObject({data:{observe:{revision:2,patches:expect.arrayContaining([{path:['page','body'],removed:false,value:'Changed private words'}])}}});
    sharing.members.owner.owner=false; live.changed();
    expect((await owner.next()).value).toMatchObject({data:{observe:{revision:3,patches:[{path:['page'],removed:false,value:null}]}}});
    // Peer did not inherit the owner's context during any concurrent rerun.
    sharing.members.peer.owner=true; live.changed();
    expect((await peer.next()).value).toMatchObject({data:{observe:{revision:2,patches:[{path:['page'],value:{body:'Changed private words',history:[{body:'Fictional private words'}]}}]}}});
  } finally {
    for (const stream of streams) await stream.return?.();
    live.close(); fields.close(); backend.close(); rmSync(home,{recursive:true,force:true});
  }
});
