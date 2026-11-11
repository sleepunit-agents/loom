// Legacy app classes are grandfathered by file and selector. New app structure belongs in the kit.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
export function structuralClasses(css) {
  return [...new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .flatMap((m) => [...m[1].matchAll(/\.([A-Za-z_][\w-]*)/g)].map((x) => x[1]))
    .filter((s) => /(?:^|[-_])(?:row|rows|header|head|empty|none)(?:$|[-_])/.test(s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase())))].sort();
}
export function scan(root) {
  const out = {};
  function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) { if (path !== join(root, 'kit')) walk(path); }
    else if (e.name.endsWith('.css')) { const names = structuralClasses(readFileSync(path, 'utf8')); if (names.length) out[relative(root, path)] = names; }
  } }
  walk(root); return out;
}
export function additions(current, baseline) { return Object.entries(current).flatMap(([file, names]) => names.filter((n) => !baseline[file]?.includes(n)).map((n) => `${file}: .${n}`)); }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = JSON.parse(readFileSync(new URL('./app-kit-legacy.json', import.meta.url), 'utf8'));
  const added = additions(scan(fileURLToPath(new URL('../web/src', import.meta.url))), base);
  if (added.length) { console.error('Use web/src/kit for new rows, headers and empty states:\n' + added.join('\n')); process.exitCode = 1; }
}
