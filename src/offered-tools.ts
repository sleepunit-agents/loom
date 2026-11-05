/**
 * Offered MCP tools (docs/specs/agent-runtime.md, "Seams this needs from core", 2, `mcp_tools`):
 * the tools a managed piece offers, added to an agent's MCP session, and the one way core runs one.
 *
 *  - **Only when offered.** A session's tools are read when it opens: an installed managed piece's
 *    `mcp_tools` (offers-registry.ts). Uninstall the piece and new sessions don't have them. A name
 *    core uses, or that two pieces offer (install refuses both; piece.json may be edited by hand),
 *    is left out rather than one picked.
 *  - **As the session's agent.** Core asks the grants authority first (src/grants.ts), as for any
 *    call an agent makes to a piece, with path `tools/<name>`. Then it runs the tool's argv plus
 *    `--agent <agent>` (and `--house`, `--service` for a house's token), the arguments as JSON on stdin, with that agent's store grant, under the
 *    `mcp_tools` limits (120 s, an answer of at most 64 KB, a pool of its own).
 *  - **The answer** is `{text, isError?}` (text at most 64 KB). A tool that exits non-zero with such
 *    an answer on stdout is that answer, an error. Anything else is an error saying what went wrong.
 */
import { askGrant } from './grants.js';
import { isCoreMcpTool, type McpToolOffer } from './offers.js';
import { piecesOffering, runOffer } from './offers-registry.js';

export interface OfferedTool {
  piece: string;
  name: string;
  offer: McpToolOffer;
}

/** Who calls: the session's agent, and the house (and its service) its token is, when it's a house's. */
export interface ToolCaller {
  kind: 'agent';
  agent: string;
  service?: string;
  house?: string;
}

export interface ToolAnswer {
  text: string;
  isError?: boolean;
}

/** The answer's text cap: the mcp_tools limit (the whole answer is held to it too). */
export const MAX_TOOL_TEXT = 64 * 1024;

/** Every tool the installed managed pieces offer, by name; a name core has, or two pieces offer, is left out. */
export function offeredTools(env: NodeJS.ProcessEnv): OfferedTool[] {
  const all: OfferedTool[] = [];
  for (const p of piecesOffering(env, 'mcp_tools')) {
    for (const [name, offer] of Object.entries(p.offers.mcp_tools ?? {})) all.push({ piece: p.piece, name, offer });
  }
  const count = new Map<string, number>();
  for (const t of all) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  return all.filter((t) => !isCoreMcpTool(t.name) && count.get(t.name) === 1).sort((a, b) => a.name.localeCompare(b.name));
}

/** A tool's answer checked: `{text, isError?}`; a string says what's wrong. */
export function parseToolAnswer(v: unknown): ToolAnswer | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  const o = v as Record<string, unknown>;
  const bad = Object.keys(o).find((k) => k !== 'text' && k !== 'isError');
  if (bad !== undefined) return `unknown key ${JSON.stringify(bad)}`;
  if (typeof o.text !== 'string' || o.text.length > MAX_TOOL_TEXT) return `text is a string of at most ${MAX_TOOL_TEXT} characters`;
  if (o.isError !== undefined && typeof o.isError !== 'boolean') return 'isError is true or false';
  return { text: o.text, ...(o.isError ? { isError: true } : {}) };
}

/** Run an offered tool as `agent` with `args`. Never throws: every failure is an error answer. */
export async function callOfferedTool(env: NodeJS.ProcessEnv, tool: OfferedTool, caller: ToolCaller, args: unknown): Promise<ToolAnswer> {
  const { agent } = caller;
  const no = await askGrant(env, { agent, piece: tool.piece, path: `tools/${tool.name}` });
  if (no) return { text: `${tool.name}: ${no.error}`, isError: true };
  const r = await runOffer(env, tool.piece, tool.offer.argv, {
    kind: 'mcp_tools', stdin: JSON.stringify(args ?? {}), caller, parse: parseToolAnswer,
    args: ['--agent', agent, ...(caller.house ? ['--house', caller.house] : []), ...(caller.service ? ['--service', caller.service] : [])],
  });
  if (r.ok) return r.value;
  // A tool that refused (exit non-zero) says why in its own answer.
  if (r.answer !== undefined) {
    const a = parseToolAnswer(r.answer);
    if (typeof a !== 'string') return { text: a.text, isError: true };
  }
  return { text: `${tool.name}: the ${tool.piece} piece didn't answer (${r.error})`, isError: true };
}
