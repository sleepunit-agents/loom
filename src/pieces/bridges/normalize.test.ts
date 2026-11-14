import { describe, expect, it } from 'vitest';
import { normalizeDiscord, normalizeSlack } from './normalize.js';

const discord = { id: 'dc', workspace: 'guild' };
const slack = { id: 'sl', workspace: 'team' };
const dc = (changes = {}) => ({ op: 0, t: 'MESSAGE_CREATE', d: {
  id: 'message', type: 0, channel_id: 'channel', guild_id: 'guild',
  author: { id: 'person' }, content: 'hello', timestamp: '2026-11-14T10:00:00-06:00',
  mentions: [{ id: 'bot' }, { id: 'bot' }], ...changes,
} });
const sl = (changes = {}) => ({ type: 'event_callback', team_id: 'team', event: {
  type: 'message', channel: 'C1', channel_type: 'channel', ts: '1794672000.123456',
  user: 'U1', text: '<@U2> hello <@U2> <@U3|name> <!channel> https://x/<@bad-id>', ...changes,
} });

describe('authenticated Discord message normalisation', () => {
  it('preserves platform identity and text, and normalises timestamps and mentions', () => {
    expect(normalizeDiscord(discord, dc(), { id: 'channel', guild: 'guild', kind: 'channel' })).toEqual({
      id: 'message', connection: 'dc', channel: 'channel', isDm: false, user: 'person',
      text: 'hello', postedAt: '2026-11-14T16:00:00.000Z', mentions: ['bot'], bot: false, webhook: false,
    });
  });
  it('uses the resolved thread parent for filters and retains the actual thread', () => {
    expect(normalizeDiscord(discord, dc({ channel_id: 'thread', type: 19 }),
      { id: 'thread', guild: 'guild', kind: 'thread', parent: 'parent' })).toMatchObject({
      channel: 'thread', parent: 'parent', thread: 'thread', isDm: false,
    });
  });
  it('requires the channel resolver to identify DMs', () => {
    expect(normalizeDiscord(discord, dc({ guild_id: undefined }), { id: 'channel', kind: 'dm' })?.isDm).toBe(true);
    expect(() => normalizeDiscord(discord, dc(), { id: 'channel', guild: 'guild', kind: 'dm' })).toThrow();
    expect(() => normalizeDiscord(discord, dc({ guild_id: undefined }), { id: 'channel', kind: 'channel' })).toThrow();
  });
  it('rejects workspace, channel and parent mismatches', () => {
    expect(() => normalizeDiscord(discord, dc({ guild_id: 'other' }), { id: 'channel', guild: 'other', kind: 'channel' })).toThrow();
    expect(() => normalizeDiscord(discord, dc(), { id: 'wrong', guild: 'guild', kind: 'channel' })).toThrow();
    expect(() => normalizeDiscord(discord, dc(), { id: 'channel', guild: 'guild', kind: 'thread' })).toThrow();
  });
  it('carries bot and webhook flags without treating claimed members as household identity', () => {
    const result = normalizeDiscord(discord, dc({ author: { id: 'bot', bot: true }, webhook_id: 'hook', member: 'owner' }),
      { id: 'channel', guild: 'guild', kind: 'channel' });
    expect(result).toMatchObject({ user: 'bot', bot: true, webhook: true });
    expect(result).not.toHaveProperty('member');
  });
  it('preserves application command responses for downstream bot policy', () => {
    for (const type of [20, 23]) {
      expect(normalizeDiscord(discord, dc({ type, author: { id: 'app', bot: true }, content: 'response' }),
        { id: 'channel', guild: 'guild', kind: 'channel' }))
        .toMatchObject({ user: 'app', bot: true, text: 'response' });
    }
  });
  it('ignores other dispatches and system messages', () => {
    expect(normalizeDiscord(discord, { op: 0, t: 'TYPING_START', d: {} }, { id: 'x', kind: 'dm' })).toBeNull();
    expect(normalizeDiscord(discord, dc({ type: 7 }), { id: 'channel', guild: 'guild', kind: 'channel' })).toBeNull();
  });
  it('rejects malformed messages rather than manufacturing missing fields', () => {
    for (const changes of [{ author: null }, { timestamp: 'bad' }, { mentions: null }, { content: 7 }]) {
      expect(() => normalizeDiscord(discord, dc(changes), { id: 'channel', guild: 'guild', kind: 'channel' })).toThrow();
    }
  });
});

