import { expect, it, vi } from 'vitest';
import { failure, type Viewer } from '../../core/index.js';
import { attentionProjects } from './projects.js';
const viewer: Viewer = { kind: 'member', id: 'guest' };
it('forwards the original viewer and typed read failures without inventing an empty result', () => {
  for (const code of ['denied', 'unavailable'] as const) {
    const refused = failure(code, 'Projects cannot answer');
    const call = vi.fn(() => refused), projects = attentionProjects({ call });
    expect(projects.resolve(viewer, 'pond', 'art')).toEqual(refused);
    expect(projects.byVenue(viewer, 'loom:thread-1', 'art')).toEqual(refused);
    expect(call.mock.calls).toEqual([[viewer, 'projectsList', {}], [viewer, 'projectsList', {}]]);
  }
});
it('never selects archived or other-agent records even when the role returns them', () => {
  const call = vi.fn(() => ({ ok: true as const, value: [
    { agent: 'mark', slug: 'other', archived: false, card: { links: { aliases: ['on-pond'], venues: ['loom:thread-1'] } } },
    { agent: 'art', slug: 'old', archived: true, card: { links: { aliases: ['on-pond'], venues: ['loom:thread-1'] } } },
  ] }));
  const projects = attentionProjects({ call });
  expect(projects.resolve(viewer, 'on-pond', 'art')).toEqual({ ok: true, value: null });
  expect(projects.byVenue(viewer, 'loom:thread-1', 'art')).toEqual({ ok: true, value: [] });
});
