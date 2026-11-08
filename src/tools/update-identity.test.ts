import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSections, rebuildMarkdown, updateIdentity, listSections } from './update-identity.js';

describe('parseSections', () => {
  it('parses sections from markdown with H2 headers', () => {
    const text = '# Title\n\n## Strengths\n- Good at X\n- Good at Y\n\n## Learning\n- Working on Z\n';
    const sections = parseSections(text);
    expect(sections).toHaveLength(3); // preamble + 2 H2s
    expect(sections[0].header).toBe('');
    expect(sections[0].content).toContain('# Title');
    expect(sections[1].header).toBe('Strengths');
    expect(sections[1].content).toContain('Good at X');
    expect(sections[2].header).toBe('Learning');
    expect(sections[2].content).toContain('Working on Z');
  });

  it('handles file with no H2 sections', () => {
    const text = 'Just some text\nWith no headers\n';
    const sections = parseSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].header).toBe('');
    expect(sections[0].content).toContain('Just some text');
  });

  it('handles empty file', () => {
    const sections = parseSections('');
    expect(sections).toHaveLength(1);
    expect(sections[0].header).toBe('');
    expect(sections[0].content).toBe('');
  });

  it('handles adjacent H2 headers with no content between', () => {
    const text = '## First\n## Second\nContent here\n';
    const sections = parseSections(text);
    expect(sections).toHaveLength(3); // preamble + 2 H2s
    expect(sections[1].header).toBe('First');
    expect(sections[1].content).toBe('');
    expect(sections[2].header).toBe('Second');
    expect(sections[2].content).toContain('Content here');
  });
});

describe('rebuildMarkdown', () => {
  it('roundtrips through parse and rebuild', () => {
    const original = '# Self-Model\n\n## Strengths\n- Good at X\n\n## Learning\n- Working on Z\n';
    const sections = parseSections(original);
    const rebuilt = rebuildMarkdown(sections);
    // Should preserve structure (exact whitespace may differ slightly)
    expect(rebuilt).toContain('# Self-Model');
    expect(rebuilt).toContain('## Strengths');
    expect(rebuilt).toContain('- Good at X');
    expect(rebuilt).toContain('## Learning');
    expect(rebuilt).toContain('- Working on Z');
  });

  it('handles sections with no preamble', () => {
    const sections = [
      { header: '', content: '', startLine: 0, endLine: 0 },
      { header: 'Only Section', content: 'Some content', startLine: 1, endLine: 2 },
    ];
    const result = rebuildMarkdown(sections);
    expect(result).toContain('## Only Section');
    expect(result).toContain('Some content');
    expect(result).not.toMatch(/^\n/); // no leading blank line from empty preamble
  });
});

describe('listSections', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-update-identity-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists sections from an existing file', async () => {
    await writeFile(join(tempDir, 'self-model.md'), '# Self-Model\n\n## Strengths\n- X\n\n## Learning\n- Y\n');
    const result = await listSections(tempDir, 'self-model');
    expect(result).toContain('Strengths');
    expect(result).toContain('Learning');
  });

  it('returns error for unknown file', async () => {
    const result = await listSections(tempDir, 'identity');
    expect(result).toContain('Unknown file');
    expect(result).toContain('self-model');
    expect(result).toContain('preferences');
  });

  it('returns helpful message when file does not exist', async () => {
    const result = await listSections(tempDir, 'self-model');
    expect(result).toContain('not found');
    expect(result).toContain('created');
  });

  it('handles file with no H2 sections', async () => {
    await writeFile(join(tempDir, 'self-model.md'), 'Just text, no sections');
    const result = await listSections(tempDir, 'self-model');
    expect(result).toContain('no H2 sections');
  });
});

