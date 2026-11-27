import { expect, it } from 'vitest';
import { pairEvents, type PairStep } from './pair-events.js';
it('keeps shell output and the delegate lifecycle, skips reasoning and opaque tool payloads', () => {
  const got: PairStep[] = [];
  const feed = pairEvents((s) => got.push(s));
  const lines = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'private' },
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
  expect(got.map((s) => [s.tool, s.cardState])).toEqual([
    ['Terminal', 'running'],
    ['Subagent · reviewer', 'running'],
    ['Terminal', 'done'],
    ['Subagent · reviewer', 'done'],
    ['Terminal', 'failed'],
    ['read', 'done'],
  ]);
  expect(got[2].words).toBe('héllo');
  expect(JSON.stringify(got)).not.toContain('private');
});
