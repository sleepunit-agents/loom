/**
 * The tasks' live records in the window (web/src/tasks-live.ts, tasks-pages.ts, comms-work.tsx; t-2029): which pages read
 * them, when a set read in pages is whole, what moved, and which moves a thread's work panel reads again for.
 */
import { describe, it, expect } from 'vitest';
import { movedKeys, recordsOf } from '../../web/src/tasks-live';
import { tasksPageKind } from '../../web/src/tasks-pages';
import { concerns, type WorkItem } from '../../web/src/comms-work';
import type { Rec, ViewState } from '../../web/src/collections/runtime';

const rec = (id: string, more: Record<string, unknown> = {}): Rec => ({ key: `tasks/task/${id}`, ...more });
const state = (keys: string[], o: Partial<ViewState> = {}): ViewState => ({ keys, withheld: [], status: 'live', more: false, ...o });

describe('the tasks\' live records', () => {
  it('a Tasks work page is theirs alone; a task\'s own page and a project\'s read them too; nothing else does', () => {
    expect(['/p/tasks', '/p/tasks?sort=new&show=open', '/p/tasks/', '/a/art/p/tasks'].map(tasksPageKind)).toEqual(['live', 'live', 'live', 'live']);
    expect(['/p/tasks/task/t-12', '/projects', '/projects/art/app', '/projects/app?x=1'].map(tasksPageKind)).toEqual(['also', 'also', 'also', 'also']);
    expect(['/', '/p/tasksx', '/p/changes', '/inbox', '/a/art/p/changes', '/projectsx'].map(tasksPageKind)).toEqual([null, null, null, null, null, null]);
  });

  it('a set is whole once it\'s live with no next page, and inside the window core keeps current', () => {
    const records = new Map([[rec('t-1').key, rec('t-1')]]);
    expect(recordsOf(state(['tasks/task/t-1']), records)?.size).toBe(1);
    expect(recordsOf(state(['tasks/task/t-1'], { more: true }), records)).toBeNull();
    expect(recordsOf(state(['tasks/task/t-1'], { status: 'loading' }), records)).toBeNull();
    expect(recordsOf(state(['tasks/task/t-1'], { status: 'stale' }), records)).toBeNull();
    expect(recordsOf(state(Array.from({ length: 1000 }, (_, i) => `tasks/task/t-${i}`)), records)).toBeNull();
  });

  it('what moved: a new copy, a new key, a key gone; never one left as it was', () => {
    const a = rec('t-1'), b = rec('t-2'), c = rec('t-3');
    const was = new Map([[a.key, a], [b.key, b]]);
    expect([...movedKeys(was, new Map([[a.key, a], [b.key, { ...b }], [c.key, c]]))].sort()).toEqual([b.key, c.key]);
    expect([...movedKeys(was, new Map([[a.key, a]]))]).toEqual([b.key]);
    expect(movedKeys(was, new Map(was)).size).toBe(0);
  });

  it('a thread\'s work panel reads again for a task it shows or one made in it, not another\'s', () => {
    const shown: WorkItem[] = [{ title: 'x', ref: 't-5', status: 'Open', from: 'tasks' }, { title: 'y', ref: 'github:o/r#3', status: 'Open', from: 'changes' }];
    const cv = 'cv-0123456789ab';
    const records = new Map([['tasks/task/t-9', rec('t-9', { source: `conversation:${cv}` })], ['tasks/task/t-8', rec('t-8', { source: 'conversation:cv-ffffffffffff' })]]);
    expect(concerns(new Set(['tasks/task/t-5']), records, shown, cv)).toBe(true);
    expect(concerns(new Set(['tasks/task/t-9']), records, shown, cv)).toBe(true);
    expect(concerns(new Set(['tasks/task/t-8', 'tasks/task/t-7']), records, shown, cv)).toBe(false);
  });
});
