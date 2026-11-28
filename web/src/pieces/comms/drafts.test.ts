/** The Comms draft's storage (./drafts.ts): reading where nothing was kept writes nothing; an old text-only draft is
 * upgraded once, keeping its words. */
import { beforeEach, expect, it, vi } from 'vitest';
import { draftKey, readDraft } from './drafts';

const kept = new Map<string, string>();
const writes = vi.fn();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => { writes('set', key); kept.set(key, value); },
  removeItem: (key: string) => { writes('remove', key); kept.delete(key); },
});
beforeEach(() => { kept.clear(); writes.mockReset(); });

it('reads an empty draft and touches no storage when nothing was kept', () => {
  expect(readDraft('sam', 'th:a')).toEqual({ id: '', text: '' });
  expect(writes).not.toHaveBeenCalled();
});
it('upgrades an old text-only draft once, keeping its words under a retry id', () => {
  kept.set(draftKey('sam', 'th:a'), 'old words');
  const draft = readDraft('sam', 'th:a');
  expect(draft).toEqual({ id: expect.stringMatching(/^[a-z2-7]{16}$/), text: 'old words' });
  expect(kept.has(draftKey('sam', 'th:a'))).toBe(false);
  expect(readDraft('sam', 'th:a')).toEqual(draft);
});
