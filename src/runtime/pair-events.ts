import { StringDecoder } from 'node:string_decoder';
export interface PairStep {
  /** What the step is: a tool call or result (the default, and all a pairing thread's cards are), the agent's own
   * words between its tool calls, or its reasoning where the harness gives it as readable text. */
  kind?: 'tool' | 'words' | 'reasoning';
  call?: string;
  parent?: string;
  tool: string;
  words: string;
  cardState: 'running' | 'done' | 'failed';
}
type Row = Record<string, unknown>;
const object = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.map(object) : []);
const delegate = (n: string) => ['Agent', 'Task', 'collab_tool_call'].includes(n);
const shell = (n: string) => ['Bash', 'command_execution', 'exec_command', 'run_command'].includes(n);
function printed(v: unknown) {
  return typeof v === 'string'
    ? v
    : list(v)
        .filter((p) => p.type === 'text')
        .map((p) => text(p.text))
        .join('\n');
}

/** Decode only public work events. Raw MCP results and agent prompts are never steps. Shell output, words and
 * reasoning are checked at the body disclosure boundary (body-program.ts), which also decides who keeps the words and
 * reasoning steps: only a handed-off session's trace does, never a pairing thread's cards.
 *
 * Words and reasoning, as each harness gives them (read 2026-11-28):
 * - Claude Code (stream-json): each `assistant` event of the top-level model (`parent_tool_use_id` null) carries one
 *   content block: `{type:"text",text}` is the agent's words; `{type:"thinking",thinking,signature}` is its reasoning.
 *   On Claude Code 2.1.326 with Opus 5.5 `thinking` is always "" with only a signature, `--settings
 *   {"showThinkingSummaries":true}` included, so nothing readable comes; `{type:"redacted_thinking",data}` is never
 *   readable. A thinking block with readable text is kept; an empty or redacted one makes no step. A subagent's own
 *   words (`parent_tool_use_id` set) are not the session's: its answer is its tool result.
 * - Codex (`exec --json`): `item.completed` with `{type:"agent_message",text}` is the agent's words; `{type:"reasoning",
 *   text}` is the reasoning summary Codex prints as readable text (it never prints the encrypted reasoning). */
export function pairEvents(emit: (s: PairStep) => void) {
  const decoder = new StringDecoder('utf8'),
    calls = new Map<string, { name: string; label: string; parent?: string }>();
  let tail = '';
  function event(row: Row) {
    const item = object(row.item);
    if (row.type === 'item.completed' && (item.type === 'agent_message' || item.type === 'reasoning')) {
      const said = text(item.text);
      if (said.trim()) emit({ kind: item.type === 'agent_message' ? 'words' : 'reasoning', call: text(item.id), tool: '', cardState: 'done', words: said });
      return;
    }
    if (row.type === 'item.started' || row.type === 'item.completed') {
      const kind = text(item.type);
      if (
        ![
          'command_execution',
          'mcp_tool_call',
          'collab_tool_call',
          'file_change',
          'web_search',
          'todo_list',
          'plan',
        ].includes(kind)
      )
        return;
      const name = kind === 'mcp_tool_call' ? text(item.tool) : kind;
      const status =
        row.type === 'item.started'
          ? 'running'
          : item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
            ? 'failed'
            : 'done';
      const label = delegate(kind)
        ? 'Subagent · ' + (text(item.tool) || 'work')
        : shell(kind)
          ? 'Terminal'
          : name;
      const words = shell(kind)
        ? [
            text(item.command),
            text(item.aggregated_output),
            item.exit_code != null ? 'Exit ' + item.exit_code : '',
          ]
            .filter(Boolean)
            .join('\n')
        : kind === 'todo_list' || kind === 'plan'
          ? list(item.items)
              .map((i) => (i.completed ? '✓ ' : '• ') + text(i.text))
              .join('\n')
          : kind === 'collab_tool_call'
            ? Object.values(object(item.agents_states))
                .map((s) => text(object(s).status))
                .filter(Boolean)
                .join(', ')
            : '';
      emit({ call: text(item.id), tool: label, cardState: status, words: words || label });
      return;
    }
    if (row.type === 'assistant') {
      const own = row.parent_tool_use_id == null;
      for (const p of list(object(row.message).content)) {
        if (own && p.type === 'text' && text(p.text).trim()) emit({ kind: 'words', tool: '', cardState: 'done', words: text(p.text) });
        if (own && p.type === 'thinking' && text(p.thinking).trim()) emit({ kind: 'reasoning', tool: '', cardState: 'done', words: text(p.thinking) });
        if (p.type !== 'tool_use') continue;
        const id = text(p.id),
          name = text(p.name),
          input = object(p.input);
        if (!id || !name) continue;
        const parent = calls.get(text(row.parent_tool_use_id));
        const ownLabel = delegate(name)
          ? 'Subagent · ' + (text(input.subagent_type) || name)
          : shell(name)
            ? 'Terminal'
            : name;
        const label = parent && delegate(parent.name) ? parent.label + ' → ' + ownLabel : ownLabel;
        calls.set(id, { name, label, parent: text(row.parent_tool_use_id) });
        emit({
          call: id,
          parent: text(row.parent_tool_use_id),
          tool: label,
          cardState: 'running',
          words: shell(name)
            ? text(input.command) || label
            : delegate(name)
              ? text(input.description) || label
              : name === 'TodoWrite'
                ? list(input.todos)
                    .map((t) => text(t.status) + ' · ' + text(t.content))
                    .join('\n') || label
                : label,
        });
      }
    }
    if (row.type === 'user')
      for (const p of list(object(row.message).content)) {
        if (p.type !== 'tool_result') continue;
        const found = calls.get(text(p.tool_use_id));
        if (!found) continue;
        calls.delete(text(p.tool_use_id));
        emit({
          call: text(p.tool_use_id),
          parent: found.parent,
          tool: found.label,
          cardState: p.is_error ? 'failed' : 'done',
          words: shell(found.name) ? printed(p.content) || 'Command completed' : found.label,
        });
      }
    if (row.event === 'step_update') {
      const step = object(row.step_update);
      if (step.step_type === 'tool')
        emit({
          tool: text(step.tool_name) || 'Tool',
          words: text(step.tool_name) || 'Tool',
          cardState: step.state === 'DONE' ? 'done' : step.state === 'FAILED' ? 'failed' : 'running',
        });
    }
    if (row.event === 'tool_call' || row.event === 'tool_result') {
      const name = text(row.name) || text(object(row.tool).name);
      if (name) emit({ tool: name, words: name, cardState: row.event === 'tool_call' ? 'running' : 'done' });
    }
  }
  return (chunk: Buffer) => {
    const lines = (tail + decoder.write(chunk)).split('\n');
    tail = lines.pop() || '';
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      event(object(parsed));
    }
  };
}
