import { expect, it } from 'vitest';
import { pairEvents, type PairStep } from './pair-events.js';
it('keeps shell output and the delegate lifecycle, skips opaque tool payloads, and tells reasoning apart from tool steps', () => {
  const got: PairStep[] = [];
  const feed = pairEvents((s) => got.push(s));
  const lines = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Weighing the two checks' },
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'echo hello' } },
          {
            type: 'tool_use',
            id: 'b',
            name: 'Agent',
            input: { subagent_type: 'reviewer', description: 'Review ticket', prompt: 'private' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'héllo' },
          { type: 'tool_result', tool_use_id: 'b', content: 'private' },
        ],
      },
    },
    {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'exit 2', aggregated_output: 'failed', exit_code: 2 },
    },
    { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'read', result: 'private' } },
  ];
  const bytes = Buffer.from(lines.map((v) => JSON.stringify(v)).join('\n') + '\n');
  for (const b of bytes) feed(Buffer.from([b]));
  // The reasoning is its own kind of step: a pairing thread's cards never take it (body-program.ts drops it there).
  expect(got[0]).toMatchObject({ kind: 'reasoning', words: 'Weighing the two checks' });
  const tools = got.filter((s) => (s.kind ?? 'tool') === 'tool');
  expect(tools.map((s) => [s.tool, s.cardState])).toEqual([
    ['Terminal', 'running'],
    ['Subagent · reviewer', 'running'],
    ['Terminal', 'done'],
    ['Subagent · reviewer', 'done'],
    ['Terminal', 'failed'],
    ['read', 'done'],
  ]);
  expect(tools[2].words).toBe('héllo');
  expect(JSON.stringify(got)).not.toContain('private');
});

const fed = (rows: unknown[]) => {
  const got: PairStep[] = [];
  const feed = pairEvents((s) => got.push(s));
  // Byte by byte, so a step is decoded across the join of two pieces of output too.
  for (const b of Buffer.from(rows.map((v) => JSON.stringify(v)).join('\n') + '\n')) feed(Buffer.from([b]));
  return got;
};

it('decodes Claude Code\'s own words and readable reasoning as steps of their kinds, in order with its tool calls', () => {
  const sig = 'CAQStQUKEAgUGAI4AUIIdGhpbmtpbmc';
  // The shapes Claude Code 2.1.326 printed on 2026-11-28 (stream-json), one content block to an event.
  const got = fed([
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '', signature: sig }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'I will check both products.' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo 391; echo 399' } }] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '391\n399', is_error: false }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'The second is larger.', signature: sig }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'redacted_thinking', data: 'opaque' }] } },
    // A subagent's own words are not the session's: its answer comes back as its tool result.
    { type: 'assistant', parent_tool_use_id: 'toolu_9', message: { content: [{ type: 'text', text: 'subagent chatter' }, { type: 'thinking', thinking: 'subagent thought' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '   ' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '19×21 is larger.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '19×21 is larger.' },
  ]);
  expect(got.map((s) => [s.kind ?? 'tool', s.words])).toEqual([
    ['words', 'I will check both products.'],
    ['tool', 'echo 391; echo 399'],
    ['tool', '391\n399'],
    ['reasoning', 'The second is larger.'],
    ['words', '19×21 is larger.'],
  ]);
  // A signature, a redacted block and a subagent's words are never a step's words.
  expect(JSON.stringify(got)).not.toMatch(/CAQSt|opaque|subagent/);
});

it('decodes Codex\'s agent messages and reasoning summaries as steps of their kinds, in order with its tool calls', () => {
  const got = fed([
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Comparing products**\n\nI will multiply both.' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Checking with the shell.' } },
    { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'echo 399', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'echo 399', aggregated_output: '399\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'reasoning', text: '' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: '19×21 is larger.' } },
    { type: 'turn.completed', usage: {} },
  ]);
  expect(got.map((s) => [s.kind ?? 'tool', s.call, s.words.split('\n')[0]])).toEqual([
    ['reasoning', 'item_0', '**Comparing products**'],
    ['words', 'item_1', 'Checking with the shell.'],
    ['tool', 'item_2', 'echo 399'],
    ['tool', 'item_2', 'echo 399'],
    ['words', 'item_4', '19×21 is larger.'],
  ]);
});
