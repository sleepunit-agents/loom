import { expect, it } from 'vitest';
import { groupVouch } from './group-vouch.js';
import { empty } from './model.js';
import type { DomainContext } from './domain.js';
const c: DomainContext = {caller:{who:{agent:'art',where:"loom's clock"},for:'owner'},now:1_800_000_000_000,piece:true,localAgent:'art',canRead:()=>true};
const candidate = (id:string, automatic=true) => ({id,automatic,due:1_800_000_000_000,note:'Saved work',executable:'runs: queue'});
const run = (s:ReturnType<typeof empty>, ids:string[]) => groupVouch(s,{candidates:ids.map(id=>candidate(id))},{...c,caller:structuredClone(c.caller)});
it('preserves an allowed card and its words while new candidates wait',()=>{
  const s=empty(), card=run(s,['w-000001'])!;
  Object.assign(card,{state:'allowed',expires:new Date(c.now+60000).toISOString()});
  const before=structuredClone(s);
  expect(run(s,['w-000001','w-000002'])).toEqual(card);
  expect(s).toEqual(before);
});
it('leaves another filer pending and excludes its ids from automatic grouping',()=>{
  const s=empty(), other=run(s,['w-000001'])!;
  other.who.where='other clock';
  expect(run(s,['w-000001','w-000002'])?.target).toBe('art:w-000002');
  expect(other.state).toBe('pending');
});
it('retains a partially stale card until new selected work arrives',()=>{
  const s=empty(), first=run(s,['w-000001','w-000002'])!;
  expect(run(s,['w-000002'])?.id).toBe(first.id);
  expect(first.state).toBe('pending');
  expect(run(s,['w-000002','w-000003'])?.target).toBe('art:w-000002,w-000003');
  expect(first.state).toBe('withdrawn');
});
it('keeps the target within 200 bytes when candidates have UUID ids',()=>{
  const s=empty(), ids=Array.from({length:12},(_,i)=>`w-0000000${i.toString(16)}-0000-0000-0000-000000000000`);
  const card=run(s,ids)!;
  expect(card.target.length).toBeLessThanOrEqual(200);
  expect(card.target.split(',')).toHaveLength(5);
});
it('cannot replace unreadable cards, accepts only the fixed clock owner caller, and rejects malformed candidates',()=>{
  const s=empty();run(s,['w-000001']);
  const before=structuredClone(s);
  expect(()=>groupVouch(s,{candidates:[candidate('w-000002')]},{...c,canRead:()=>false})).toThrow();
  expect(s).toEqual(before);
  for (const caller of [{...c.caller,for:'?'},{...c.caller,project:'pond'},{...c.caller,who:{agent:'art',where:'body'}}])
    expect(()=>groupVouch(empty(),{candidates:[candidate('w-000002')]},{...c,caller})).toThrow();
  expect(()=>groupVouch(empty(),{candidates:[candidate('w-malformed')]},c)).toThrow();
  expect(()=>groupVouch(empty(),{candidates:[{...candidate('w-000001'),due:Infinity}]},c)).toThrow();
});

it('does not displace an explicitly asked high-sorting id at capacity',()=>{
  const s=empty(), first=run(s,['w-ffffff'])!;
  const lower=Array.from({length:12},(_,n)=>`w-${n.toString(16).padStart(6,'0')}`);
  const card=groupVouch(s,{candidates:[candidate('w-ffffff',false),...lower.map(id=>candidate(id))]},c)!;
  expect(first.state).toBe('withdrawn');
  expect(card.target).toContain('w-ffffff');
  expect(card.target.split(',')).toHaveLength(12);
});
it('does not consolidate separate explicit cards unless a new selected candidate enters',()=>{
  const s=empty(), first=run(s,['w-000001'])!;
  const second={...structuredClone(first),id:'a-12345678',target:'art:w-000002'};
  s.approvals.push(second);
  const before=structuredClone(s);
  expect(run(s,['w-000001','w-000002'])?.id).toBe(first.id);
  expect(s).toEqual(before);
  expect(run(s,['w-000001','w-000002','w-000003'])?.target).toBe('art:w-000001,w-000002,w-000003');
  expect(first.state).toBe('withdrawn'); expect(second.state).toBe('withdrawn');
});
it('retains every explicit card if their eligible ids cannot fit in one group',()=>{
  const s=empty(), first=run(s,Array.from({length:12},(_,n)=>`w-${n.toString(16).padStart(6,'0')}`))!;
  const second={...structuredClone(first),id:'a-12345678',target:'art:w-ffffff'};
  s.approvals.push(second);
  const before=structuredClone(s);
  run(s,[...first.target.slice(4).split(','),'w-ffffff','w-fffffe']);
  expect(s).toEqual(before);
});
it('shows executable excerpts for mixed compact and UUID ids with long notes',()=>{
  const s=empty(), ids=[...Array.from({length:10},(_,n)=>`w-${n.toString(16).padStart(6,'0')}`),
    'w-00000000-0000-0000-0000-000000000000','w-11111111-1111-1111-1111-111111111111'];
  const card=groupVouch(s,{candidates:ids.map(id=>({...candidate(id),note:'Long note '.repeat(500)}))},c)!;
  expect(card.details!.length).toBeLessThanOrEqual(1000);
  expect(card.target.split(',')).toHaveLength(12);
  for(const id of ids) expect(card.details!.split('\n').find(line=>line.startsWith(id))).toContain('runs: queue');
});
