import { describe, expect, it } from 'vitest';
import { discordAttachmentLabels, discordBodyWords } from './discord-link.js';
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
  it('takes a written ping of a bot\'s own role as a mention of that bot, and no other role as anyone\'s', () => {
    const channel = { id: 'channel', guild: 'guild', kind: 'channel' } as const;
    const botRoles = new Map([['role-art', 'bot-art'], ['role-mark', 'bot-mark']]);
    const mentions = (changes: object) => normalizeDiscord(discord, dc({ mentions: [], ...changes }), channel, botRoles)?.mentions;
    expect(mentions({ content: 'hey <@&role-art>', mention_roles: ['role-art'] })).toEqual(['bot-art']);
    // Both bots' roles, and a user mention of one of them, name each bot once.
    expect(mentions({ content: '<@&role-art> <@&role-mark> <@bot-art>', mention_roles: ['role-art', 'role-mark'], mentions: [{ id: 'bot-art' }] })).toEqual(['bot-art', 'bot-mark']);
    // A role that is no bot's, written or not; a bot's role Discord did not resolve (in a code block); one resolved and not written.
    expect(mentions({ content: '<@&crew> hello', mention_roles: ['crew'] })).toEqual([]);
    expect(mentions({ content: '`<@&role-art>`', mention_roles: [] })).toEqual([]);
    expect(mentions({ content: 'hello', mention_roles: ['role-art'] })).toEqual([]);
    expect(mentions({ content: '@everyone @here <@&guild>', mention_roles: [], mention_everyone: true })).toEqual([]);
    // With no roles read, a role ping is nobody's.
    expect(normalizeDiscord(discord, dc({ mentions: [], content: '<@&role-art>', mention_roles: ['role-art'] }), channel)?.mentions).toEqual([]);
  });
  it('takes a message in a thread as answering whoever wrote the message the thread was started from', () => {
    const thread = { id: 'thread', guild: 'guild', kind: 'thread', parent: 'parent', starter: 'bot' } as const;
    const inThread = (changes = {}) => normalizeDiscord(discord, dc({ channel_id: 'thread', mentions: [], ...changes }), thread);
    expect(inThread()).toMatchObject({ repliesTo: 'bot', mentions: [] });
    // A reply inside the thread answers the message it points at, not the thread's root.
    expect(inThread({ type: 19, referenced_message: { author: { id: 'someone' } } })).toMatchObject({ repliesTo: 'someone' });
    expect(inThread({ type: 19, referenced_message: null })).not.toHaveProperty('repliesTo');
    // A thread whose starter is not known, and a channel, answer nobody.
    expect(normalizeDiscord(discord, dc({ channel_id: 'thread', mentions: [] }), { id: 'thread', guild: 'guild', kind: 'thread', parent: 'parent' })).not.toHaveProperty('repliesTo');
    expect(normalizeDiscord(discord, dc({ mentions: [] }), { id: 'channel', guild: 'guild', kind: 'channel' })).not.toHaveProperty('repliesTo');
  });
  it('lists a message\'s attachments after its words, so a picture alone has words', () => {
    const channel = { id: 'channel', guild: 'guild', kind: 'channel' } as const;
    const words = (changes: object) => normalizeDiscord(discord, dc({ mentions: [], ...changes }), channel)?.text;
    const cat = { filename: 'cat.png', size: 2048, content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1&is=2&hm=3' };
    expect(words({ content: '', attachments: [cat] })).toBe('[attachment: cat.png (image/png, 2048 bytes)]');
    expect(words({ content: 'look', attachments: [cat, { filename: 'notes.txt', size: 3, url: 'https://media.discordapp.net/attachments/1/2/notes.txt' }] }))
      .toBe('look\n[attachment: cat.png (image/png, 2048 bytes)]\n[attachment: notes.txt (unknown type, 3 bytes)]');
    // A link that is not on Discord's file hosts is not passed on, and a name cannot close the line or run on.
    expect(words({ content: '', attachments: [{ filename: 'a]\n[attachment: b', size: 1, content_type: 'text/plain', url: 'https://evil.example/cdn.discordapp.com/x' }] }))
      .toBe('[attachment: a_attachment: b (text/plain, 1 bytes)]');
    expect(words({ content: '', attachments: [{ ...cat, filename: 'n'.repeat(500) }] })).toContain(`[attachment: ${'n'.repeat(200)} (`);
    // A malformed CDN link still leaves the name and kind in the transcript.
    expect(words({ content: '', attachments: [{ ...cat, url: 'https://cdn.discordapp.com/attachments/1/2/..\\cat.png' }] })).toBe('[attachment: cat.png (image/png, 2048 bytes)]');
    // No more are listed than one Discord message can carry.
    expect(words({ content: '', attachments: Array(12).fill(cat) })).toContain('[2 additional attachments exceed the message attachment limit]');
    expect(words({ content: 'plain' })).toBe('plain');
  });
  it('preserves platform identity and text, and normalises timestamps and mentions', () => {
    expect(normalizeDiscord(discord, dc({ content: '<@bot> hello <@!bot>' }), { id: 'channel', guild: 'guild', kind: 'channel' })).toEqual({
      id: 'message', connection: 'dc', channel: 'channel', isDm: false, user: 'person',
      text: '<@bot> hello <@!bot>', postedAt: '2026-11-14T16:00:00.000Z', mentions: ['bot'], bot: false, webhook: false,
    });
  });
  it('says whose message an explicit reply answers, with or without the reply ping', () => {
    const channel = { id: 'channel', guild: 'guild', kind: 'channel' } as const;
    const reply = (changes = {}) => normalizeDiscord(discord, dc({ type: 19, content: 'hello', referenced_message: { author: { id: 'bot' } }, ...changes }), channel);
    // Ping on: Discord also lists the bot among the mentions. Ping off: it does not. Either way the reply answers the bot.
    expect(reply()).toMatchObject({ repliesTo: 'bot', mentions: [] });
    expect(reply({ mentions: [] })).toMatchObject({ repliesTo: 'bot', mentions: [] });
    // The message replied to was deleted, or this is no reply at all: nobody is answered.
    expect(reply({ referenced_message: null })).not.toHaveProperty('repliesTo');
    expect(normalizeDiscord(discord, dc({ content: 'hello', referenced_message: { author: { id: 'bot' } } }), channel)).not.toHaveProperty('repliesTo');
    // Slack's reply is a reply in a thread: it answers whoever wrote the thread's root. The root itself answers nobody.
    expect(normalizeSlack(slack, sl({ ts: '1794672002.000001', thread_ts: '1794672000.000001', parent_user_id: 'UBOT' }))).toMatchObject({ repliesTo: 'UBOT' });
    expect(normalizeSlack(slack, sl({ ts: '1794672000.000001', thread_ts: '1794672000.000001', parent_user_id: 'UBOT' }))).not.toHaveProperty('repliesTo');
  });
  it('does not count the reply ping, or an unresolved mention in the text, as a written mention', () => {
    const channel = { id: 'channel', guild: 'guild', kind: 'channel' } as const;
    // A reply to the bot's message: Discord lists the bot although nobody wrote its mention.
    expect(normalizeDiscord(discord, dc({ type: 19, content: 'hello' }), channel)?.mentions).toEqual([]);
    // Mention text Discord did not resolve (inside a code block, say) summons nobody.
    expect(normalizeDiscord(discord, dc({ content: '`<@other>` and <@bot>' }), channel)?.mentions).toEqual(['bot']);
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
  it.each(['channel','group'] as const)('retains %s thread roots from event or resolved metadata without conflating independent posts',kind => {
    for(const channel_type of [kind,undefined]){
      const channel={id:'C1',kind};
      expect(normalizeSlack(slack, sl({channel_type,thread_ts:'1794671900.000001'}),channel)?.thread).toBe('1794671900.000001');
      expect(normalizeSlack(slack, sl({channel_type}),channel)?.thread).toBe('1794672000.123456');
      expect(normalizeSlack(slack, sl({channel_type,ts:'1794672000.123457'}),channel)?.thread).toBe('1794672000.123457');
    }
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

it('carries authenticated group-DM classification without accepting a claimed private/group flag from message data', () => {
 expect(normalizeDiscord(discord, dc({guild_id:undefined}), {id:'channel',kind:'dm',group:true})).toMatchObject({isDm:true,groupDm:true});
 expect(normalizeDiscord(discord, dc({guild_id:undefined,groupDm:true}), {id:'channel',kind:'dm'})).not.toHaveProperty('groupDm');
 expect(normalizeSlack(slack, sl({channel_type:'mpim'}))).toMatchObject({isDm:true,groupDm:true});
 expect(normalizeSlack(slack, sl({channel_type:'im',groupDm:true}))).not.toHaveProperty('groupDm');
});

it('treats only whole normalized lines as attachment hints',()=>{
 expect(discordAttachmentLabels('I saw [attachment: x (image/png, 3 bytes)] in chat.')).toEqual([]);
 const raw='[attachment: x (image/png, 3 bytes) https://media.discordapp.net/attachments/1/2/x?hm=sign]';
 expect(discordAttachmentLabels(raw)).toEqual([{name:'x',bytes:3}]);
 expect(discordBodyWords(raw)).toBe('[attachment: x (image/png, 3 bytes)]');
 expect(discordBodyWords('website: https://example.com')).toBe('website: https://example.com');
});

describe('provider labels for contact sightings', () => {
  it('keeps Slack room profile text and tolerates absent or unusable labels', () => {
    const message = (changes: object) => normalizeSlack(slack, sl(changes));
    const user_profile = { display_name: '  Robin  ', real_name: 'Robin Example' };
    expect(message({user_profile})).toMatchObject({user: 'U1', authorLabel: 'Robin'});
    expect(message({user_profile: {...user_profile, display_name: ''}})?.authorLabel).toBe('Robin Example');
    for (const changes of [{user_profile: 1}, {user_profile: {display_name: 'a\nb'}},
      {user_profile, bot_id: 'B1'}, {user_profile, channel_type: 'im'}, {user_profile, channel_type: 'mpim'}]) {
      expect(message(changes)).toMatchObject({user: 'U1'});
      expect(message(changes)?.authorLabel).toBeUndefined();
    }
  });

  it('keeps Discord display text scoped to human room senders', () => {
    const channel = {id: 'channel', guild: 'guild', kind: 'channel'} as const;
    const author = {id: 'person', global_name: 'Robin', username: 'robin1'};
    expect(normalizeDiscord(discord, dc({author}), channel)?.authorLabel).toBe('Robin');
    expect(normalizeDiscord(discord, dc({author:{...author,global_name:'Robin 👩‍💻'},timestamp:'2026-11-14T10:00:00.123999-06:00'}), channel))
      .toMatchObject({authorLabel:'Robin 👩‍💻',sightedAt:'2026-11-14T16:00:00.123999Z'});
    expect(normalizeDiscord(discord, dc({author: {...author, global_name: null}}), channel)?.authorLabel).toBe('robin1');
    expect(normalizeDiscord(discord, dc({author, webhook_id: 'hook'}), channel)?.authorLabel).toBeUndefined();
    expect(normalizeDiscord(discord, dc({author: {...author, bot: true}}), channel)?.authorLabel).toBeUndefined();
    expect(normalizeDiscord(discord, dc({author, guild_id: undefined}), {id: 'channel', kind: 'dm'})?.authorLabel).toBeUndefined();
  });
});
