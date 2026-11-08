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
