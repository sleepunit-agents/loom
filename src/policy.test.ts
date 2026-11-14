import { describe, expect, it } from 'vitest';
import { mayRunPrivateWork, maySee, mayAct, mayCreate, mayMove, mayControlAuthoredWork, mayReuseAuthoredWork, consistentWorkAuthority, type WorkAuthority, type WorkAuthorship, type Viewer, type RecordScope } from './policy.js';
import { fixtureSharing } from './fixture.js';
const sharing = fixtureSharing();
const viewers: Viewer[] = [
  { kind: 'member', id: 'jonathan' }, { kind: 'member', id: 'pollock' },
  { kind: 'agent', id: 'art' }, { kind: 'agent', id: 'mark' }, { kind: 'agent', id: 'pond-bot' },
  { kind: 'runner', id: 'box' }, { kind: 'service', id: 'keyholder' },
];
describe('ordered household policy', () => {
  it.each<[string, RecordScope, boolean[]]>([
    ['pond made by Art', { project: 'pond', agent: 'art' }, [true, true, true, false, true, false, false]],
    ['other made by bot', { project: 'other', agent: 'pond-bot' }, [true, false, true, false, false, false, false]],
    ['bot personal', { agent: 'pond-bot' }, [true, true, false, false, true, false, false]],
    ['Art personal', { agent: 'art' }, [true, false, true, false, false, false, false]],
    ['Jonathan private overrides project and agent', { member: 'jonathan', project: 'pond', agent: 'pond-bot' }, [true, false, false, false, false, false, false]],
    ['Pollock private overrides owner', { member: 'pollock', project: 'other', agent: 'art' }, [false, true, false, false, false, false, false]],
    ['unfiled', {}, [true, false, false, false, false, false, false]],
    ['unknown project', { project: 'unknown', agent: 'pond-bot' }, [true, false, false, false, false, false, false]],
    ['empty field is set', { project: '', agent: 'pond-bot' }, [true, false, false, false, false, false, false]],
    ['assigned job', { type: 'runtime.job', runner: 'box' }, [true, false, false, false, false, true, false]],
    ['another job', { type: 'runtime.job', runner: 'elsewhere' }, [true, false, false, false, false, false, false]],
    ['service type', { type: 'secret' }, [true, false, false, false, false, false, true]],
    ['private service type', { type: 'secret', member: 'jonathan' }, [true, false, false, false, false, false, false]],
  ])('%s', (_, record, expected) => {
    expect(viewers.map(v => maySee(v, record, sharing))).toEqual(expected);
    expect(viewers.map(v => mayAct(v, record, sharing, v.kind === 'runner' ? 'report-job' : 'act', 'secrets.unlock'))).toEqual(expected);
  });
  it('limits work, setup, household changes and answering people', () => {
    const pollock = viewers[1], bot = viewers[4];
    for (const action of ['give-work', 'agent-setup'] as const) {
      expect(mayAct(pollock, { project: 'pond', agent: 'pond-bot' }, sharing, action)).toBe(true);
      for (const agent of ['art', 'mark']) expect(mayAct(pollock, { project: 'pond', agent }, sharing, action)).toBe(false);
      expect(mayAct(bot, { agent: 'pond-bot' }, sharing, action)).toBe(false);
    }
    expect(mayAct(viewers[0], { agent: 'pond-bot' }, sharing, 'give-work')).toBe(false);
    expect(mayAct(viewers[5], { type: 'runtime.job', runner: 'box' }, sharing, 'act')).toBe(false);
    expect(maySee(viewers[5], { type: 'task', runner: 'box' }, sharing)).toBe(false);
    for (const v of [viewers[5], viewers[6]]) expect(maySee(v, { member: '', type: 'secret', runner: 'box' }, sharing)).toBe(false);
    expect(maySee(viewers[6], { type: 'task' }, sharing)).toBe(false);
    for (const agent of ['art', 'mark']) for (const action of ['give-work', 'agent-setup'] as const) expect(mayAct(viewers[0], { agent }, sharing, action)).toBe(true);
    for (const action of ['household', 'give-work', 'answer-person'] as const) expect(mayAct(viewers[6], { type: 'secret' }, sharing, action, 'secrets.unlock')).toBe(false);
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect(maySee(pollock, { project: id }, sharing)).toBe(false);
      expect(maySee({ kind: 'member', id }, { agent: 'art' }, sharing)).toBe(false);
      expect(maySee({ kind: 'service', id }, { type: 'secret' }, sharing)).toBe(false);
    }
    expect(mayAct(pollock, { project: 'pond' }, sharing, 'household')).toBe(false);
    expect(mayAct(viewers[0], {}, sharing, 'household')).toBe(true);
    expect(mayAct(bot, { project: 'pond' }, sharing, 'answer-person')).toBe(false);
    expect(mayAct(pollock, { project: 'pond' }, sharing, 'answer-person')).toBe(true);
    expect(maySee(viewers[5], { type: 'runtime.job', runner: 'box', member: '' }, sharing)).toBe(false);
    expect(maySee(viewers[5], { type: 'runtime.job', runner: 'box', member: 'jonathan' }, sharing)).toBe(false);
    expect(mayAct(viewers[6], { type: 'secret' }, sharing, 'act', 'secrets.destroy')).toBe(false);
  });
  it('checks both ends, attached agents, and immutable private membership', () => {
    const p = viewers[1];
    expect(mayMove(p, { member: 'pollock', agent: 'pond-bot' }, { agent: 'pond-bot' }, sharing)).toBe(false);
    expect(mayCreate(viewers[6], { type: 'secret' }, sharing, 'secrets.unlock')).toBe(true);
    expect(mayMove(viewers[6], { type: 'secret' }, { type: 'secret' }, sharing, 'secrets.unlock')).toBe(true);
    expect(mayCreate(viewers[6], { type: 'secret' }, sharing, 'secrets.destroy')).toBe(false);
    expect(mayCreate(p, { member: 'pollock', project: 'other' }, sharing)).toBe(false);
    expect(mayMove(p, { project: 'pond' }, { agent: 'pond-bot' }, sharing)).toBe(true);
    expect(mayCreate(p, { project: 'pond', agent: 'art' }, sharing)).toBe(false);
    expect(mayCreate(p, { project: 'pond', agent: 'pond-bot' }, sharing)).toBe(true);
    expect(mayMove(p, { project: 'pond' }, { project: 'other' }, sharing)).toBe(false);
    expect(mayMove(p, { project: 'other' }, { project: 'pond' }, sharing)).toBe(false);
    expect(mayMove(viewers[0], { member: 'jonathan' }, { member: 'pollock' }, sharing)).toBe(false);
    expect(maySee({ kind: 'member', id: 'removed' }, { member: 'removed' }, sharing)).toBe(false);
  });
});