describe('updateIdentity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-update-identity-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects unknown file names', async () => {
    const result = await updateIdentity(tempDir, {
      file: 'identity',
      section: 'Foo',
      content: 'bar',
    });
    expect(result).toContain('Unknown file');
  });

  it('lists sections when no section or content provided', async () => {
    await writeFile(join(tempDir, 'self-model.md'), '## Strengths\n- X\n\n## Learning\n- Y\n');
    const result = await updateIdentity(tempDir, { file: 'self-model' });
    expect(result).toContain('Strengths');
    expect(result).toContain('Learning');
  });

  it('requires content when section is specified', async () => {
    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Strengths',
    });
    expect(result).toContain('Content is required');
  });

  it('requires section when content is specified', async () => {
    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      content: 'some stuff',
    });
    expect(result).toContain('Section name is required');
  });

  it('creates file when it does not exist', async () => {
    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Strengths',
      content: '- TypeScript\n- Node.js',
    });
    expect(result).toContain('Created');
    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toContain('## Strengths');
    expect(written).toContain('- TypeScript');
  });

  it('replaces an existing section', async () => {
    await writeFile(join(tempDir, 'self-model.md'),
      '# Self-Model\n\n## Strengths\n- Old stuff\n\n## Learning\n- Old learning\n');

    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Strengths',
      content: '- New stuff\n- Better stuff',
    });
    expect(result).toContain('Updated section "Strengths"');

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toContain('- New stuff');
    expect(written).toContain('- Better stuff');
    expect(written).not.toContain('- Old stuff');
    // Other sections should be preserved
    expect(written).toContain('## Learning');
    expect(written).toContain('- Old learning');
  });

  it('section matching is case-insensitive', async () => {
    await writeFile(join(tempDir, 'self-model.md'), '## Current Focus\n- Loom\n');
    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'current focus',
      content: '- New focus',
    });
    expect(result).toContain('Updated');
    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toContain('- New focus');
  });

  it('returns error when replacing nonexistent section', async () => {
    await writeFile(join(tempDir, 'self-model.md'), '## Strengths\n- X\n');
    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Nonexistent',
      content: '- Y',
    });
    expect(result).toContain('not found');
    expect(result).toContain('Strengths');
    expect(result).toContain('append');
  });

  it('appends a new section', async () => {
    await writeFile(join(tempDir, 'self-model.md'), '## Strengths\n- X\n');
    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Weaknesses',
      content: '- Overthinking',
      mode: 'append',
    });
    expect(result).toContain('Appended');

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toContain('## Strengths');
    expect(written).toContain('## Weaknesses');
    expect(written).toContain('- Overthinking');
  });

  it('rejects append when section already exists', async () => {
    await writeFile(join(tempDir, 'self-model.md'), '## Strengths\n- X\n');
    const result = await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Strengths',
      content: '- Y',
      mode: 'append',
    });
    expect(result).toContain('already exists');
    expect(result).toContain('replace');
  });

  it('preserves preamble content when updating sections', async () => {
    await writeFile(join(tempDir, 'self-model.md'),
      '# Self-Model\n\n## Strengths\n- X\n\n## Learning\n- Y\n');

    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Learning',
      content: '- Updated learning',
    });

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toContain('# Self-Model');
    expect(written).toContain('## Strengths');
    expect(written).toContain('- X');
    expect(written).toContain('- Updated learning');
  });

  it('works with preferences file', async () => {
    await writeFile(join(tempDir, 'preferences.md'),
      '## Communication Style\n- Direct\n\n## Technical Preferences\n- TypeScript\n');

    const result = await updateIdentity(tempDir, {
      file: 'preferences',
      section: 'Technical Preferences',
      content: '- TypeScript\n- Rust',
    });
    expect(result).toContain('Updated');

    const written = await readFile(join(tempDir, 'preferences.md'), 'utf-8');
    expect(written).toContain('- Rust');
    expect(written).toContain('## Communication Style');
    expect(written).toContain('- Direct');
  });
});

describe('parseSections — fence awareness', () => {
  it('treats ## inside ``` fences as body content', () => {
    const text = '## Real\nbefore\n```\n## Not A Section\n```\nafter\n';
    const sections = parseSections(text);
    const named = sections.filter(s => s.header !== '');
    expect(named).toHaveLength(1);
    expect(named[0].header).toBe('Real');
    expect(named[0].content).toContain('## Not A Section');
  });

  it('treats ## inside ~~~ fences as body content', () => {
    const text = '## Real\n~~~\n## Hidden\n~~~\n';
    const sections = parseSections(text);
    const named = sections.filter(s => s.header !== '');
    expect(named).toHaveLength(1);
    expect(named[0].header).toBe('Real');
  });

  it('resumes section parsing after the fence closes', () => {
    const text = '## First\n```md\n## Fenced\n```\n\n## Second\nreal content\n';
    const sections = parseSections(text);
    const named = sections.filter(s => s.header !== '');
    expect(named.map(s => s.header)).toEqual(['First', 'Second']);
  });

  it('does not close a ``` fence with ~~~', () => {
    const text = '## Only\n```\n~~~\n## Still Fenced\n```\nend\n';
    const sections = parseSections(text);
    expect(sections.filter(s => s.header !== '')).toHaveLength(1);
  });
});

