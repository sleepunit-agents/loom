/**
 * Model manifest reader.
 *
 * Each model family the agent has ever sleeved into gets one manifest at
 * `<contextDir>/models/<key>.md`. Describes capability notes, workarounds,
 * and when-to-use / when-not-to-use guidance — independent of harness.
 *
 * Contract: stack spec v1 §4.8.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFrontmatter, type Block } from './types.js';
import { assertSafePathSegment } from '../path-safety.js';

const DIR = 'models';

export async function read(contextDir: string, key: string): Promise<Block | null> {
  assertSafePathSegment(key, 'model name');
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

export function template(key: string): string {
  return `---
model: ${key}
family: <family name>
size: <size hint if meaningful>
---

## Capability notes
<strengths and weaknesses that matter operationally>

## Workarounds
<known-good compensation patterns — or "None required.">

## When to use
<concrete situations this model is the right choice>

## When not to use
<concrete situations where a different model is better>
`;
}
