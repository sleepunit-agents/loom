/** The core house: what every agent's house starts from, and what an agent with no Housefile runs in.
 *
 * loom ships its definition (the directory `house/core` of the install: a Housefile and the files it
 * copies) and no image. A worker reads the definition once when it starts, and has its engine build it the
 * first time a house needs it (worker-container.ts). The image is named for the definition's digest and
 * the week (house-image.ts), so it is built again when a new loom changes the definition and once in
 * each new week, which is what keeps the system in it current. Every house's build is given the core's
 * name as a build argument, and every house image is named for the core it was built on.
 *
 * The definition is the worker's own files: nothing of an agent, a machine's configuration or a job is in
 * it, and it is given to the build with no argument. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { plainContext, type ContextApart, type ContextFile } from './house-context.js';
import { CORE_ARGUMENT, CORE_FILE } from './house-image.js';
import { HOUSE_REPOSITORY } from './house-layout.js';
import { DAY_MS } from '../core/day.js';

/** Where the definition is in the directory the worker is installed in. */
export const CORE_DIRECTORY = 'house/core';
/** The most a definition may be: it is a Housefile and a few small files, held in memory. */
const CORE_FILES_MAX = 64, CORE_BYTES_MAX = 1024 * 1024;
export interface CoreDefinition {
  /** The SHA-256 of every file's name and bytes, as hex: what the core's image is named for. */
  digest: string;
  /** The files as a build context. A new stream each time. */
  context(): Readable;
}
/** Read the definition from a directory: every file below it, links and anything else refused.
 * @throws when there is no Housefile there, or the directory is not a definition the worker takes. */
export function coreDefinition(directory: string): CoreDefinition {
  const files: ContextFile[] = []; let bytes = 0;
  const read = (below: string) => {
    for (const name of readdirSync(join(directory, below)).sort()) {
      const relative = below ? `${below}/${name}` : name, found = lstatSync(join(directory, relative));
      if (found.isDirectory()) { read(relative); continue; }
      if (!found.isFile()) throw new Error('Invalid core house definition');
      const data = readFileSync(join(directory, relative));
      if (files.length >= CORE_FILES_MAX || (bytes += data.length) > CORE_BYTES_MAX) throw new Error('Invalid core house definition');
      files.push({ name: relative, data, executable: (found.mode & 0o111) !== 0 });
    }
  };
  read('');
  if (!files.some(file => file.name === CORE_FILE)) throw new Error('Invalid core house definition');
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.name}\0${file.executable ? 'x' : '-'}\0${file.data.length}\0`).update(file.data);
  return { digest: hash.digest('hex'), context: () => plainContext(files) };
}
/** The week a moment is in, as the core's image carries it: the ISO week of its date in UTC, `2026w47`.
 * A week begins on Monday, and belongs to the year its Thursday is in. */
export function coreWeek(now: number): string {
  const day = new Date(now);
  if (Number.isNaN(day.getTime())) throw new Error('Invalid time');
  // The Thursday of this week decides the year; the week's number is how many Thursdays that year has had.
  const thursday = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 3 - (day.getUTCDay() + 6) % 7));
  const first = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - first) / (7 * DAY_MS));
  return `${String(thursday.getUTCFullYear()).padStart(4, '0')}w${String(week).padStart(2, '0')}`;
}
/** The Housefile of a house that has none: the core, with the repository copied in at its place.
 *
 * The worker writes such a house's build context in two parts (house-context.ts): the commit's files in
 * the directory NO_HOUSEFILE_REPOSITORY, and this Housefile beside it. So the Housefile is never in what
 * is copied, whatever the repository holds: nothing has to be removed afterwards, no name of the
 * repository's can meet it, and the repository's own ignore file, which is now one directory down and
 * not at the context's top, leaves nothing out. Every file of the commit is in the house. */
export const NO_HOUSEFILE = 'Housefile', NO_HOUSEFILE_REPOSITORY = 'repository';
export const noHousefile = (): ContextApart => ({ directory: NO_HOUSEFILE_REPOSITORY, beside: { name: NO_HOUSEFILE, data: Buffer.from(
  `ARG ${CORE_ARGUMENT}\nFROM \${${CORE_ARGUMENT}}\nCOPY ${NO_HOUSEFILE_REPOSITORY}/ ${HOUSE_REPOSITORY}/\n`) } });
