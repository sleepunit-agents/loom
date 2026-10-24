/**
 * The UI section vocabulary (docs/extensions.md, "UI sections").
 *
 * loom's page is built from sections, both its own and the installed pieces'.
 * A piece contributes by answering `loom-<piece> ui --json` with
 * `{ "sections": [...] }` in this vocabulary. Pieces send data, never markup:
 * loom renders every block itself and escapes every string, so a piece can't
 * put HTML or script on loom's page. Anything that doesn't validate is dropped
 * whole (a piece that sends garbage just isn't shown), never half-rendered.
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export type Block =
  | { type: 'stats'; items: Array<{ label: string; value: string; tone?: Tone }> }
  | { type: 'list'; items: Array<{ text: string; meta?: string; tone?: Tone }> }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string };

export interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

export const LIMITS = {
  sections: 10,
  blocks: 20,
  items: 200,
  columns: 12,
  string: 2000,
} as const;

const TONES: ReadonlySet<string> = new Set(['ok', 'warn', 'bad', 'muted']);
const ID = /^[a-z][a-z0-9-]{0,39}$/;

class Invalid extends Error {}

function str(v: unknown, what: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') throw new Invalid(`${what} must be a string`);
  if (v.length > LIMITS.string) throw new Invalid(`${what} is longer than ${LIMITS.string}`);
  return v;
}

function optStr(v: unknown, what: string): string | undefined {
  return v === undefined ? undefined : str(v, what);
}

function tone(v: unknown): Tone | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !TONES.has(v)) throw new Invalid(`tone must be one of ${[...TONES].join(', ')}`);
  return v as Tone;
}

function arr(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(`${what} must be an array`);
  if (v.length > max) throw new Invalid(`${what} has more than ${max} entries`);
  return v;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Invalid(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function block(v: unknown): Block {
  const b = obj(v, 'block');
  switch (b.type) {
    case 'stats':
      return {
        type: 'stats',
        items: arr(b.items, 'stats.items', LIMITS.items).map((i) => {
          const o = obj(i, 'stat');
          return { label: str(o.label, 'stat.label'), value: str(o.value, 'stat.value'), tone: tone(o.tone) };
        }),
      };
    case 'list':
      return {
        type: 'list',
        items: arr(b.items, 'list.items', LIMITS.items).map((i) => {
          const o = obj(i, 'list item');
          return { text: str(o.text, 'list.text'), meta: optStr(o.meta, 'list.meta'), tone: tone(o.tone) };
        }),
      };
    case 'table': {
      const columns = arr(b.columns, 'table.columns', LIMITS.columns).map((c) => str(c, 'table column'));
      const rows = arr(b.rows, 'table.rows', LIMITS.items).map((r) => {
        const row = arr(r, 'table row', columns.length).map((c) => str(c, 'table cell'));
        return row;
      });
      return { type: 'table', columns, rows };
    }
    case 'text':
      return { type: 'text', text: str(b.text, 'text') };
    case 'link': {
      const href = str(b.href, 'link.href');
      // Only http(s): no javascript:, data:, or relative tricks.
      let url: URL;
      try { url = new URL(href); } catch { throw new Invalid('link.href must be an absolute URL'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Invalid('link.href must be http(s)');
      return { type: 'link', text: str(b.text, 'link.text'), href: url.href };
    }
    default:
      throw new Invalid(`unknown block type ${JSON.stringify(b.type)}`);
  }
}

/** Validate a piece's `ui --json` answer. Returns the sections, or why it was refused. */
export function parseSections(value: unknown): Section[] | string {
  try {
    const top = obj(value, 'answer');
    return arr(top.sections, 'sections', LIMITS.sections).map((s) => {
      const o = obj(s, 'section');
      const id = str(o.id, 'section.id');
      if (!ID.test(id)) throw new Invalid(`section.id ${JSON.stringify(id)} must be lowercase letters, digits and dashes`);
      return {
        id,
        title: str(o.title, 'section.title'),
        blocks: arr(o.blocks, 'section.blocks', LIMITS.blocks).map(block),
      };
    });
  } catch (err) {
    if (err instanceof Invalid) return err.message;
    throw err;
  }
}
