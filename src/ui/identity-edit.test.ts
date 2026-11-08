import { describe, expect, it } from 'vitest';
import { boxSection, parseCreed, renderCreed, withPart, withSection } from './identity-edit.js';

const ART = `# Art E Fish

You are Art E Fish, a persistent personal assistant.

## Who You Are

Capable and direct.

## Communication

Be brief when brief is right.

## Rules and Judgment

- Never print token files.

\`\`\`
## not a heading: inside a fence
\`\`\`

## Identity Notes

One Art.
`;

describe('a creed in parts (Setup\'s boxes)', () => {
  it('reads the title, what it\'s for and its sections, and writes them back as they were', () => {
    const c = parseCreed(ART);
    expect(c.title).toBe('Art E Fish');
    expect(c.purpose).toBe('You are Art E Fish, a persistent personal assistant.');
    expect(c.sections.map((s) => s.header)).toEqual(['Who You Are', 'Communication', 'Rules and Judgment', 'Identity Notes']);
    expect(renderCreed(c)).toBe(ART);
  });

  it('finds a box by what its heading means, whatever an older creed called it', () => {
    const c = parseCreed(ART);
    expect(boxSection(c, 'voice')?.header).toBe('Communication');
    expect(boxSection(c, 'rules')?.body).toContain('Never print token files.');
    expect(boxSection(c, 'ask')).toBeUndefined();
  });

  it('changes one part and leaves the rest; a new box goes after Voice; an empty one is removed', () => {
    let c = withPart(parseCreed(ART), 'voice', 'Dry.');
    c = withPart(c, 'ask', 'Anything destructive.');
    expect(c.sections.map((s) => s.header)).toEqual(['Who You Are', 'Communication', 'When to ask first', 'Rules and Judgment', 'Identity Notes']);
    expect(boxSection(c, 'voice')!.body).toBe('Dry.');
    c = withPart(c, 'rules', '');
    expect(boxSection(c, 'rules')).toBeUndefined();
    c = withPart(c, 'Identity Notes', 'Still one Art.');
    expect(renderCreed(c)).toContain('## Identity Notes\n\nStill one Art.\n');
    expect(renderCreed(c)).toContain('## Who You Are\n\nCapable and direct.');
  });

  it('refuses what would break it', () => {
    const c = parseCreed(ART);
    expect(() => withPart(c, 'purpose', '  ')).toThrow(/can't be empty/);
    expect(() => withPart(c, 'No Such Section', 'x')).toThrow(/no section/);
    expect(() => withSection(c, 'communication', 'x')).toThrow(/already has/);
    expect(() => withSection(c, 'Hobbies', ' ')).toThrow(/needs something/);
    expect(withSection(c, 'Hobbies', 'Birding.').sections.at(-1)).toEqual({ header: 'Hobbies', body: 'Birding.' });
  });
});
