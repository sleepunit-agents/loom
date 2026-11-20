import { describe, expect, it, vi } from 'vitest';
import { BridgeReplyNotSent, postReply, replyParts } from './outbound.js';

describe('outbound reply parts', () => {
  it.each([['discord', 2000], ['slack', 3900]] as const)('%s preserves legacy line replies within its cap', (platform, limit) => {
    const text = 'line\n'.repeat(2000);
    const parts = replyParts(platform, text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.length > 0 && part.length <= limit)).toBe(true);
    expect(parts.join('')).toBe(text);
    expect(parts.slice(0, -1).every(part => part.endsWith('\n'))).toBe(true);
  });
  it.each([['discord', 2000], ['slack', 3900]] as const)('%s handles exact boundaries and unbroken text', (platform, limit) => {
    for (const length of [1, limit - 1, limit, limit + 1, limit * 3 + 1]) {
      const text = 'x'.repeat(length), parts = replyParts(platform, text);
      expect(parts).toHaveLength(Math.ceil(length / limit));
      expect(parts.every(part => part.length <= limit)).toBe(true);
      expect(parts.join('')).toBe(text);
    }
  });
  it.each(['discord', 'slack'] as const)('%s preserves Unicode and whitespace, including blank lines at cuts', platform => {
    const limit = platform === 'discord' ? 2000 : 3900;
    for (const text of [
      'x'.repeat(limit - 1) + '🐟'.repeat(limit),
      '🐟'.repeat(limit + 1),
      '  prefix\r\n' + 'x'.repeat(limit - 20) + '\n\n\n  tail  \n',
      'a\n' + 'x'.repeat(limit * 2) + '\n',
      'x'.repeat(limit) + '\n'.repeat(limit) + 'end',
    ]) {
      const parts = replyParts(platform, text);
      expect(parts.join('')).toBe(text);
      expect(parts.every(part => part.length > 0 && part.length <= limit)).toBe(true);
      expect(parts.every(part => !/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part))).toBe(true);
    }
  });
  it.each(['', ' \n\t'])('rejects an empty reply before posting', async text => {
    const post = vi.fn();
    await expect(postReply('slack', text, 0, post, () => {})).rejects.toThrow('Empty bridge reply');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('one sequential reply attempt', () => {
  it('waits for each receipt before the next post, and tells of each part as it is confirmed', async () => {
    let release!: (receipt: { id: string }) => void;
    const first = new Promise<{ id: string }>(resolve => { release = resolve; });
    const post = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ id: 'last', text: 'not returned' });
    const confirmed = vi.fn(), sending = postReply('discord', 'x'.repeat(2001), 0, post, confirmed);
    expect(post).toHaveBeenCalledTimes(1); expect(confirmed).not.toHaveBeenCalled();
    release({ id: 'first' });
    await expect(sending).resolves.toEqual({ parts: 2, done: true });
    expect(post.mock.calls.map(args => args[0])).toEqual(['x'.repeat(2000), 'x']);
    expect(confirmed.mock.calls).toEqual([[0, 'first'], [1, 'last']]);
  });
  it.each([0, 1, 2])('stops at failure on chunk %s without retry or leaking upstream details, and says what was confirmed', async failed => {
    const calls: string[] = [], confirmed = vi.fn();
    const post = async (part: string) => {
      calls.push(part);
      if (calls.length === failed + 1) throw new Error('token-and-message-words');
      return { id: `post-${calls.length}` };
    };
    const attempt = await postReply('discord', 'x'.repeat(4500), 0, post, confirmed);
    expect(attempt).toEqual({ parts: failed, done: false });
    expect(JSON.stringify(attempt)).not.toContain('token');
    expect(calls).toHaveLength(failed + 1); expect(confirmed).toHaveBeenCalledTimes(failed);
  });
  it('goes on from the part an earlier attempt stopped at, posting nothing before it', async () => {
    const post = vi.fn().mockResolvedValueOnce({ id: 'second' }).mockResolvedValueOnce({ id: 'third' }), confirmed = vi.fn();
    expect(await postReply('discord', 'a'.repeat(2000) + 'b'.repeat(2000) + 'c', 1, post, confirmed)).toEqual({ parts: 3, done: true });
    expect(post.mock.calls.map(args => args[0])).toEqual(['b'.repeat(2000), 'c']);
    expect(confirmed.mock.calls).toEqual([[1, 'second'], [2, 'third']]);
    // Everything was already out: nothing is posted.
    expect(await postReply('discord', 'x', 1, post, confirmed)).toEqual({ parts: 1, done: true }); expect(post).toHaveBeenCalledTimes(2);
  });
  it('says when the part it stopped at never left', async () => {
    const refusal = new BridgeReplyNotSent(true);
    const post = vi.fn().mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(refusal);
    expect(await postReply('discord', 'x'.repeat(2001), 0, post, () => {})).toEqual({ parts: 1, done: false, refused: refusal });
  });
  it('calls a part unconfirmed when it could not be put on record, and stops', async () => {
    const post = vi.fn().mockResolvedValue({ id: 'out' });
    expect(await postReply('discord', 'x'.repeat(2001), 0, post, () => { throw new Error('database is locked'); })).toEqual({ parts: 0, done: false });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, {}, { id: '' }, { id: ' ' }, { id: 123 }])('treats malformed receipt %j as unconfirmed and stops', async result => {
    const post = vi.fn().mockResolvedValue(result);
    expect(await postReply('slack', 'x'.repeat(4000), 0, post, () => {})).toEqual({ parts: 0, done: false });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
