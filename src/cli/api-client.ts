/** A generated command surface interpreted from operation metadata. No app stores or domain transitions. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IOStreams } from './io.js';
import { readStdin } from './io.js';
import type { CliCommand } from '../core/operations/index.js';
export interface ClientRuntime { request: typeof fetch; retry(ms: number): Promise<void> }
const runtimeDefault: ClientRuntime = { request: (...args) => fetch(...args), retry: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export async function runApiClient(piece: string, commands: readonly CliCommand[], argv: string[], io: IOStreams, runtime: ClientRuntime = runtimeDefault): Promise<number> {
  const verb = argv[0], spec = commands.find(c => c.name === verb);
  const help = `usage: ${piece === 'tasks' ? 'taskstore' : `loom ${piece}`} <${commands.map(c => c.name).join('|')}> ...\n`;
  if (verb === '--help' || verb === '-h') { io.stdout(help); return 0; }
  if (!spec) { io.stderr(help); return 2; }
  const input: Record<string, unknown> = { cli: true };
  if (verb === 'update') input.set = {};
  const positional: string[] = [], flags: Record<string, string> = Object.create(null);
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i] ?? '';
    else positional.push(argv[i]);
  }
  const unknown = Object.keys(flags).filter(k => !Object.hasOwn(spec.flags ?? {}, k));
  if (unknown.length) { io.stderr(`unknown flag${unknown.length > 1 ? 's' : ''} for '${verb}': ${unknown.map(k => `--${k}`).join(', ')}\n`); return 2; }
  const assign = (path: string, value: unknown) => {
    const [parent, key] = path.split('.');
    if (key) ((input[parent] ??= {}) as Record<string, unknown>)[key] = value;
    else input[parent] = value;
  };
  const reject = (code: string, message: string) => { io.stderr(`taskstore: ${message}\n`); io.stdout(JSON.stringify({ ok: false, errors: [code], message }, null, 2) + '\n'); return 1; };
  for (let i = 0; i < (spec.positional?.length ?? 0); i++) {
    const key = spec.positional![i];
    if (key === 'payload@file') {
      try {
        const payload = JSON.parse(await readFile(positional[i], 'utf8')) as Record<string, unknown>;
        for (const key of spec.fileFields ?? Object.keys(payload)) if (payload[key] !== undefined) input[key] = payload[key];
      }
      catch { return reject('E_FILE', "can't read import payload"); }
    } else if (positional[i] !== undefined) assign(key, positional[i]);
  }
  for (const [flag, value] of Object.entries(flags)) {
    const path = spec.flags![flag];
    if (path.endsWith('@file')) {
      if (input.text !== undefined) { io.stderr('taskstore: comment takes its text inline or from --file, not both\n'); return 2; }
      if (!value) { io.stderr('taskstore: --file needs a path (or - for stdin)\n'); return 2; }
      let text: string;
      try { text = (value === '-' ? await readStdin(io.stdin) : await readFile(value, 'utf8')).replace(/\r?\n$/, ''); }
      catch (err) { return reject('E_FILE', `can't read --file ${value}: ${(err as Error).message}`); }
      if (!text.trim()) return reject('E_EMPTY', `--file ${value} has no text`);
      assign(path.slice(0, -5), text);
    } else assign(path, path === 'priority' || path.endsWith('.priority') ? Number(value) : value);
  }
  const conversation = io.env.LOOM_BODY_CONVERSATION?.trim();
  if (conversation && /^cv-[0-9a-f]{12}$/.test(conversation)) {
    if (verb === 'create' && !('source' in input)) input.source = `conversation:${conversation}`;
    if (verb === 'update') input.sourceHint = `conversation:${conversation}`;
  }
  // Attribution is part of the legacy binding contract; server supplies the clock.
  if (spec.write) input.actor = io.env.TASKSTORE_ACTOR ?? 'art';
  let base: URL, token: string;
  try {
    base = new URL(io.env.LOOM_URL ?? 'http://127.0.0.1:8787');
    if (!io.env.LOOM_TOKEN_FILE) throw new Error('LOOM_TOKEN_FILE is required');
    token = (await readFile(io.env.LOOM_TOKEN_FILE, 'utf8')).trim();
    if (!token) throw new Error('Token file is empty');
  } catch (e) { return reject('E_UNAVAILABLE', (e as Error).message); }
  const body = JSON.stringify({ input, ...(spec.write ? { id: randomUUID() } : {}) });
  let answer: unknown;
  // Same operation id on every retry: a dropped response never repeats the write.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await runtime.request(new URL(`/api/${piece}/${verb}`, base), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(1500) });
      answer = await response.json();
      if (response.status !== 503 || attempt === 3) break;
    } catch { if (attempt === 3) return reject('E_UNAVAILABLE', 'loom daemon is unavailable'); }
    await runtime.retry(100 * (attempt + 1));
  }
  const envelope = (answer && typeof answer === 'object' ? answer : {}) as { ok?: boolean; value?: { result?: Record<string, unknown>; stderr?: string[] }; code?: string; message?: string };
  const result = envelope.ok === true && envelope.value?.result && typeof envelope.value.result === 'object' && !Array.isArray(envelope.value.result) && typeof envelope.value.result.ok === 'boolean' ? envelope.value.result : { ok: false, errors: [envelope.code ?? 'E_UNAVAILABLE'], message: envelope.message ?? 'Invalid daemon response' };
  if (Array.isArray(result.warnings)) for (const w of result.warnings) io.stderr(`taskstore: warning: ${String(w)}\n`);
  for (const line of envelope.value?.stderr ?? []) io.stderr(`${line}\n`);
  io.stdout(JSON.stringify(result, null, 2) + '\n');
  return result.ok !== true ? 1 : (verb === 'unlink' && result.removed !== true) || (verb === 'link' && result.linked !== true) ? 3 : 0;
}
