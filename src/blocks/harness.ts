/**
 * Harness manifest reader.
 *
 * Each harness an agent has ever sleeved into gets one manifest at
 * `<contextDir>/harnesses/<client>.md`. The manifest describes the
 * harness independently of the model running inside it — tool prefixes,
 * delegation primitive, scheduling, session search, known gotchas.
 *
 * Contract: stack spec v1 §4.7.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFrontmatter, type Block } from './types.js';
import { assertSafePathSegment } from '../path-safety.js';

const DIR = 'harnesses';

export async function read(contextDir: string, key: string): Promise<Block | null> {
  assertSafePathSegment(key, 'harness name');
  const path = resolve(contextDir, DIR, `${key}.md`);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  if (raw.trim() === '') return null;
  const { frontmatter, body } = parseFrontmatter(raw);
  return { key, frontmatter, body: body.trim(), path };
}

export async function list(contextDir: string): Promise<string[]> {
  const path = resolve(contextDir, DIR);
  if (!existsSync(path)) return [];
  const entries = await readdir(path);
  return entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

/**
 * Normalize an MCP peer's clientInfo.name to a harness-filename-shaped key.
 *
 * Proxies annotate the name with a trailing parenthetical, e.g.
 * "claude-ai (via mcp-remote 0.1.37)" — strip that first, then lowercase and
 * collapse spaces/underscores to hyphens so "Claude Desktop" and "claude_desktop"
 * both land on "claude-desktop".
 */
export function normalizePeer(peerName: string): string {
  const base = peerName.split(/\s*\(/, 1)[0];
  return base.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Resolve a connected MCP peer to a harness manifest key, DATA-DRIVEN from the
 * manifest files on disk (not a hardcoded code map). A harness is recognized
 * when the normalized peer matches either the manifest's filename OR one of the
 * comma-separated values in its `answersTo` frontmatter (each normalized the
 * same way). A brand-new harness is recognized by dropping a file — no code
 * change. Returns undefined when nothing matches.
 */
export async function resolvePeerToHarness(
  contextDir: string,
  peerName?: string,
): Promise<string | undefined> {
  if (!peerName) return undefined;
  const normalized = normalizePeer(peerName);
  if (!normalized) return undefined;

  const keys = await list(contextDir);

  // Filename match is the cheapest and most direct signal.
  if (keys.includes(normalized)) return normalized;

  // Otherwise scan each manifest's answersTo frontmatter for the peer.
  for (const key of keys) {
    const block = await read(contextDir, key);
    if (!block) continue;
    const answersTo = block.frontmatter.answersTo;
    if (!answersTo) continue;
    const aliases = answersTo
      .split(',')
      .map((alias) => normalizePeer(alias))
      .filter(Boolean);
    if (aliases.includes(normalized)) return key;
  }

  return undefined;
}

// ─── Self-describe ───────────────────────────────────────────────────────────

export interface DescribeResult {
  key: string;
  path: string;
  action: 'created' | 'overwritten';
}

/**
 * Write (or overwrite) a harness manifest from a connected harness describing
 * itself. Lands strictly under `<contextDir>/harnesses/<targetKey>.md` with
 * stamped frontmatter (harness/version/updated) followed by the provided body.
 * Re-runnable — overwrites. assertSafePathSegment guards the key so the creed
 * and other tiers are structurally unreachable.
 */
export async function describeHarness(
  contextDir: string,
  targetKey: string,
  content: string,
  opts: { version?: string } = {},
): Promise<DescribeResult> {
  assertSafePathSegment(targetKey, 'harness name');
  const dir = resolve(contextDir, DIR);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${targetKey}.md`);
  const exists = existsSync(path);
  const version = opts.version ?? '0.1';
  const body = content.trim();
  const manifest =
    `---\n` +
    `harness: ${targetKey}\n` +
    `version: ${version}\n` +
    `updated: ${new Date().toISOString()}\n` +
    `---\n\n` +
    `${body}\n`;
  await writeFile(path, manifest, 'utf-8');
  return { key: targetKey, path, action: exists ? 'overwritten' : 'created' };
}

export interface PatchResult {
  key: string;
  path: string;
  action: 'patched';
  beforeLength: number;
  afterLength: number;
}

/**
 * Patch an existing harness manifest by exact string replacement, without
 * requiring the caller to round-trip the full manifest body through
 * identity()'s combined payload first — which truncates silently once the
 * payload grows past the transport's size cap (t-1674), making a
 * read-then-overwrite via describeHarness unsafe on any manifest already
 * near or past that cap. The server applies the replacement against its
 * own on-disk copy, which is always complete, so the caller's `find` and
 * `replace` strings only need to be as long as the edit itself.
 *
 * `find` must match the current body exactly once — zero or multiple
 * matches is refused rather than guessed at, the same discipline an
 * editor's find/replace uses. Frontmatter other than `version`/`updated`
 * (e.g. `answersTo`) is preserved untouched.
 */
export async function patchHarness(
  contextDir: string,
  targetKey: string,
  find: string,
  replace: string,
  opts: { version?: string } = {},
): Promise<PatchResult> {
  assertSafePathSegment(targetKey, 'harness name');
  const existing = await read(contextDir, targetKey);
  if (!existing) {
    throw new Error(
      `harness_patch: no existing manifest for "${targetKey}" — use harness_describe or ` +
      `harness_init to create one first.`,
    );
  }
  const occurrences = countOccurrences(existing.body, find);
  if (occurrences === 0) {
    throw new Error(`harness_patch: find string not found in the current "${targetKey}" manifest body.`);
  }
  if (occurrences > 1) {
    throw new Error(
      `harness_patch: find string matches ${occurrences} times in the current "${targetKey}" ` +
      `manifest body — it must match exactly once. Include more surrounding context to disambiguate.`,
    );
  }
  // Replacement via a function callback: a literal substitution, so a `$1`/`$&` etc.
  // in `replace` is never reinterpreted as a regex backreference by String.replace.
  const newBody = existing.body.replace(find, () => replace);
  const path = resolve(contextDir, DIR, `${targetKey}.md`);
  const version = opts.version ?? existing.frontmatter.version ?? '0.1';
  const frontmatter = { ...existing.frontmatter, harness: targetKey, version, updated: new Date().toISOString() };
  const frontmatterText = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  const manifest = `---\n${frontmatterText}\n---\n\n${newBody.trim()}\n`;
  await writeFile(path, manifest, 'utf-8');
  return { key: targetKey, path, action: 'patched', beforeLength: existing.body.length, afterLength: newBody.length };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

export function template(key: string): string {
  return `---
harness: ${key}
version: 0.4
---

## Tool prefixes
<tool-prefix list — see stack spec §4.7>

## Delegation primitive
<primary sub-agent mechanism>

## Cron / scheduling
<scheduling primitive if any, and local-vs-UTC note>

## Session search
<how transcripts are searched>

## Gotchas
<known quirks>
`;
}

// ─── Initialization ─────────────────────────────────────────────────────────

export interface InitResult {
  name: string;
  path: string;
  action: 'created' | 'skipped-exists' | 'overwritten';
}

export async function initHarness(
  contextDir: string,
  name: string,
  opts: { overwrite?: boolean } = {},
): Promise<InitResult> {
  assertSafePathSegment(name, 'harness name');
  const dir = resolve(contextDir, DIR);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${name}.md`);
  const exists = existsSync(path);
  if (exists && !opts.overwrite) {
    return { name, path, action: 'skipped-exists' };
  }
  await writeFile(path, template(name), 'utf-8');
  return { name, path, action: exists ? 'overwritten' : 'created' };
}