it('allows only an exact runner to report its own nonprivate box, without registry visibility', () => {
  const own = { type: 'runtime.box', runner: 'box' };
  const runner: Viewer = { kind: 'runner', id: 'box' };
  expect(viewers.map(v => mayAct(v, own, sharing, 'report-box'))).toEqual([false, false, false, false, false, true, false]);
  for (const record of [{ ...own, runner: 'other' }, { ...own, member: 'jonathan' }, { ...own, type: 'runtime.job' }, { type: 'runtime.box' }])
    expect(mayAct(runner, record, sharing, 'report-box')).toBe(false);
  expect(maySee(runner, own, sharing)).toBe(false);
  expect(mayAct(runner, own, sharing)).toBe(false);
});


describe('authored work authority',()=>{
  const access=structuredClone(sharing);
  access.members.other={owner:true,agents:['art']};
  const record={type:'wake',agent:'art',member:'jonathan',project:'pond'};
  const original:WorkAuthorship={origin:'art',conversation:'cv-original',member:'jonathan',project:'pond',service:'restricted',principal:{for:'owner',people:['jonathan']}};
  const current:WorkAuthority={agent:'art',conversation:'cv-original',member:'jonathan',project:'pond',service:'restricted',principal:{for:'owner',people:['jonathan']}};
  it.each(['jonathan','other'])('never borrows either owner or another token kind for %s private work',member=>{
    const r={...record,member},o={...original,member},p={...current,member};
    for(const v of [...viewers,{kind:'member' as const,id:'other'}]){
      expect(mayControlAuthoredWork(v,r,access,o,p)).toBe(v.kind==='agent'&&v.id==='art');
      expect(mayReuseAuthoredWork(v,r,access,o,p)).toBe(v.kind==='agent'&&v.id==='art');
    }
    expect(maySee({kind:'agent',id:'art'},r,access)).toBe(false);
    expect(maySee({kind:'member',id:member==='jonathan'?'other':'jonathan'},r,access)).toBe(false);
  });
  type Change={record?:Partial<typeof record>;original?:Partial<WorkAuthorship>;current?:Partial<WorkAuthority>};
  it.each<[string,Change]>([
    ['current agent',{current:{agent:'mark'}}],
    ['record agent',{record:{agent:'mark'}}],
    ['origin',{original:{origin:'mark'}}],
    ['current member',{current:{member:'other'}}],
    ['original member',{original:{member:'other'}}],
    ['current project',{current:{project:'other'}}],
    ['original project',{original:{project:'other'}}],
    ['credential service',{current:{service:'other'}}],
    ['principal',{current:{principal:{for:'pollock',people:['pollock']}}}],
    ['empty agent',{record:{agent:''}}],
    ['empty member',{record:{member:''},current:{member:''},original:{member:''}}],
    ['empty project',{record:{project:''},current:{project:''},original:{project:''}}],
  ])('refuses substitution with mismatched %s',(_name,c)=>{
    expect(mayReuseAuthoredWork({kind:'agent',id:'art'},{...record,...c.record},access,{...original,...c.original},{...current,...c.current})).toBe(false);
  });
  it('requires current proof and original evidence, and keeps exact for rather than named-owner identity',()=>{
    const v={kind:'agent' as const,id:'art'};
    expect(mayControlAuthoredWork(v,record,access,original,undefined)).toBe(false);
    expect(mayReuseAuthoredWork(v,record,access,undefined,current)).toBe(false);
    expect(mayControlAuthoredWork(v,{...record,member:undefined},access,{...original,member:undefined},{...current,member:undefined,conversation:''})).toBe(false);
    expect(mayReuseAuthoredWork(v,record,access,{...original,principal:undefined},current)).toBe(false);
    expect(mayReuseAuthoredWork(v,record,access,original,{...current,conversation:'cv-other'})).toBe(true);
    expect(mayReuseAuthoredWork(v,{...record,member:undefined},access,{...original,member:undefined},{...current,member:undefined,principal:{for:'owner',people:['other']}})).toBe(true);
    const named={for:'pollock',people:['pollock']};
    expect(mayControlAuthoredWork(v,record,access,{...original,principal:named},{...current,conversation:'cv-other',principal:named})).toBe(false);
    expect(mayReuseAuthoredWork(v,record,access,{...original,principal:named},{...current,principal:named})).toBe(true);
    const revoked=structuredClone(access);revoked.members.jonathan.agents=[];
    expect(mayReuseAuthoredWork(v,record,revoked,original,current)).toBe(false);
  });
  it('checks the independent credential witness without inventing authority for unbound callers',()=>{
    expect(consistentWorkAuthority(current,{service:'restricted'})).toBe(true);
    expect(consistentWorkAuthority(current,{service:'other'})).toBe(false);
    expect(consistentWorkAuthority(current,{service:undefined})).toBe(false);
    expect(consistentWorkAuthority(current,undefined)).toBe(true);
    expect(consistentWorkAuthority(undefined,{service:'restricted'})).toBe(true);
    expect(mayControlAuthoredWork({kind:'agent',id:'art'},record,access,original,undefined)).toBe(false);
  });
});

