import { expect, it } from 'vitest';
import { deskRecentActivity, deskRecentActivitySelection } from './recent-activity';
import { memoryQueries } from '../../memory/queries';
const window={id:'recent',to:'recent',days:['2026-11-14'],earlier:null,entries:[{id:'step',agent:'art',at:'2026-11-14T00:00:00Z',day:'2026-11-14',hour:0,title:'Current step',line:null,venue:'terminal',where:'Terminal',what:'work',owner:null,expires:null}],conversations:'available',episodes:'available',truncated:false,expires:1};
const query={status:'live' as const,data:{memoryActivity:window}};
it('reuses the existing Memory document/decoder and normalizes optional nulls for the desk',()=>{
 const existing=memoryQueries.activity('recent');
 expect(deskRecentActivitySelection.query).toBe(existing.query);expect(deskRecentActivitySelection.variables).toEqual(existing.variables);
 expect(deskRecentActivitySelection.decode(query.data)).toEqual(existing.decode(query.data));
 const result=deskRecentActivity(query);expect(result.status).toBe('live');
 expect(result.records[0].entries[0]).toMatchObject({id:'step',title:'Current step'});
 expect(result.records[0].entries[0]).not.toHaveProperty('line');
 expect(result.records[0]).not.toHaveProperty('earlier');
});
it.each(['loading','offline','denied'] as const)('withdraws retained activity on %s',status=>{
 expect(deskRecentActivity({...query,status})).toEqual({status,records:[]});
});
it('keeps live empty distinct from missing, refused or malformed selections',()=>{
 expect(deskRecentActivity({status:'live'})).toEqual({status:'loading',records:[]});
 expect(deskRecentActivity({status:'live',data:{memoryActivity:null}})).toEqual({status:'denied',records:[]});
 expect(deskRecentActivity({status:'live',data:{}})).toEqual({status:'offline',records:[]});
 expect(deskRecentActivity({...query,data:{memoryActivity:{...window,entries:[]}}})).toMatchObject({status:'live',records:[{entries:[]}]});
});
