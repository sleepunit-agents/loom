import { expect, expectTypeOf, it } from 'vitest';
import type { triggers, triggerLog, agentPauses } from '../../../../src/core/data/schema';
import { rows, recordedOutcomes, history, source, status, type Trigger, type TriggerEvent, type AgentPause } from './model';

it('uses the shared schema field shapes without pulling server modules into the browser', () => {
  expectTypeOf<Trigger>().toEqualTypeOf<typeof triggers.$inferSelect>();
  expectTypeOf<TriggerEvent>().toEqualTypeOf<typeof triggerLog.$inferSelect>();
  expectTypeOf<AgentPause>().toEqualTypeOf<typeof agentPauses.$inferSelect>();
});

const trigger = (id: string, fields: Partial<Trigger> = {}): Trigger => ({
  id, ownerKind: 'agent', owner: 'art', sourceKind: 'time', watches: null, times: '07:17', days: '',
  lifespan: 'once', targetKind: 'inbox', target: null, toKind: 'agent', to: 'art', project: null,
  instructions: 'Check delivery', file: null, note: id, enabled: true, state: 'standing',
  nextDueAt: null, lastFiredAt: null, createdAt: '2026-11-14T00:00:00.000Z', changedAt: '2026-11-14T00:00:00.000Z', ...fields,
});

it('keeps timeless answer waits and held work visible in Due; recurring work stays Standing', () => {
  const items = [trigger('answer', { sourceKind: 'answer', watches: 'approval:a-1' }),
    trigger('held', { state: 'held' }), trigger('daily', { lifespan: 'until-stopped' }),
    trigger('finished', { state: 'fired', enabled: false })];
  expect(rows(items, 'due').map(item => item.id)).toEqual(['answer', 'held']);
  expect(rows(items, 'standing').map(item => item.id)).toEqual(['daily']);
  expect(rows(items, 'history').map(item => item.id)).toEqual(['finished']);
});

it('distinguishes household lanes, ordinary schedules, and stopped lanes', () => {
  const items = [trigger('lane', { ownerKind: 'household', owner: null, lifespan: 'until-stopped' }),
    trigger('schedule', { lifespan: 'until-stopped' }),
    trigger('stopped-lane', { ownerKind: 'household', owner: null, lifespan: 'until-stopped', state: 'stopped' })];
  expect(rows(items, 'lanes').map(item => item.id)).toEqual(['lane']);
  expect(rows(items, 'standing').map(item => item.id)).toEqual(['schedule']);
  expect(rows(items, 'history').map(item => item.id)).toEqual(['stopped-lane']);
});

it('does not label a one-off time as an everyday schedule', () => {
  expect(source(trigger('once', { times: '2026-11-15T07:17:00Z' }))).toBe('2026-11-15T07:17:00Z');
  expect(source(trigger('daily', { lifespan: 'until-stopped' }))).toBe('07:17 · Every day');
});

it('orders deadlines before timeless waits, searches words, and separates person and agent recipients', () => {
  const items = [trigger('wait'), trigger('later', { nextDueAt: '2026-11-16T00:00:00.000Z' }),
    trigger('sooner', { nextDueAt: '2026-11-15T00:00:00.000Z' }), trigger('person', { toKind: 'person', to: 'art' })];
  expect(rows(items, 'due', ' DELIVERY ', 'art').map(item => item.id)).toEqual(['sooner', 'later', 'wait']);
});

it('shows pause status only for live agent work and isolates each trigger history by sequence', () => {
  const pauses = [{ agent: 'art', since: '2026-11-14T00:00:00.000Z' }];
  expect(status(trigger('held'), pauses)).toBe('Held · agent paused');
  expect(status(trigger('done', { state: 'fired' }), pauses)).toBe('fired');
  expect(status(trigger('person', { toKind: 'person' }), pauses)).toBe('standing');
  const events = [1, 3, 2].map(seq => ({ seq, trigger: seq === 3 ? 'other' : 'held', at: pauses[0].since, event: 'set', note: '' }));
  expect(history(events, 'held').map(event => event.seq)).toEqual([2, 1]);
});
it('orders mixed UTC precision by instant and keeps internal source fingerprints out of the displayed history',()=>{
 const earlier=trigger('earlier',{nextDueAt:'2026-11-15T00:00:00Z',changedAt:'2026-11-15T00:00:00Z',state:'fired'});
 const later=trigger('later',{nextDueAt:'2026-11-15T00:00:00.500Z',changedAt:'2026-11-15T00:00:00.500Z',state:'fired'});
 expect(rows([later,earlier],'history').map(t=>t.id)).toEqual(['later','earlier']);
 expect(rows([{...later,state:'standing'},{...earlier,state:'standing'}],'due').map(t=>t.id)).toEqual(['earlier','later']);
 expect(history([{seq:1,trigger:'earlier',at:earlier.changedAt,event:'source-snapshot',note:'internal-fingerprint'},
  {seq:2,trigger:'earlier',at:earlier.changedAt,event:'fired',note:'Delivery'}],'earlier').map(e=>e.seq)).toEqual([2]);
});

it('lists distant wakes before unscheduled and spent triggers, including old rows with a retained due time', () => {
  const items = [
    trigger('spent', {state:'fired',enabled:false,nextDueAt:'2026-11-15T00:00:00Z'}),
    trigger('wait', {sourceKind:'answer',times:null}),
    trigger('next-month', {nextDueAt:'2026-12-15T12:00:00Z'}),
    trigger('tomorrow', {nextDueAt:'2026-11-25T12:00:00Z'}),
  ];
  expect(rows(items,'all').map(item=>item.id)).toEqual(['tomorrow','next-month','spent','wait']);
});

it('counts reported missed runs across a downtime summary and preserves a lower bound',()=>{
  const missed = (note:string)=>({state:'missed',note,scheduled:false});
  const individual = Array.from({length:20},()=>missed('time:2026-11-01T12:00:00Z'));
  expect(recordedOutcomes([...individual,missed('780 more, the last at time:2027-12-19T12:00:00Z')])).toEqual(['800 missed runs reported']);
  expect(recordedOutcomes([...individual,missed('more than 4980 more')])).toEqual(['More than 5000 missed runs reported']);
  expect(recordedOutcomes([missed('time:2026-11-01T12:00:00Z'),{state:'fired',scheduled:false},{state:'standing',scheduled:true}])).toEqual(['1 missed run reported','1 fired']);
});