describe('authenticated Slack message normalisation', () => {
  it('uses channel-scoped message ids and deduplicates user mentions', () => {
    const result = normalizeSlack(slack, sl());
    expect(result).toMatchObject({ id: '["C1","1794672000.123456"]', connection: 'sl', channel: 'C1',
      user: 'U1', text: sl().event.text, postedAt: '2026-11-14T16:00:00.123Z', mentions: ['U2', 'U3'], isDm: false, bot: false });
    expect(normalizeSlack(slack, sl({ channel: 'C2' }))?.id).not.toEqual(result?.id);
  });
  it('excludes code examples from addressed routing while retaining surrounding mentions', () => {
    const text = '<@U2> `<@U3>` ```\n<@U4>\n``` <@U5> `unfinished <@U6>';
    expect(normalizeSlack(slack, sl({ text }))).toMatchObject({ text, mentions: ['U2', 'U5'] });
    expect(normalizeSlack(slack, sl({ text: '```<@U7>' }))?.mentions).toEqual([]);
  });
  it('retains thread roots without conflating independent channel messages', () => {
    expect(normalizeSlack(slack, sl({ thread_ts: '1794671900.000001' }))?.thread).toBe('1794671900.000001');
    expect(normalizeSlack(slack, sl())?.thread).toBeUndefined();
  });
  it('recognises direct and group direct messages from the authenticated channel type', () => {
    for (const channel_type of ['im', 'mpim']) expect(normalizeSlack(slack, sl({ channel_type }))?.isDm).toBe(true);
    expect(normalizeSlack(slack, sl({ channel_type: 'group' }))?.isDm).toBe(false);
  });
  it('keeps user ids for bot accounts and separates legacy integration ids', () => {
    expect(normalizeSlack(slack, sl({ bot_id: 'B1' }))).toMatchObject({ user: 'U1', bot: true });
    expect(normalizeSlack(slack, sl({ user: undefined, bot_id: 'B1', subtype: 'bot_message' })))
      .toMatchObject({ user: 'bot:B1', bot: true });
    expect(() => normalizeSlack(slack, sl({ user: undefined }))).toThrow();
  });
  it('ignores edit/delete/summary and membership events without interpreting nested messages', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'message_replied', 'channel_join']) {
      expect(normalizeSlack(slack, sl({ subtype, message: { text: 'nested' } }))).toBeNull();
    }
    expect(normalizeSlack(slack, sl({ type: 'reaction_added' }))).toBeNull();
  });
  it('accepts empty attachment messages and broadcast copies with stable ids', () => {
    expect(normalizeSlack(slack, sl({ subtype: 'file_share', text: '' }))?.text).toBe('');
    expect(normalizeSlack(slack, sl({ subtype: 'thread_broadcast' }))?.id).toBe(normalizeSlack(slack, sl())?.id);
  });
  it('preserves user-authored /me action messages', () => {
    expect(normalizeSlack(slack, sl({ subtype: 'me_message', channel_type: undefined, text: 'waves to <@U2>' }), { id: 'C1', kind: 'channel' }))
      .toMatchObject({ user: 'U1', text: 'waves to <@U2>', mentions: ['U2'], bot: false });
  });
  it('requires matching resolved metadata when Slack omits its channel type', () => {
    expect(() => normalizeSlack(slack, sl({ channel_type: undefined }))).toThrow();
    expect(normalizeSlack(slack, sl({ channel_type: undefined }), { id: 'C1', kind: 'im' })?.isDm).toBe(true);
    expect(() => normalizeSlack(slack, sl(), { id: 'C2', kind: 'channel' })).toThrow();
    expect(() => normalizeSlack(slack, sl(), { id: 'C1', kind: 'im' })).toThrow();
  });
  it('deduplicates app-mention and message subscriptions by the same platform identity', () => {
    expect(normalizeSlack(slack, sl({ type: 'app_mention', channel_type: undefined }), { id: 'C1', kind: 'channel' }))
      .toEqual(normalizeSlack(slack, sl()));
  });
  it('rejects wrong workspaces and malformed timestamp/channel fields', () => {
    expect(() => normalizeSlack(slack, { ...sl(), team_id: 'other' })).toThrow();
    for (const changes of [{ ts: 'NaN' }, { ts: '1794672000.1' }, { thread_ts: 'bad' }, { channel_type: 'unknown' }, { text: 1 }]) {
      expect(() => normalizeSlack(slack, sl(changes))).toThrow();
    }
  });
});
