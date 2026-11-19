/** A box that scrolls and whose width decides its layout must keep its scrollbar's place.
 *
 * A container query reads the box's inner width, and a scrollbar that comes and goes changes that width.
 * When the layout the query picks decides whether there is a scrollbar, the two chase each other: Home
 * flickered between one column and two at 760px, text shifting by a scrollbar's width, until its content
 * happened to change height (2026-11-19). `scrollbar-gutter: stable` keeps the width the query reads still.
 * The same goes for a box whose script measures its own width to decide a layout (the agents rail). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url).pathname;
const sheets = (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.css')).sort();
/** Every rule of a sheet as [selector, declarations], comments removed; at-rules are looked inside. */
function rules(css: string): [string, string][] {
  const found: [string, string][] = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) found.push([match[1].trim(), match[2]]);
  return found;
}
const scrolls = (body: string) => /(^|;)\s*overflow(-[xy])?\s*:\s*[^;]*\b(auto|scroll)\b/.test(body);
const sized = (body: string) => /(^|;)\s*container(-type)?\s*:/.test(body) && !/container-type\s*:\s*normal/.test(body);
const kept = (body: string) => /(^|;)\s*scrollbar-gutter\s*:\s*stable\b/.test(body);

it('keeps the scrollbar\'s place on every box that scrolls and is a size container', () => {
  const all = sheets.flatMap(sheet => rules(readFileSync(join(root, sheet), 'utf8')).map(([selector, body]) => ({ sheet, selector, body })));
  // What each selector says in all, since a box's rules may be written in more than one place.
  const said = new Map<string, string>();
  for (const { selector, body } of all) for (const one of selector.split(',').map(part => part.trim()))
    said.set(one, (said.get(one) ?? '') + ';' + body);
  const loose = [...said].filter(([, body]) => scrolls(body) && sized(body) && !kept(body)).map(([selector]) => selector);
  expect(loose).toEqual([]);
  // The ones this is known to hold today, so that the scan above cannot pass by finding nothing.
  for (const selector of ['.desk-home', '.next-page', '.next-rail']) expect(scrolls(said.get(selector)!) && sized(said.get(selector)!) && kept(said.get(selector)!), selector).toBe(true);
});

it('keeps it too where a script measures the box to decide its layout, and where a card scrolls its own details', () => {
  const said = (sheet: string, selector: string) => rules(readFileSync(join(root, sheet), 'utf8')).filter(([name]) => name.split(',').map(part => part.trim()).includes(selector)).map(([, body]) => body).join(';');
  expect(kept(said('pieces/attention/rail.css', '.desk-agent-rail'))).toBe(true);
  expect(kept(said('pieces/attention/home.css', '.desk-home-details'))).toBe(true);
  // Home's scrolling is said in its sheet beside its container type, not by a utility class the scan cannot see.
  expect(readFileSync(join(root, 'pieces/attention/home.tsx'), 'utf8')).not.toMatch(/className="desk-home [^"]*\boverflow-(auto|scroll|[xy]-)/);
  expect(readFileSync(join(root, 'pieces/attention/home.tsx'), 'utf8')).toContain('desk-home-details');
});

it('centres a dock key\'s name by its margins, with no transform or translate to be folded, doubled or cleared', () => {
  const look = readFileSync(join(root, 'looks/looks.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...look.matchAll(/\.loom-dock-bar \.v-dock[^{]*\[data-part="label"\]\{([^}]*)\}/g)].map(match => match[1]);
  expect(rules.length).toBeGreaterThan(3);
  expect(rules.some(body => /left:-200px;right:-200px;margin-inline:auto;transform:none/.test(body) && /width:max-content/.test(body))).toBe(true);
  expect(rules.filter(body => /(^|;)\s*translate\s*:/.test(body) || /transform:\s*translate/.test(body))).toEqual([]);
});

it('names the order of the cascade layers before any sheet of the app or the kit opens one', () => {
  // A layer's place is fixed where it is first named, and the build puts the kit's sheets ahead of the app's. A kit
  // sheet that opened `components` first put it under `base`, whose reset then took a bare select's padding and corners.
  const order = '@layer properties, theme, base, components, utilities;';
  const opening = sheets.filter(sheet => !sheet.startsWith('styles/') && /@layer\s+[a-z-]+\s*\{/.test(readFileSync(join(root, sheet), 'utf8')));
  expect(opening).toEqual(expect.arrayContaining(['index.css', 'kit/controls.css', 'kit/reader.css']));
  for (const sheet of opening) {
    const css = readFileSync(join(root, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.indexOf(order), sheet).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(order), sheet).toBeLessThan(css.search(/@layer\s+[a-z-]+\s*\{/));
  }
});