describe('updateIdentity — minimal rewriting and fences', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-update-identity-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('replacing section A leaves section B byte-identical (weird spacing preserved)', async () => {
    const weirdB = '## Learning  \n\n\n   - indented oddly\t\n\n* trailing blank lines kept\n\n\n';
    const original = '# Preamble   \n\nodd  spacing\n\n## Strengths\n- old\n\n' + weirdB;
    await writeFile(join(tempDir, 'self-model.md'), original);

    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Strengths',
      content: '- new',
    });

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    // Everything from section B's header onward is untouched, byte for byte
    expect(written.slice(written.indexOf('## Learning'))).toBe(weirdB);
    // Preamble untouched, byte for byte
    expect(written.startsWith('# Preamble   \n\nodd  spacing\n\n')).toBe(true);
    expect(written).toContain('## Strengths\n- new\n');
    expect(written).not.toContain('- old');
  });

  it('replacing a later section leaves earlier sections byte-identical', async () => {
    const head = '## Strengths\n-  double  spaced\n\t- tabbed\n\n';
    await writeFile(join(tempDir, 'self-model.md'), head + '## Learning\n- old\n');

    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Learning',
      content: '- new learning',
    });

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written.startsWith(head)).toBe(true);
    expect(written).toContain('## Learning\n- new learning\n');
  });

  it('fenced content survives a round-trip edit of a sibling section', async () => {
    const fenced = '## Snippets\n```ts\n## not a header\nconst x = 1;\n```\n';
    await writeFile(join(tempDir, 'self-model.md'), fenced + '\n## Focus\n- old focus\n');

    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Focus',
      content: '- new focus',
    });

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written.startsWith(fenced)).toBe(true);
    expect(written).toContain('- new focus');
  });

  it('replaces the correct section when a fenced ## fake header shadows it', async () => {
    await writeFile(join(tempDir, 'self-model.md'),
      '## Real\n```\n## Real\nfenced duplicate\n```\nbody tail\n\n## Other\n- keep\n');

    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Real',
      content: 'replaced body',
    });

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toContain('## Real\nreplaced body\n');
    expect(written).not.toContain('fenced duplicate');
    expect(written).toContain('## Other\n- keep\n');
  });

  it('appending leaves existing content byte-identical', async () => {
    const original = '## Strengths\n-  weird   spacing\n';
    await writeFile(join(tempDir, 'self-model.md'), original);

    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Weaknesses',
      content: '- none',
      mode: 'append',
    });

    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written.startsWith(original)).toBe(true);
    expect(written).toContain('## Weaknesses\n- none\n');
  });
});

describe('updateIdentity — atomic writes and .bak', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-update-identity-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a .bak with the prior content when replacing a section', async () => {
    const original = '## Strengths\n- old\n';
    await writeFile(join(tempDir, 'self-model.md'), original);

    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Strengths',
      content: '- new',
    });

    const bak = await readFile(join(tempDir, 'self-model.md.bak'), 'utf-8');
    expect(bak).toBe(original);
    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toContain('- new');
  });

  it('writes a .bak with the prior content when appending a section', async () => {
    const original = '## Strengths\n- X\n';
    await writeFile(join(tempDir, 'preferences.md'), original);

    await updateIdentity(tempDir, {
      file: 'preferences',
      section: 'New Section',
      content: '- Y',
      mode: 'append',
    });

    const bak = await readFile(join(tempDir, 'preferences.md.bak'), 'utf-8');
    expect(bak).toBe(original);
  });

  it('does not create a .bak on first-ever write', async () => {
    await updateIdentity(tempDir, {
      file: 'self-model',
      section: 'Strengths',
      content: '- fresh',
    });

    await expect(readFile(join(tempDir, 'self-model.md.bak'), 'utf-8')).rejects.toThrow();
    const written = await readFile(join(tempDir, 'self-model.md'), 'utf-8');
    expect(written).toBe('## Strengths\n- fresh\n');
  });

  it('keeps only one .bak generation across successive edits', async () => {
    await writeFile(join(tempDir, 'self-model.md'), '## Focus\n- v1\n');
    await updateIdentity(tempDir, { file: 'self-model', section: 'Focus', content: '- v2' });
    await updateIdentity(tempDir, { file: 'self-model', section: 'Focus', content: '- v3' });

    const bak = await readFile(join(tempDir, 'self-model.md.bak'), 'utf-8');
    expect(bak).toContain('- v2');
    expect(bak).not.toContain('- v1');
  });
});
