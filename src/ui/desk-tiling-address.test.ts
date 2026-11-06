// The tiled desktop's address (docs/specs/desk-tiling.md, "The address"; criterion 14's parsing half).
import { describe, it, expect } from 'vitest';
import { nameOf, readSet, writeSet } from '../../web/src/tiling/address';

describe('the tiled desktop\'s address', () => {
  it('reads the set: apps in order, the focused, the pinned, the minimized; the rest is the page\'s own', () => {
    const r = readSet('/comms?sort=new&t=tasks!,*comms&m=inbox');
    expect(r.page).toBe('/comms?sort=new');
    expect(r.set).toEqual({ t: [{ name: 'tasks', pinned: true }, { name: 'comms', focused: true }], m: ['inbox'] });
    expect(readSet('/p/tasks?t=*tasks!').set!.t).toEqual([{ name: 'tasks', focused: true, pinned: true }]);
  });

  it('has no set without t or m, and drops what it can\'t read', () => {
    expect(readSet('/inbox?i=3')).toEqual({ set: null, page: '/inbox?i=3' });
    // a name twice, a bad name, a second focused, a pin past position 0, a minimized app that's on screen
    expect(readSet('/x?t=*a,a,b!,*c,%3Cx%3E&m=a,d').set).toEqual({ t: [{ name: 'a', focused: true }, { name: 'b' }, { name: 'c' }], m: ['d'] });
  });

  it('writes the set after the page\'s own query, as the spec writes it', () => {
    expect(writeSet('/comms/th/7f3a', { t: [{ name: 'tasks', pinned: true }, { name: 'comms', focused: true }, { name: 'inbox' }], m: ['boxes'] }))
      .toBe('/comms/th/7f3a?t=tasks!,*comms,inbox&m=boxes');
    expect(writeSet('/p/tasks?sort=updated&t=old', { t: [{ name: 'tasks', focused: true }], m: [] })).toBe('/p/tasks?sort=updated&t=*tasks');
    expect(writeSet('/', { t: [], m: [] })).toBe('/');
    const s = { t: [{ name: 'inbox' }, { name: 'comms', focused: true }], m: ['tasks'] };
    expect(readSet(writeSet('/comms', s))).toEqual({ set: s, page: '/comms' });
  });

  it('names an app by its key\'s last part', () => {
    expect([nameOf('/p/tasks'), nameOf('/a/art'), nameOf('/inbox'), nameOf('/setup')]).toEqual(['tasks', 'art', 'inbox', 'setup']);
  });
});
