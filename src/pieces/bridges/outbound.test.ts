import { describe, expect, it, vi } from 'vitest';
import { postReply, replyParts } from './outbound.js';

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
    await expect(postReply('slack', text, post)).rejects.toThrow('Empty bridge reply');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('one sequential reply attempt', () => {
  it('waits for each receipt before the next post and returns only the final id', async () => {
    let release!: (receipt: { id: string }) => void;
    const first = new Promise<{ id: string }>(resolve => { release = resolve; });
    const post = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ id: 'last', text: 'not returned' });
    const sending = postReply('discord', 'x'.repeat(2001), post);
    expect(post).toHaveBeenCalledTimes(1);
    release({ id: 'first' });
    await expect(sending).resolves.toEqual({ id: 'last' });
    expect(post.mock.calls.map(args => args[0])).toEqual(['x'.repeat(2000), 'x']);
  });
  it.each([0, 1, 2])('stops at failure on chunk %s without retry or leaking upstream details', async failed => {
    const calls: string[] = [];
    const post = async (part: string) => {
      calls.push(part);
      if (calls.length === failed + 1) throw new Error('token-and-message-words');
      return { id: `post-${calls.length}` };
    };
    await expect(postReply('discord', 'x'.repeat(4500), post)).rejects.toEqual(new Error('Bridge reply attempt uncertain'));
    expect(calls).toHaveLength(failed + 1);
  });
  it.each([undefined, null, {}, { id: '' }, { id: ' ' }, { id: 123 }])('treats malformed receipt %j as uncertain and stops', async result => {
    const post = vi.fn().mockResolvedValue(result);
    await expect(postReply('slack', 'x'.repeat(4000), post)).rejects.toThrow('Bridge reply attempt uncertain');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
