import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterAll, expect, it } from 'vitest';
import { CORE_DIRECTORY, coreDefinition, coreWeek, noHousefile } from './house-core.js';
import { coreImage, HOUSE_LABEL, HOUSE_LABEL_HARNESSES, HOUSE_VERSION } from './house-image.js';
import { HOUSE_HOME, HOUSE_INIT, HOUSE_NODE, HOUSE_REPOSITORY, houseBodyFile, houseLogin, houseSessions } from './house-layout.js';
import { bodyFileSchema } from './body-program.js';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-house-core-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const all = async (stream: Readable) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
/** A definition on disk with these files. */
function definition(name: string, files: Record<string, string>) {
  const path = join(root, name);
  for (const [file, content] of Object.entries(files)) { mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), content); }
  return path;
}
/** The definition loom ships: the directory `house/core` of this checkout. */
const shipped = join(fileURLToPath(new URL('../..', import.meta.url)), CORE_DIRECTORY);

it('reads a definition as its files, and names it by every name and byte of them', async () => {
  const files = { 'Housefile': 'FROM scratch\n', 'body/claude.json': '{}\n', 'body/codex.json': '{}\n' };
  const one = coreDefinition(definition('one', files));
  expect(one.digest).toMatch(/^[0-9a-f]{64}$/);
  // The same files anywhere are the same definition; any change to a name, a byte or whether a file can be run is another.
  expect(coreDefinition(definition('same', files)).digest).toBe(one.digest);
  const changes = [{ ...files, 'Housefile': 'FROM scratch \n' }, { ...files, 'body/agy.json': '{}\n' }, { 'Housefile': 'FROM scratch\n', 'body/claude.json': '{}\n', 'body/codex.jso': 'n{}\n' }];
  const digests = changes.map((changed, index) => coreDefinition(definition(`changed-${index}`, changed)).digest);
  const runnable = definition('runnable', files); chmodSync(join(runnable, 'body/claude.json'), 0o755); digests.push(coreDefinition(runnable).digest);
  expect(new Set([one.digest, ...digests]).size).toBe(5);
  // Its context is those files and nothing else, a new stream each time.
  const into = join(root, 'unpacked'); mkdirSync(into); writeFileSync(`${into}.tar`, await all(one.context()));
  execFileSync('tar', ['-xf', `${into}.tar`, '-C', into], { stdio: 'ignore' });
  expect(readdirSync(into, { recursive: true }).sort()).toEqual(['Housefile', 'body', 'body/claude.json', 'body/codex.json']);
  expect((await all(one.context())).length).toBeGreaterThan(0);
});
it('takes no definition without a Housefile, with a link in it, or larger than a definition is', () => {
  expect(() => coreDefinition(join(root, 'not-there'))).toThrow();
  expect(() => coreDefinition(definition('no-housefile', { 'body/claude.json': '{}\n' }))).toThrow('Invalid core house definition');
  const linked = definition('linked', { 'Housefile': 'FROM scratch\n' }); symlinkSync('/etc/passwd', join(linked, 'passwd'));
  expect(() => coreDefinition(linked)).toThrow('Invalid core house definition');
  expect(() => coreDefinition(definition('large', { 'Housefile': 'FROM scratch\n', 'big': 'x'.repeat(1024 * 1024) }))).toThrow('Invalid core house definition');
  expect(() => coreDefinition(definition('many', { 'Housefile': 'FROM scratch\n', ...Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`f/${index}`, 'x'])) }))).toThrow('Invalid core house definition');
});
it('says which week a moment is in: Monday to Sunday in UTC, by the year its Thursday is in', () => {
  const week = (year: number, month: number, day: number, hour = 12) => coreWeek(Date.UTC(year, month - 1, day, hour));
  expect(week(2026, 11, 17)).toBe('2026w47');
  // A week turns at midnight UTC between Sunday and Monday, and at no other moment.
  expect([coreWeek(Date.UTC(2026, 10, 16, 0, 0, 0)), coreWeek(Date.UTC(2026, 10, 22, 23, 59, 59)), coreWeek(Date.UTC(2026, 10, 23, 0, 0, 0))]).toEqual(['2026w47', '2026w47', '2026w48']);
  // The turn of a year: the days before the first Thursday's week belong to the old year's last week.
  expect([week(2026, 1, 1), week(2025, 12, 29), week(2025, 12, 28), week(2027, 1, 1), week(2027, 1, 3), week(2027, 1, 4), week(2026, 12, 31)]).toEqual(['2026w01', '2026w01', '2025w52', '2026w53', '2026w53', '2027w01', '2026w53']);
  // Every moment's week names a core house's image.
  for (const moment of [0, Date.UTC(2026, 10, 17), Date.UTC(2099, 11, 31)]) expect(coreImage('a'.repeat(64), coreWeek(moment))).toMatch(/^localhost\/loom-core:a{16}-\d{4}w\d{2}$/);
  expect(() => coreWeek(Number.NaN)).toThrow('Invalid time');
});
it('writes the Housefile of a house that has none: the core, and the repository copied from its own directory of the context', () => {
  const made = noHousefile();
  expect([made.directory, made.beside.name]).toEqual(['repository', 'Housefile']);
  // Three lines: no step runs in the image, so nothing depends on a shell there, and nothing is removed afterwards.
  expect(made.beside.data.toString()).toBe(`ARG LOOM_CORE\nFROM \${LOOM_CORE}\nCOPY repository/ ${HOUSE_REPOSITORY}/\n`);
  expect(made.beside.data.toString()).not.toMatch(/\bRUN\b/);
});