it('requires current independent member and project grants for owning private execution, without visibility',()=>{
 const access=fixtureSharing(),scope={member:'pollock',agent:'pond-bot',project:'pond'};
 expect(mayRunPrivateWork(scope,access)).toBe(true);
 expect(mayRunPrivateWork({...scope,agent:'art'},access)).toBe(false);
 expect(mayRunPrivateWork({...scope,project:'other'},access)).toBe(false);
 expect(mayRunPrivateWork({...scope,member:'missing'},access)).toBe(false);
 expect(mayRunPrivateWork({agent:'art'},access)).toBe(false);
 access.projects.pond.agents=[];expect(mayRunPrivateWork(scope,access)).toBe(false);
 access.projects.pond.agents=['pond-bot'];access.projects.pond.members=[];
 expect(mayRunPrivateWork(scope,access)).toBe(false);
 expect(mayRunPrivateWork({member:'jonathan',agent:'pond-bot',project:'pond'},access)).toBe(false);
 access.members.jonathan.agents.push('pond-bot');
 expect(mayRunPrivateWork({member:'jonathan',agent:'pond-bot',project:'pond'},access)).toBe(true);
 for(const viewer of [{kind:'agent',id:'pond-bot'},{kind:'service',id:'clock'},{kind:'runner',id:'a'}] as Viewer[])
  expect(maySee(viewer,{...scope,type:'wake'},access)).toBe(false);
});
