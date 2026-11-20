import { expect, it } from 'vitest';
import { cardTalk, cardTalkQuery, talkPath } from './talk';

const row = (id: string, fields: object = {}) => ({ id, agent: 'art', label: `Talk ${id}`, venue: 'loom', place: `th:${id}`, lastAt: '2026-11-14T10:00:00Z', ...fields });
const answered = (id: string, at: string, words: string) => row(id, { lastAnswer: { at, words } });

it('asks for one agent’s recent conversations and its latest answered one in a single request, and never a thread', () => {
  expect(cardTalkQuery).toContain('recent: recentConversations(agent: $agent, limit: $limit)');
  expect(cardTalkQuery).toContain('answered: recentConversations(agent: $agent, limit: 1, answeredOnly: true)');
  expect(cardTalkQuery).not.toMatch(/messages|threads|answer\s*\{/);
});
it('keeps the newest conversations up to its limit and the latest answer, for this agent only, each with where it opens', () => {
  const talk = cardTalk({ status: 'live', data: {
    recent: [row('a', { lastAt: '2026-11-14T01:00:00Z' }), row('b', { lastAt: '2026-11-14T03:00:00Z', venue: 'slack', place: '["T1","C1",null]', label: '' }), row('c', { lastAt: '2026-11-14T02:00:00Z', venue: 'terminal' }), row('other', { agent: 'mark', lastAt: '2026-11-14T09:00:00Z' })],
    answered: [answered('old', '2026-11-14T11:00:00Z', '<script>agent words</script>'), answered('foreign', '2026-11-14T12:00:00Z', 'Another agent’s words')].map((item, n) => n ? { ...item, agent: 'mark' } : item),
  } }, 'art', 2);
  expect(talk).toEqual({ status: 'live', answer: { at: '2026-11-14T11:00:00Z', words: '<script>agent words</script>', path: '/p/comms-preview/thread/old' },
    recent: [{ id: 'b', title: 'Conversation', at: '2026-11-14T03:00:00Z', path: '/p/comms-preview/conversation/b' }, { id: 'c', title: 'Talk c', at: '2026-11-14T02:00:00Z', path: '/p/comms-preview/thread/c' }] });
  expect(talkPath({ id: 'cv/1', venue: 'wake', place: 'tr-1' })).toBe('/p/comms-preview/conversation/cv%2F1');
});
it.each(['loading', 'offline', 'denied'] as const)('keeps no answer words and no titles while %s', status => {
  const data = { recent: [row('a')], answered: [answered('a', '2026-11-14T11:00:00Z', 'Private retained words')] };
  expect(cardTalk({ status, data }, 'art', 3)).toEqual({ status, recent: [] });
});
it('has no answer when the latest answered conversation holds none, and is not live without data', () => {
  expect(cardTalk({ status: 'live', data: { recent: [], answered: [row('a', { lastAnswer: null })] } }, 'art', 3)).toEqual({ status: 'live', answer: undefined, recent: [] });
  expect(cardTalk({ status: 'live' }, 'art', 3)).toEqual({ status: 'loading', recent: [] });
  expect(cardTalk({ status: 'live', data: { recent: null as never, answered: [] } }, 'art', 3)).toEqual({ status: 'offline', recent: [] });
});
