/**
 * Update Identity tool — section-level edits on self-model and preferences.
 *
 * Identity files are markdown with H2 sections. This tool can:
 * - List sections in a file
 * - Replace a section's content (between its H2 and the next H2 or EOF)
 * - Append a new section at the end
 *
 * IDENTITY.md is immutable — only self-model.md and preferences.md are editable.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteWithBackup } from '../path-safety.js';

/** Files that can be edited via this tool. IDENTITY.md is explicitly excluded. */
const EDITABLE_FILES: Record<string, string> = {
  'self-model': 'self-model.md',
  'preferences': 'preferences.md',
};

export interface IdentitySection {
  header: string;
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Parse a markdown file into H2 sections.
 * Content before the first H2 is captured as a preamble (header: '').
 *
 * Fence-aware: a `## ` line inside a ``` or ~~~ code fence is body content,
 * not a section boundary. Closing fences must use the same character and be
 * at least as long as the opener (CommonMark-style).
 */
export function parseSections(text: string): IdentitySection[] {
  const lines = text.split('\n');
  const sections: IdentitySection[] = [];
  let currentHeader = '';
  let currentLines: string[] = [];
  let startLine = 0;
  let fence: string | null = null; // opening fence marker while inside a fenced block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      currentLines.push(line);
      continue;
    }
    if (fence === null && line.startsWith('## ')) {
      // Close previous section
      sections.push({
        header: currentHeader,
        content: currentLines.join('\n').trim(),
        startLine,
        endLine: i - 1,
      });
      currentHeader = line.replace(/^## /, '').trim();
      currentLines = [];
      startLine = i;
    } else {
      currentLines.push(line);
    }
  }

  // Close final section
  sections.push({
    header: currentHeader,
    content: currentLines.join('\n').trim(),
    startLine,
    endLine: lines.length - 1,
  });

  return sections;
}

/**
 * Rebuild a markdown file from sections.
 */
export function rebuildMarkdown(sections: IdentitySection[]): string {
  const parts: string[] = [];

  for (const section of sections) {
    if (section.header === '') {
      // Preamble — just the content
      if (section.content) {
        parts.push(section.content);
      }
    } else {
      parts.push(`## ${section.header}\n${section.content}`);
    }
  }

  return parts.join('\n\n') + '\n';
}

/**
 * Replace a single section's body in place, leaving every other line of the
 * file byte-identical. The header line itself is preserved as-is; only the
 * lines between it and the next section (or EOF) are swapped for `content`,
 * followed by one blank separator line when another section follows.
 */
function spliceSection(text: string, section: IdentitySection, content: string): string {
  const lines = text.split('\n');
  const before = lines.slice(0, section.startLine + 1); // includes the header line
  const after = lines.slice(section.endLine + 1); // first line of the next section, if any
  const body = content.replace(/\n+$/, '').split('\n');

  const next = [...before, ...body];
  if (after.length > 0) {
    next.push(''); // blank line before the untouched next section
  } else if (text.endsWith('\n')) {
    next.push(''); // preserve the file's trailing newline
  }
  return [...next, ...after].join('\n');
}

/**
 * Append a new section at the end of the file, leaving existing content
 * byte-identical apart from ensuring a trailing newline.
 */
function appendSection(text: string, header: string, content: string): string {
  const block = `## ${header}\n${content.replace(/\n+$/, '')}\n`;
  if (text.trim() === '') return block;
  let base = text.endsWith('\n') ? text : text + '\n';
  if (!base.endsWith('\n\n')) base += '\n';
  return base + block;
}

export type UpdateMode = 'replace' | 'append';

export interface UpdateIdentityInput {
  file: string;
  section?: string;
  content?: string;
  mode?: UpdateMode;
}

/**
 * List sections in an identity file.
 */
export async function listSections(contextDir: string, file: string): Promise<string> {
  const filename = EDITABLE_FILES[file];
  if (!filename) {
    return `Unknown file "${file}". Editable files: ${Object.keys(EDITABLE_FILES).join(', ')}`;
  }

  const filepath = join(contextDir, filename);
  let text: string;
  try {
    text = await readFile(filepath, 'utf-8');
  } catch {
    return `File not found: ${filename}. It will be created when you add a section.`;
  }

  const sections = parseSections(text);
  const named = sections.filter(s => s.header !== '');
  if (named.length === 0) {
    return `${filename} has no H2 sections.`;
  }

  const list = named.map(s => `- **${s.header}** (${s.content.split('\n').length} lines)`).join('\n');
  return `Sections in ${filename}:\n${list}`;
}

/**
 * Update or append a section in an identity file.
 */
export async function updateIdentity(
  contextDir: string,
  input: UpdateIdentityInput,
): Promise<string> {
  const { file, section, content, mode = 'replace' } = input;

  // Validate file
  const filename = EDITABLE_FILES[file];
  if (!filename) {
    return `Unknown file "${file}". Editable files: ${Object.keys(EDITABLE_FILES).join(', ')}`;
  }

  // List mode — no section or content means "show me what's there"
  if (!section && !content) {
    return listSections(contextDir, file);
  }

  if (!section) {
    return 'Section name is required when providing content.';
  }

  if (!content) {
    return 'Content is required when specifying a section.';
  }

  const filepath = join(contextDir, filename);
  let text: string;
  try {
    text = await readFile(filepath, 'utf-8');
  } catch {
    // File doesn't exist — create it with the new section (atomic, no .bak)
    const newContent = `## ${section}\n${content}\n`;
    await atomicWriteWithBackup(filepath, newContent);
    return `Created ${filename} with section "${section}".`;
  }

  const sections = parseSections(text);
  const existing = sections.find(
    s => s.header.toLowerCase() === section.toLowerCase()
  );

  if (mode === 'append') {
    if (existing) {
      return `Section "${section}" already exists in ${filename}. Use mode "replace" to update it.`;
    }
    await atomicWriteWithBackup(filepath, appendSection(text, section, content));
    return `Appended new section "${section}" to ${filename}.`;
  }

  // Replace mode
  if (!existing) {
    return `Section "${section}" not found in ${filename}. Available sections: ${sections.filter(s => s.header !== '').map(s => s.header).join(', ')}. Use mode "append" to add a new section.`;
  }

  await atomicWriteWithBackup(filepath, spliceSection(text, existing, content));
  return `Updated section "${section}" in ${filename}.`;
}
