import { describe, expect, it } from 'vitest';
import { emptyProvenance, noteProvenance, principalForWork, principalFromHistory, resetProvenance, type ProvenanceRow } from './provenance.js';

describe('runtime sender history', () => {
  it('keeps unplaced history unknown and re-evaluates former owners', () => {
    const before = emptyProvenance();
    const owner = noteProvenance(before, { kind: 'person', person: 'jonathan' }, ['jonathan']);
    expect(before).toEqual(emptyProvenance());
    expect(principalFromHistory(owner, ['jonathan'])).toEqual({ for: 'owner', people: [] });
    expect(principalFromHistory(owner, ['mark'])).toEqual({ for: 'jonathan', people: ['jonathan'] });
    const unknown = noteProvenance(owner, { kind: 'agent' }, ['jonathan']);
    expect(principalFromHistory(noteProvenance(unknown, { kind: 'person', person: 'jonathan' }, ['jonathan']), ['jonathan']).for).toBe('?');
  });

  it('never defaults an empty history or an unnamed wake to owner', () => {
    expect(principalFromHistory(emptyProvenance(), ['jonathan']).for).toBe('?');
    for (const who of [undefined, '-', 'bad person']) {
      expect(principalFromHistory(noteProvenance(emptyProvenance(), { kind: 'schedule', for: who }, ['jonathan']), ['jonathan']).for).toBe('?');
    }
    expect(principalFromHistory(noteProvenance(emptyProvenance(), { kind: 'schedule', for: 'mark' }, ['jonathan']), ['jonathan'])).toEqual({ for: 'mark', people: ['mark'] });
  });

  it('recounts late arrivals and never adopts a person or a named wake', () => {
    const rows: ProvenanceRow[] = [
      { key: 'relay', sender: { kind: 'agent' } },
      { key: 'wake', sender: { kind: 'schedule', for: '-' } },
    ];
    expect(principalFromHistory(resetProvenance(rows, ['relay', 'wake'], ['jonathan']), ['jonathan'])).toEqual({ for: 'owner', people: [] });
    const late: ProvenanceRow = { key: 'late', sender: { kind: 'agent' } };
    expect(principalFromHistory(resetProvenance([...rows, late], ['relay', 'wake'], ['jonathan']), ['jonathan']).for).toBe('?');
    for (const sender of [{ kind: 'person', person: 'mark' }, { kind: 'schedule', for: 'mark' }] as const) {
      expect(principalFromHistory(resetProvenance([{ key: 'forged', sender }], ['forged'], ['jonathan']), ['jonathan'])).toEqual({ for: 'mark', people: ['mark'] });
    }
    // A row that was missing the clock's word is not an explicitly unknown wake.
    expect(principalFromHistory(resetProvenance([{ key: 'old', sender: { kind: 'schedule' } }], ['old'], ['jonathan']), ['jonathan']).for).toBe('?');
  });

  it('fails closed when the bounded named history overflows', () => {
    let history = emptyProvenance();
    for (let i = 0; i < 21; i++) history = noteProvenance(history, { kind: 'person', person: `person-${i}` }, []);
    expect(history.people).toHaveLength(20);
    expect(history.unknown).toBe(true);
    expect(principalFromHistory(history, []).for).toBe('?');
  });
});

it('retains a named owner through scheduled transfer so demotion narrows later steering',()=>{
 const history=noteProvenance(emptyProvenance(),{kind:'person',person:'jonathan'},['jonathan']);
 const original=principalForWork(history,['jonathan']);
 expect(original).toEqual({for:'owner',people:['jonathan']});
 let next=noteProvenance(emptyProvenance(),{kind:'schedule',for:original.for},['jonathan']);
 for(const person of original.people)next=noteProvenance(next,{kind:'person',person},['jonathan']);
 expect(principalForWork(next,[])).toEqual({for:'jonathan',people:['jonathan']});
 expect(principalForWork({...next,unknown:true},['jonathan'])).toEqual({for:'?',people:['jonathan']});
});
