/** The `knowledge-page` brick's definition (./knowledge-page.ts), held to what it commits loom to. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bricks, catalogue, knowledgeAnnotations } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './knowledge-page.js';

it('knowledge-page: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: 'page',
    references: { page: 'knowledge page' },
    actions: { verify: 'mind.knowledgeVerify', recheck: 'mind.knowledgeRecheck', annotate: 'mind.knowledgeAnnotate' },
  });
});

describe('a knowledge page', () => {
  const place = (brick: string, params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick, params }]);
  const entry = (name: string) => catalogue().find((b) => b.name === name)!;
  it('places a knowledge page by its slug and by nothing looser', () => {
    for (const page of ['pump', 'how-the-pond-pump-runs', 'ours/pond_pump.v2', 'a'.repeat(128), 'A1'])
      expect(place('knowledge-page', { page }), page).not.toThrow();
    for (const page of ['', 'call your bank', '-pump', 'pump:now', 'pump@home', 'pump#1', 'pümp', 'a'.repeat(201), 'pump\n'])
      expect(place('knowledge-page', { page }), JSON.stringify(page)).toThrow(Refused);
    expect(place('knowledge-page', {})).toThrow(Refused);
    expect(place('knowledge-page', { page: 'pump', query: 'pump' })).toThrow(Refused);
    expect(entry('knowledge-page')).toMatchObject({ canBeBig: true, linkKey: 'page', references: { page: 'knowledge page' }, flagsItselfFor: [] });
  });
  it('lets a knowledge page be checked, and annotated with one of the kinds mind.knowledgeAnnotate takes and no words', () => {
    const board = agent(empty(), [{ change: 'place', brick: 'knowledge-page', params: { page: 'pump' } }]).board;
    for (const action of ['verify', 'recheck']) {
      expect(() => actRow(board, 'p1', action, {})).not.toThrow();
      expect(() => actRow(board, 'p1', action, { note: 'typed' })).toThrow(Refused);
    }
    expect(() => actRow(board, 'p1', 'annotate', { kind: 'outdated' })).not.toThrow();
    for (const detail of [{}, { kind: 'dispute' }, { kind: 'I typed this' }, { kind: 'note', words: 'I typed this' }])
      expect(() => actRow(board, 'p1', 'annotate', detail), JSON.stringify(detail)).toThrow(Refused);
    expect(Object.fromEntries(Object.entries(bricks.find((b) => b.name === 'knowledge-page')!.actions).map(([name, a]) => [name, a.operation])))
      .toEqual({ verify: 'mind.knowledgeVerify', recheck: 'mind.knowledgeRecheck', annotate: 'mind.knowledgeAnnotate' });
    // The kinds are the operation's own.
    const operation = readFileSync('src/pieces/mind/actions.ts', 'utf8');
    expect(operation).toContain("kind: z.enum(['outdated', 'intent', 'note', 'no-longer-owned', 'in-use'])");
    expect([...knowledgeAnnotations].sort()).toEqual(['in-use', 'intent', 'no-longer-owned', 'note', 'outdated']);
  });
});
