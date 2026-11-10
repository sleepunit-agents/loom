import { describe, it, expect } from 'vitest';
// @ts-expect-error plain build-time JS
import { structuralClasses, additions } from './check-app-kit.mjs';
describe('app kit structure guard', () => {
  it('finds new row, header and empty selectors, including nested state rules', () => {
    expect(structuralClasses('/* .loom-fake__row {} */ .loom-new__row:hover { color:red } @media (width > 1px) { .comms-new__empty, .pj-header, .custom-row { padding:0 } }')).toEqual(['comms-new__empty', 'custom-row', 'loom-new__row', 'pj-header']);
  });
  it('grandfathers only that selector in that file', () => {
    expect(additions({ 'a.css': ['loom-old__row', 'loom-new__empty'], 'b.css': ['loom-old__row'] }, { 'a.css': ['loom-old__row'] })).toEqual(['a.css: .loom-new__empty', 'b.css: .loom-old__row']);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error plain build-time JS
import { scan } from './check-app-kit.mjs';
it('scans app styles in nested directories, exempting only the root kit', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-kit-lint-'));
  try {
    for (const dir of ['styles', 'kit', 'app/kit']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'styles/new.css'), '.custom-row {display:grid} .custom-header {} .custom-empty {}');
    writeFileSync(join(root, 'kit/row.css'), '.shared-row {}');
    writeFileSync(join(root, 'app/kit/row.css'), '.hidden-row {}');
    expect(scan(root)).toEqual({ 'styles/new.css': ['custom-empty', 'custom-header', 'custom-row'], 'app/kit/row.css': ['hidden-row'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('rejects new row and header selectors in a grandfathered file', () => {
  expect(additions({ 'old.css': ['old-row', 'new-row', 'new-header'] }, { 'old.css': ['old-row'] })).toEqual(['old.css: .new-row', 'old.css: .new-header']);
});

it('also flags underscore spellings', () => {
  expect(structuralClasses('.custom_row {} .custom_header {} .custom_empty {}')).toEqual(['custom_empty', 'custom_header', 'custom_row']);
});

it('flags camelCase row, header and empty names', () => {
  expect(structuralClasses('.customRow {} .customHeader {} .customEmpty {}')).toEqual(['customEmpty', 'customHeader', 'customRow']);
});
