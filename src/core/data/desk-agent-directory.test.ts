import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphQLObjectType, GraphQLSchema, graphql } from 'graphql/index.js';
import { PeopleStore } from '../../backends/people';
import { peopleQueryFields } from '../../pieces/mind/people-query';
import type { Sharing } from '../../policy';
import { deskAgentDirectory, deskAgentDirectoryQuery, type DeskAgentDirectoryData } from '../../../web/src/pieces/attention/agent-directory';
it('executes the minimal desk selection through the existing Memory reader and current fixture access',async()=>{
 const home=mkdtempSync(join(tmpdir(),'desk-agent-directory-'));
 const directory=new PeopleStore({dbPath:join(home,'directory.db'),actor:'fiction'}),relationship=new PeopleStore({dbPath:join(home,'relationship.db'),actor:'fiction'});
 let close=()=>{};
 try {
  directory.write({slug:'art',name:'Current name',how:{kind:'agent'}});
  directory.write({slug:'human',name:'Human name'});
  relationship.write({slug:'art',name:'Private relationship name',how:{kind:'agent'}});
  const sharing:Sharing={members:{owner:{owner:true,agents:[]}},projects:{}};
  const fields=peopleQueryFields({directory:directory.database.name,agents:[{agent:'other',memories:relationship.database.name}],sharing:()=>sharing,now:()=>Date.parse('2026-11-14T00:00:00Z')});close=fields.close;
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:fields.fields})});
  const read=async()=>{const result=await graphql({schema,source:deskAgentDirectoryQuery,contextValue:{viewer:{kind:'member',id:'owner'}}});expect(result.errors).toBeUndefined();return deskAgentDirectory({status:'live',data:result.data as unknown as DeskAgentDirectoryData});};
  expect((await read()).records).toEqual([{id:'commons:art',slug:'art',name:'Current name',kind:'agent'}]);
  directory.write({slug:'art',name:'Renamed'});expect((await read()).records[0].name).toBe('Renamed');
  sharing.members.owner.owner=false;
  expect(await read()).toEqual({status:'denied',records:[]});
 } finally {close();relationship.close();directory.close();rmSync(home,{recursive:true,force:true});}
});
