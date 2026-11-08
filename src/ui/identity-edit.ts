/**
 * An agent's creed (IDENTITY.md), in the parts its owner edits on its Setup (Jonathan, 2026-10-30: "we should be able
 * to edit all of this here ... imagine somebody was spinning up their own Art from scratch, what boxes do they need").
 *
 * The creed is the owner's: an agent can't change it (update_identity edits only self-model.md and preferences.md, which
 * stay the agent's, shown read-only). Its parts: the title (`# Name`), what it's for (the paragraphs under the title),
 * and its `## ` sections. Three sections are boxes of their own, found by their heading whatever an older creed called
 * them: Voice (or Communication), Rules (or Rules and Judgment), When to ask first. Every write keeps a backup.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteWithBackup } from '../path-safety.js';
import { parseSections } from '../tools/update-identity.js';

export type Box = 'voice' | 'rules' | 'ask';
export const BOXES: Record<Box, { heading: string; match: RegExp }> = {
  voice: { heading: 'Voice', match: /^(voice|communication|how you talk)\b/i },
  rules: { heading: 'Rules', match: /^rules\b/i },
  ask: { heading: 'When to ask first', match: /^when to ask\b/i },
};

export interface Creed { title: string; purpose: string; sections: Array<{ header: string; body: string }> }

export function readCreed(dir: string): { text: string; creed: Creed } {
  let text = '';
  try { text = readFileSync(join(dir, 'IDENTITY.md'), 'utf-8'); } catch { /* none yet */ }
  return { text, creed: parseCreed(text) };
}

export function parseCreed(text: string): Creed {
  const all = parseSections(text);
  const pre = all.find((s) => s.header === '')?.content ?? '';
  const title = /^#\s+(.+)$/m.exec(pre)?.[1].trim() ?? '';
  const purpose = pre.replace(/^#\s+.+$/m, '').trim();
  return { title, purpose, sections: all.filter((s) => s.header !== '').map((s) => ({ header: s.header, body: s.content.trim() })) };
}

/** The section a box lives in, by its heading's meaning. */
export function boxSection(creed: Creed, box: Box) {
  return creed.sections.find((s) => BOXES[box].match.test(s.header));
}

/** The creed back as markdown: the title, what it's for, then each section in order. */
export function renderCreed(c: Creed): string {
  const parts = [`# ${c.title}`];
  if (c.purpose.trim()) parts.push(c.purpose.trim());
  for (const s of c.sections) parts.push(`## ${s.header}\n\n${s.body.trim()}`);
  return `${parts.join('\n\n')}\n`;
}

/**
 * The creed with one part changed. `part` is 'purpose', a box, or a section's exact heading. An empty box or section is
 * removed (a creed with no Rules says nothing about rules); a box that isn't there yet is added after Voice, else at the
 * end. What it's for can't be emptied: an agent with no purpose has no creed.
 */
export function withPart(c: Creed, part: 'purpose' | Box | string, body: string): Creed {
  const text = body.replace(/\r\n/g, '\n').trim();
  if (part === 'purpose') {
    if (!text) throw new Error('What it\'s for can\'t be empty.');
    return { ...c, purpose: text };
  }
  const box = (Object.keys(BOXES) as Box[]).find((b) => b === part);
  const at = box ? c.sections.findIndex((s) => BOXES[box].match.test(s.header)) : c.sections.findIndex((s) => s.header === part);
  const sections = [...c.sections];
  if (at >= 0) {
    if (text) sections[at] = { ...sections[at], body: text };
    else sections.splice(at, 1);
    return { ...c, sections };
  }
  if (!text) return c;
  if (!box) throw new Error(`There's no section "${part}" to change.`);
  const voice = sections.findIndex((s) => BOXES.voice.match.test(s.header));
  sections.splice(voice >= 0 ? voice + 1 : sections.length, 0, { header: BOXES[box].heading, body: text });
  return { ...c, sections };
}

/** A new section at the end. Its heading is one line, and not one the creed has already. */
export function withSection(c: Creed, header: string, body: string): Creed {
  const h = header.replace(/\s+/g, ' ').trim();
  if (!h || h.length > 120) throw new Error('A section needs a heading of at most 120 characters.');
  if (c.sections.some((s) => s.header.toLowerCase() === h.toLowerCase())) throw new Error(`The creed already has "${h}".`);
  if (!body.trim()) throw new Error('A new section needs something in it.');
  return { ...c, sections: [...c.sections, { header: h, body: body.replace(/\r\n/g, '\n').trim() }] };
}

export async function writeCreed(dir: string, c: Creed): Promise<void> {
  await atomicWriteWithBackup(join(dir, 'IDENTITY.md'), renderCreed(c));
}

/** The agent's own files, which it keeps itself: shown on its Setup, never edited there. */
export const OWN_FILES: Array<{ file: string; label: string; about: string }> = [
  { file: 'self-model.md', label: 'Self-model', about: 'what it has learned about itself: strengths, what it\'s learning, its current focus' },
  { file: 'preferences.md', label: 'Preferences', about: 'what it has learned about the people it works with' },
];
