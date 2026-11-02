/**
 * Offers' install-time validation (src/offers.ts): every declaration rule in
 * projects.md "Section feeds", conversations.md "Venues" (with agent-runtime.md's
 * `send`), and agent-runtime.md's `mcp_tools` and `grants` rejects the whole
 * `loom` block; and the section-feed output schema.
 */
import { describe, it, expect } from 'vitest';
import { parseLoomBlock } from './cli/pieces-managed.js';
import { offerConflicts, parseFeed, type Offers } from './offers.js';

const BINS = ['loom-tasks', 'taskstore'];
const parse = (loom: Record<string, unknown>, bins: string[] = BINS) => parseLoomBlock(loom, 'tasks', bins);
const feed = { label: 'Tasks', argv: ['loom-tasks', 'project-feed', '--json'] };
const venue = { label: 'Slack', kind: 'live', render: ['loom-tasks', 'render', '--json'] };
const tool = { description: 'Relay a message', input_schema: { type: 'object', properties: { to: { type: 'string' } } }, argv: ['loom-tasks', 'relay'] };
const long = (n: number) => 'x'.repeat(n);

describe('sections.project', () => {
  it('accepts the documented declaration and keeps it, unfiled defaulting to false', () => {
    expect(parse({ sections: { project: feed } })).toMatchObject({ sections: { project: { ...feed, unfiled: false } } });
    expect(parse({ sections: { project: { ...feed, unfiled: true } } })).toMatchObject({ sections: { project: { unfiled: true } } });
  });

  it.each<[string, unknown, RegExp]>([
    ['an unknown section key', { project: feed, people: feed }, /one key, project/],
    ['a missing label', { project: { argv: feed.argv } }, /label is required/],
    ['an over-long label', { project: { ...feed, label: long(41) } }, /label is required/],
    ['an empty argv', { project: { ...feed, argv: [] } }, /argv is a list of 1-16/],
    ['an argv of 17', { project: { ...feed, argv: ['loom-tasks', ...Array(16).fill('x')] } }, /argv is a list of 1-16/],
    ['an over-long arg', { project: { ...feed, argv: ['loom-tasks', long(201)] } }, /at most 200/],
    ['a non-string arg', { project: { ...feed, argv: ['loom-tasks', 3] } }, /argv is a list/],
    ['an argv[0] that is not its bin', { project: { ...feed, argv: ['loom-other', 'x'] } }, /argv\[0\] must be one of the piece's own bins/],
    ['an unknown key', { project: { ...feed, colour: 'red' } }, /no key "colour"/],
    ['a non-boolean unfiled', { project: { ...feed, unfiled: 'yes' } }, /unfiled is true or false/],
    ['sections not an object', [feed], /not an object/],
  ])('rejects %s', (_what, sections, msg) => {
    expect(parse({ sections })).toMatch(msg);
  });

  it('rejects any argv when the package has no bins to check it against', () => {
    expect(parseLoomBlock({ sections: { project: feed } }, 'tasks')).toMatch(/it has none/);
  });
});

describe('venues', () => {
  it('accepts the documented declaration, with send', () => {
    const v = { ...venue, send: ['loom-tasks', 'send'] };
    expect(parse({ venues: { slack: v } })).toMatchObject({ venues: { slack: v } });
  });

  it.each<[string, unknown, RegExp]>([
    ['a bad name', { Slack: venue }, /a venue's name/],
    ['a name of 33', { [`a${long(32)}`]: venue }, /a venue's name/],
    ['nine venues', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, venue])), /at most 8/],
    ['a missing label', { slack: { kind: 'live' } }, /label is required/],
    ['an over-long label', { slack: { ...venue, label: long(41) } }, /label is required/],
    ['a missing kind', { slack: { label: 'Slack' } }, /kind is live, scheduled or agent/],
    ['an unknown kind', { slack: { ...venue, kind: 'chat' } }, /kind is live, scheduled or agent/],
    ['an empty render', { slack: { ...venue, render: [] } }, /render is a list of 1-16/],
    ['a render whose argv[0] is not its bin', { slack: { ...venue, render: ['sh', '-c', 'x'] } }, /render\[0\] must be one of/],
    ['a send whose argv[0] is not its bin', { slack: { ...venue, send: ['loom-slack', 'send'] } }, /send\[0\] must be one of/],
    ['an over-long send arg', { slack: { ...venue, send: ['loom-tasks', long(201)] } }, /send is a list/],
    ['an unknown key', { slack: { ...venue, colour: 'red' } }, /no key "colour"/],
    ['core\'s session', { session: venue }, /core's own/],
    ['core\'s wake', { wake: { ...venue, kind: 'scheduled' } }, /core's own/],
    ['relay from a piece that is not the runtime', { relay: { ...venue, kind: 'agent' } }, /only by the runtime/],
  ])('rejects %s', (_what, venues, msg) => {
    expect(parse({ venues })).toMatch(msg);
  });

  it('lets the runtime declare relay', () => {
    expect(parse({ role: 'runtime', venues: { relay: { label: 'Relay', kind: 'agent', send: ['loom-tasks', 'relay'] } } }))
      .toMatchObject({ venues: { relay: { kind: 'agent' } } });
  });
});

describe('mcp_tools', () => {
  it('accepts up to 8 tools and keeps each', () => {
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`tool_${i}`, tool]));
    expect(parse({ mcp_tools: eight })).toMatchObject({ mcp_tools: { tool_7: tool } });
  });

  it.each<[string, unknown, RegExp]>([
    ['nine tools', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tool_${i}`, tool])), /at most 8 tools/],
    ['a bad name', { 'Relay-Now': tool }, /a tool's name/],
    ['a core tool\'s name', { recall: tool }, /core's own/],
    ['a core widget tool\'s name', { loom_hello: tool }, /core's own/],
    ['a missing description', { house: { ...tool, description: undefined } }, /description is required/],
    ['an over-long description', { house: { ...tool, description: long(1001) } }, /description is required/],
    ['a missing input_schema', { house: { ...tool, input_schema: undefined } }, /input_schema is a JSON schema/],
    ['a schema that is not an object schema', { house: { ...tool, input_schema: { type: 'string' } } }, /input_schema is a JSON schema/],
    ['a schema whose properties are not an object', { house: { ...tool, input_schema: { type: 'object', properties: [] } } }, /properties is an object/],
    ['a schema over 16 KB', { house: { ...tool, input_schema: { type: 'object', description: long(17_000) } } }, /at most 16 KB/],
    ['a missing argv', { house: { ...tool, argv: undefined } }, /argv is a list/],
    ['an argv whose argv[0] is not its bin', { house: { ...tool, argv: ['node', 'x.js'] } }, /argv\[0\] must be one of/],
    ['an unknown key', { house: { ...tool, inputSchema: {} } }, /no key "inputSchema"/],
  ])('rejects %s', (_what, mcp_tools, msg) => {
    expect(parse({ mcp_tools })).toMatch(msg);
  });
});

describe('grants', () => {
  it('true or {} makes the piece the grants authority; false offers nothing', () => {
    expect(parse({ grants: true })).toMatchObject({ grants: true });
    expect(parse({ grants: {} })).toMatchObject({ grants: true });
    expect(parse({ grants: false })).not.toHaveProperty('grants');
  });

  it.each([['a string', 'yes'], ['a non-empty object', { agents: ['art'] }], ['a list', []]])('rejects %s', (_w, grants) => {
    expect(parse({ grants })).toMatch(/loom.grants is true/);
  });
});

describe('delivery', () => {
  it('a runtime-role piece declares an argv of its own bins, kept as declared', () => {
    expect(parse({ role: 'runtime', delivery: ['loom-tasks', 'deliver', '--json'] })).toMatchObject({ delivery: ['loom-tasks', 'deliver', '--json'] });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a piece with no role', { delivery: ['loom-tasks', 'deliver'] }, /loom.delivery is declared only by the runtime/],
    ['a piece with another role', { role: 'tasks', delivery: ['loom-tasks', 'deliver'] }, /loom.delivery is declared only by the runtime/],
    ['not an argv', { role: 'runtime', delivery: 'loom-tasks deliver' }, /loom.delivery is a list of 1-16/],
    ['an empty argv', { role: 'runtime', delivery: [] }, /loom.delivery is a list of 1-16/],
    ['another program', { role: 'runtime', delivery: ['sh', '-c', 'x'] }, /loom.delivery\[0\] must be one of the piece's own bins/],
  ])('rejects %s', (_w, loom, re) => {
    expect(parse(loom)).toMatch(re);
  });
});

describe('a block with an invalid offer is rejected whole', () => {
  it('even when everything else in it is fine', () => {
    expect(parse({ label: 'Tasks', settings: [{ name: 'X', label: 'x' }], sections: { project: feed }, venues: { wake: venue } })).toMatch(/core's own/);
  });

  it('a block without offers has none', () => {
    const b = parse({ label: 'Tasks' });
    expect(b).not.toHaveProperty('sections');
    expect(b).not.toHaveProperty('venues');
    expect(b).not.toHaveProperty('mcp_tools');
    expect(b).not.toHaveProperty('grants');
    expect(b).not.toHaveProperty('delivery');
  });
});

describe('offerConflicts (against the other installed pieces)', () => {
  const others: { name: string; loom: Offers }[] = [
    { name: 'runtime', loom: { grants: true, mcp_tools: { house: tool as never }, venues: { relay: { label: 'Relay', kind: 'agent' } } } },
  ];

  it('refuses a second grants authority, a tool name or a venue name another piece has', () => {
    expect(offerConflicts('other', { grants: true }, others)).toMatch(/runtime piece is already the grants authority/);
    expect(offerConflicts('other', { mcp_tools: { house: tool as never } }, others)).toMatch(/tool house is already the runtime piece's/);
    expect(offerConflicts('other', { venues: { relay: { label: 'R', kind: 'agent' } } }, others)).toMatch(/venue relay is already the runtime piece's/);
  });

  it('refuses a second delivery piece; the piece itself may update', () => {
    const withDelivery = [{ name: 'runtime', loom: { delivery: ['loom-runtime', 'deliver'] } }];
    expect(offerConflicts('rival', { delivery: ['loom-rival', 'deliver'] }, withDelivery)).toMatch(/the runtime piece already offers delivery: there is only one/);
    expect(offerConflicts('runtime', { delivery: ['loom-runtime', 'deliver', '--v2'] }, withDelivery)).toBeUndefined();
  });

  it('a piece never conflicts with its own earlier version, and distinct names pass', () => {
    expect(offerConflicts('runtime', { grants: true, mcp_tools: { house: tool as never } }, others)).toBeUndefined();
    expect(offerConflicts('other', { mcp_tools: { other_tool: tool as never }, venues: { slack: { label: 'S', kind: 'live' } } }, others)).toBeUndefined();
  });
});

describe('parseFeed (the section-feed output schema)', () => {
  const item = { title: 'Approve the WAF exception', when: '2026-11-02T14:10:00Z', who: ['Loren'], person: ['loren-smith'], status: 'open', ref: 't-1271', body: '…' };

  it('accepts the documented answer, and an empty one', () => {
    expect(parseFeed({ groups: [{ title: 'Waiting on you', items: [item] }] })).toEqual({ groups: [{ title: 'Waiting on you', items: [item] }] });
    expect(parseFeed({ groups: [] })).toEqual({ groups: [] });
  });

  it.each<[string, unknown, RegExp]>([
    ['not an object', [], /not a JSON object/],
    ['an unknown top key', { groups: [], more: 1 }, /unknown key "more"/],
    ['nine groups', { groups: Array(9).fill({ title: 'g', items: [] }) }, /at most 8/],
    ['51 items', { groups: [{ title: 'g', items: Array(26).fill(item) }, { title: 'h', items: Array(25).fill(item) }] }, /at most 50 items/],
    ['a group without a title', { groups: [{ items: [] }] }, /title is required/],
    ['a group title of 81', { groups: [{ title: long(81), items: [] }] }, /title is required/],
    ['an item without a title', { groups: [{ title: 'g', items: [{ ref: 'x' }] }] }, /title is required/],
    ['an item title of 201', { groups: [{ title: 'g', items: [{ title: long(201) }] }] }, /title is required/],
    ['a when that is not UTC', { groups: [{ title: 'g', items: [{ title: 't', when: '2026-11-02 14:10' }] }] }, /ISO-8601 UTC/],
    ['nine who', { groups: [{ title: 'g', items: [{ title: 't', who: Array(9).fill('a') }] }] }, /who is at most 8/],
    ['a person that is not a slug', { groups: [{ title: 'g', items: [{ title: 't', person: ['Loren Smith'] }] }] }, /person slugs/],
    ['a status of 25', { groups: [{ title: 'g', items: [{ title: 't', status: long(25) }] }] }, /status is at most 24/],
    ['a ref of 201', { groups: [{ title: 'g', items: [{ title: 't', ref: long(201) }] }] }, /ref is at most 200/],
    ['a body of 601', { groups: [{ title: 'g', items: [{ title: 't', body: long(601) }] }] }, /body is at most 600/],
    ['an unknown item key', { groups: [{ title: 'g', items: [{ title: 't', url: 'x' }] }] }, /unknown key "url"/],
  ])('rejects %s', (_what, v, msg) => {
    expect(parseFeed(v)).toMatch(msg);
  });
});
