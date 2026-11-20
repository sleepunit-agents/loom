/** Interprets shared command metadata; only the daemon opens records or evaluates policy. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { secretCommands } from '../pieces/secrets/commands.js';
import { secretName, requestReason } from '../pieces/secrets/input.js';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
const defaults: ClientRuntime = { request: (...args) => fetch(...args), retry: ms => new Promise(resolve => setTimeout(resolve, ms)) };
const requestId = z.string().regex(/^q-(?:[0-9a-f]{8}|[0-9a-f-]{36})$/);
const metadata = z.object({ stdout: z.string(), stderr: z.string(), code: z.number().int().min(0).max(4) }).strict();
const help = `Usage: loom-secrets-client <${secretCommands.map(command => command.name).join('|')}> [args]\nValues for add/replace come from stdin only. Use Settings for interactive entry.\n`;
export async function runSecretsClient(argv: string[], io: IOStreams, runtime: ClientRuntime = defaults): Promise<number> {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { io.stdout(help); return 0; }
  const spec = secretCommands.find(command => command.name === argv[0]);
  const invalid = () => { io.stderr(help); return 2; };
  if (!spec) return invalid();
  const input: Record<string, unknown> = {}; let position = 0;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const flag = arg.slice(2), key = spec.flags && Object.hasOwn(spec.flags, flag) ? spec.flags[flag] : undefined;
      if (!key || Object.hasOwn(input, key)) return invalid();
      if (spec.booleanFlags?.includes(flag)) input[key] = true;
      else {
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) return invalid();
        if (spec.numberFlags?.includes(flag)) {
          if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
          input[key] = Number(value);
        } else input[key] = value;
      }
    } else {
      const key = spec.positional?.[position++];
      if (!key) return invalid();
      input[key] = arg;
    }
  }
  if (spec.requiredFlags?.some(flag => input[spec.flags![flag]] === undefined)) return invalid();
  if (spec.name === 'request' && !z.object({ job: z.uuid(), name: secretName, why: requestReason, minutes: z.number().int().positive().optional() }).strict().safeParse(input).success) return invalid();
  if (spec.name === 'status' && !requestId.safeParse(input.id).success) return invalid();
  if (position !== (spec.positional?.length ?? 0)) return invalid();
  if (input.name !== undefined && (typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.name))) return invalid();
  if (spec.name === 'policy') {
    if (input.action !== 'houses') return invalid();
    delete input.action; input.on = !input.off; delete input.off;
  }
  const fail = (message: string, code = 1) => { io.stderr(`loom-secrets: ${message}\n`); return code; };
  let base: URL, token: string;
  try {
    if (!io.env.LOOM_URL || !io.env.LOOM_TOKEN_FILE) return fail('LOOM_URL and LOOM_TOKEN_FILE are required');
    base = new URL(io.env.LOOM_URL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return fail('Invalid LOOM_URL');
    token = (await readFile(io.env.LOOM_TOKEN_FILE, 'utf8')).trim();
    if (!token) return fail('Token file is empty');
  } catch { return fail('Cannot configure loom connection'); }
  const emit = (stdout: string, stderr: string, code: number) => {
    if (stdout.includes(token) || stderr.includes(token)) return fail('Invalid daemon response');
    io.stdout(stdout); io.stderr(stderr); return code;
  };
  if (spec.operation === 'command') input.command = spec.name;
  if (spec.write && spec.name !== 'request') input.writeId = randomUUID();
  if (spec.name === 'policy') delete input.writeId;
  if (spec.name === 'add' || spec.name === 'replace') {
    if (io.stdinIsTTY) return fail('Pipe a value on stdin, or use Settings for interactive entry', 2);
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of io.stdin) {
        const bytes = Buffer.from(chunk); chunks.push(bytes); size += bytes.length;
        if (size > 65538) throw Error();
      }
      const bytes = Buffer.concat(chunks);
      try {
        const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, '');
        if (!value.length || Buffer.byteLength(value) > 65536) return fail('Value must contain 1 to 65536 UTF-8 bytes', 2);
        input.value = value; input.mode = spec.name === 'add' ? 'add' : 'replace';
      } finally { bytes.fill(0); }
    } catch { return fail('Cannot read a bounded UTF-8 value from stdin', 2); }
    finally { for (const bytes of chunks) bytes.fill(0); }
  }
  const body = JSON.stringify({ input, ...(spec.write ? { id: randomUUID() } : {}) });
  // Same complete request, writeId and registry id on every uncertain retry.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await runtime.request(new URL(`/api/secrets/${spec.operation}`, base), {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(5000),
      });
      if (response.status === 503 && attempt < 3) { await response.body?.cancel().catch(() => {}); await runtime.retry(100 * (attempt + 1)); continue; }
      const text = await response.text();
      if (text.includes(token)) return fail('Invalid daemon response');
      const envelope = z.object({ ok: z.boolean(), value: z.unknown().optional(), code: z.string().optional() }).safeParse(JSON.parse(text));
      if (!envelope.success) return fail('Invalid daemon response');
      if (!response.ok || !envelope.data.ok) {
        if (spec.name === 'state' && envelope.data.code === 'not-found') return emit('', 'loom secrets: there is no such request\n', 3);
        return fail('Request refused', envelope.data.code === 'denied' ? 4 : envelope.data.code === 'invalid' ? 2 : envelope.data.code === 'not-found' ? 3 : 1);
      }
      if (spec.operation === 'command') {
        const result = metadata.safeParse(envelope.data.value);
        if (!result.success) return fail('Invalid daemon response');
        return emit(result.data.stdout, result.data.stderr, result.data.code);
      }
      if (spec.name === 'request' || spec.name === 'status') {
        const schema = spec.name === 'request'
          ? z.object({ id: requestId, state: z.enum(['pending', 'allowed', 'denied', 'cancelled', 'revoked']) }).strict()
          : z.object({ state: z.enum(['pending', 'granted', 'expired', 'denied', 'cancelled', 'revoked']) }).strict();
        const result = schema.safeParse(envelope.data.value);
        if (!result.success) return fail('Invalid daemon response');
        return emit(JSON.stringify(result.data) + '\n', '', spec.name === 'request' && result.data.state === 'denied' ? 1 : 0);
      }
      const result = spec.operation === 'set' ? z.object({ saved: z.literal(true) }).strict().safeParse(envelope.data.value)
        : spec.operation === 'remove' ? z.object({ removed: z.literal(true) }).strict().safeParse(envelope.data.value)
        : z.object({ default: z.enum(['ask', 'auto', 'never']), secrets: z.record(z.string(), z.unknown()) }).strict().safeParse(envelope.data.value);
      if (!result.success) return fail('Invalid daemon response');
      return emit('', spec.name === 'rm' ? `removed ${input.name}\n` : spec.name === 'policy'
        ? `${input.agent}'s houses ${input.on ? 'get' : 'no longer get'} ${input.name} when they start\n` : `stored ${input.name}\n`, 0);
    } catch { if (attempt === 3) return fail('loom daemon is unavailable'); }
    await runtime.retry(100 * (attempt + 1));
  }
  return fail('loom daemon is unavailable');
}