// The definition loom ships is held to what loom asks of any house.
it('ships a core house that meets the image contract and the layout by itself, and holds nothing secret', () => {
  const text = readFileSync(join(shipped, 'Housefile'), 'utf8'), lines = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  expect(() => coreDefinition(shipped)).not.toThrow();
  // The two labels, with the harnesses it has a body file for.
  expect(lines).toContain(`LABEL ${HOUSE_LABEL}="${HOUSE_VERSION}"`);
  const served = new RegExp(`${HOUSE_LABEL_HARNESSES.replaceAll('.', '\\.')}="([a-z ]+)"`).exec(lines)![1].split(' ');
  expect(served).toEqual(['claude', 'codex']);
  for (const harness of served) {
    const file = houseBodyFile(harness).slice('/etc/loom/body/'.length), body = bodyFileSchema.parse(JSON.parse(readFileSync(join(shipped, 'body', file), 'utf8')));
    // A body file starts its harness in the repository, from a place this Housefile puts the program.
    expect(body.cwd).toBe(HOUSE_REPOSITORY); expect(body.command).toMatch(/^\/(home\/agent\/\.local|usr\/local)\/bin\/[a-z]+$/);
  }
  expect(lines).toContain('COPY body/claude.json body/codex.json /etc/loom/body/');
  // The layout: the home, node where the worker starts it, the repository's place, each harness pointed at its mounted sign-in.
  expect(lines).toContain(`HOME=${HOUSE_HOME}`); expect(lines).toContain(`${HOUSE_NODE} -v`); expect(lines).toContain(`mkdir -p /home/agent/.codex ${HOUSE_REPOSITORY}`);
  expect(lines).toContain(`CLAUDE_SECURESTORAGE_CONFIG_DIR=${houseLogin('claude')}`);
  // Claude Code's own directory is made by the house, apart from its sign-in: a body keeps a conversation's session there and never makes it.
  expect(lines).toContain(`mkdir -p /home/agent/.codex ${HOUSE_REPOSITORY} ${houseSessions('claude')} `); expect(houseSessions('claude')).not.toBe(houseLogin('claude'));
  expect(lines).toContain(`ln -s ${houseLogin('codex')}/auth.json /home/agent/.codex/auth.json`);
  // The init the worker starts a body under is Debian's, installed with the other tools and checked by the build.
  expect(HOUSE_INIT).toBe('/usr/bin/tini'); expect(lines).toMatch(/apt-get install -y --no-install-recommends[^&]* tini \\\n/);
  expect(lines).toContain(`test -x ${HOUSE_INIT}`);
  // Nothing a house may not have: a volume, a user of its own, anything at /opt/loom, an argument without a default, a secret, a copy of a sign-in.
  expect(lines).not.toMatch(/^\s*(VOLUME|USER|ENTRYPOINT|CMD)\b/m); expect(lines).not.toContain('/opt/loom');
  expect(lines.match(/^ARG .*$/gm)!.every(line => line.includes('='))).toBe(true);
  expect(lines).not.toMatch(/--mount=type=secret|TOKEN|PASSWORD|API_KEY|\.credentials|cp [^\n]*auth\.json/i);
  // Every program it fetches is pinned to a version, and those fetched as one file to a checksum.
  expect(lines).toContain('CLAUDE_VERSION=2.1.326'); expect(lines.match(/sha256sum -c/g)).toHaveLength(2); expect(lines).toMatch(/@openai\/codex@\$\{CODEX_VERSION\}/);
  expect(lines).not.toMatch(/curl[^\n|]*\|\s*(sh|bash)/);
  // Only what the Housefile copies is in the definition.
  expect(readdirSync(shipped, { recursive: true }).sort()).toEqual(['Housefile', 'body', 'body/claude.json', 'body/codex.json']);
});
