import { describe, it, expect } from 'vitest';
import { paragraphs } from './household-pages.js';

describe('paragraphs: a long knowledge body as text blocks', () => {
  it('packs whole paragraphs, never cutting one mid-word', () => {
    const p = (n: number, w: string) => Array.from({ length: n }, () => w).join(' ');
    const body = [p(60, 'alpha'), p(60, 'beta'), p(60, 'gamma')].join('\n\n');   // ~360, ~300, ~360 chars
    const out = paragraphs(body, 700);
    expect(out).toEqual([`${p(60, 'alpha')}\n\n${p(60, 'beta')}`, p(60, 'gamma')]);
  });

  it('breaks a paragraph too long on its own at a space', () => {
    const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    const out = paragraphs(long, 400);
    expect(out.every((c) => c.length <= 400)).toBe(true);
    expect(out.join(' ')).toBe(long);
    for (const c of out) expect(c).toMatch(/^w\d+( w\d+)*$/);   // whole words only
  });

  it('an empty body is one empty block', () => {
    expect(paragraphs('', 1900)).toEqual(['']);
  });
});
