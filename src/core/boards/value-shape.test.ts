/** ./value-shape.ts: what a typed name is refused for, the one test the page and `boards.act` both use. Both sides of
 * it are listed once, in ./value-shape.fixture.ts. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ACCEPTED_NAMES, REFUSED_BY_KIND, REFUSED_NAMES, SYNTHETIC_BEARER } from './value-shape.fixture.js';
import { KNOWN, loomBearer, looksLikeSecretValue } from './value-shape.js';
import { mintBodyToken } from '../../runtime/body-token.js';

it('refuses a synthetic credential of every kind it knows, bare and after a separator, and a long random run', () => {
  // The fixture has one of each kind, so a kind added to KNOWN without a fixture fails here.
  expect(Object.keys(REFUSED_BY_KIND).sort()).toEqual([...KNOWN.map((k) => k.kind), 'long run, no known prefix'].sort());
  for (const name of REFUSED_NAMES) expect(looksLikeSecretValue(name), name).toBe(true);
  expect(loomBearer.test(SYNTHETIC_BEARER)).toBe(true);
  // The body token's shape is stated in src/runtime/body-token.ts, which this module cannot import: held to it here.
  for (let i = 0; i < 20; i++) expect(looksLikeSecretValue(mintBodyToken().toString('ascii'))).toBe(true);
});

it('takes every name the fixture lists as a name', () => {
  for (const name of ACCEPTED_NAMES) expect(looksLikeSecretValue(name), name).toBe(false);
});

it('matches a known prefix only in the case real credentials use', () => {
  for (const [kind, value] of Object.entries(REFUSED_BY_KIND)) {
    if (kind === 'long run, no known prefix') continue;
    // Its prefix in the other case, before words: a name. (The same random body would still be a long run.)
    const prefix = value.match(/^[A-Za-z]+[_-]?(?:[a-z]+[_-])?/)![0];
    const flipped = [...prefix].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
    expect(looksLikeSecretValue(flipped + 'read-packages-for-the-org-acme-2026'), kind).toBe(false);
  }
  // The pin itself: a random body under 32 characters is refused after the real prefix and taken after the flipped one.
  expect(looksLikeSecretValue('ghp_Q7xK2mP9vR4tL8nW3bZ6')).toBe(true);
  expect(looksLikeSecretValue('GHP_Q7xK2mP9vR4tL8nW3bZ6')).toBe(false);
});
it('refuses the whole of a loom bearer whatever its pieces look like, and takes words of the same length', () => {
  // Every piece shorter than eight characters: no piece looks random, and it is a bearer all the same.
  const bearer = 'loom_aBcD3fG-hJkLmN_pQrS7uV-wXyZaBc_dEfGh9J-kLmN';
  expect(bearer).toHaveLength(48);
  expect(looksLikeSecretValue(bearer)).toBe(true);
  expect(looksLikeSecretValue('loom_staging_environment_database_password_f')).toBe(false);
  expect(looksLikeSecretValue('loom_staging_environment_database_password_forci')).toBe(false);
});

it('needs a random body after a prefix: letters and digits mixed, not words with a year', () => {
  expect(looksLikeSecretValue('sk-region-2-backup-bucket-2026')).toBe(false);
  expect(looksLikeSecretValue('ghp_postgres2026_replica_for_backups')).toBe(false);
  expect(looksLikeSecretValue('ghp_' + 'Q7xK2mP9vR4tL8nW3bZ6')).toBe(true);
  // The accepted cost, as docs/accepted-tradeoffs.md states it: a mixed piece after a prefix, or a long run with
  // digits in two groups, is refused though a member meant it as a name.
  for (const name of ['ghp_build2go4ci_for_the_pump', 'production2026PostgresReplica2027Password']) expect(looksLikeSecretValue(name), name).toBe(true);
});

it('refuses a long run only with four digits in two groups or more, and both cases or a fifth of digits', () => {
  const lower = 'abcdefghijklmn'; // 14 letters
  expect(looksLikeSecretValue(lower + '12' + lower + '34')).toBe(false); // one case, digits an eighth of it
  expect(looksLikeSecretValue('abcd1'.repeat(7))).toBe(true); // one case, digits a fifth of it
  expect(looksLikeSecretValue('A' + 'a'.repeat(26) + '12' + 'B' + '34')).toBe(true); // both cases, two groups
  expect(looksLikeSecretValue('A' + 'a'.repeat(26) + '12' + 'B' + '3')).toBe(false); // three digits
  expect(looksLikeSecretValue('A' + 'a'.repeat(27) + '1234')).toBe(false); // digits in one group
  expect(looksLikeSecretValue('A' + 'a'.repeat(25) + '12' + 'B' + '34')).toBe(false); // 31 characters
  expect(looksLikeSecretValue('a'.repeat(31) + '1')).toBe(false); // one digit
  expect(looksLikeSecretValue('a'.repeat(31))).toBe(false);
  expect(looksLikeSecretValue('1'.repeat(64))).toBe(false); // all digits: one group
});

it('has no imports, so the page and the server load this file and nothing more with it', () => {
  const source = readFileSync(new URL('./value-shape.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/^\s*(?:import|export\s+[^;]*\sfrom)\s/m);
  expect(source).not.toMatch(/\bimport\(|\brequire\(/);
});
