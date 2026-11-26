import { StringDecoder } from 'node:string_decoder';
export interface PairStep {
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

/** Decode only public work events. Reasoning blocks, raw MCP results and agent prompts
 * are never conversation cards. Shell output is checked at the body disclosure boundary. */
export function pairEvents(emit: (s: PairStep) => void) {
  const decoder = new StringDecoder('utf8'),
    calls = new Map<string, { name: string; label: string }>();
  let tail = '';
  function event(row: Row) {
    const item = object(row.item);
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
      let words = shell(kind)
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
      emit({ tool: label, cardState: status, words: words || label });
      return;
    }
    if (row.type === 'assistant') {
      for (const p of list(object(row.message).content)) {
        if (p.type !== 'tool_use') continue;
        const id = text(p.id),
          name = text(p.name),
          input = object(p.input);
        if (!id || !name) continue;
        const label = delegate(name)
          ? 'Subagent · ' + (text(input.subagent_type) || name)
          : shell(name)
            ? 'Terminal'
            : name;
        calls.set(id, { name, label });
        emit({
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
