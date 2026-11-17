/** A house's image on the engine: what it is called, whether it is there, building it, what it says about
 * starting a body, and removing old ones.
 *
 * The image is built by the engine from a tar stream of the house's repository at one commit
 * (house-source.ts) and the path of its Housefile inside that stream. The worker reads neither. What a
 * build step may do is what the engine lets a build do: the worker adds no build argument, secret, host
 * path, socket or privilege (docs/accepted-tradeoffs.md, "A Housefile is as dangerous as the engine's
 * builder lets it be").
 *
 * The name is the repository, the Housefile and the commit, and nothing of the worker: the same three are
 * found again with one question, and deploying a new loom rebuilds nothing. */
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DockerResponseError, type DockerEngine } from './docker-engine.js';
import { UnmetHouseError } from './worker.js';
import { houseFile, type House } from './house-source.js';
import { plainPath } from './worker-mounts.js';
import { COMMIT } from '../apps/merge-target.js';
import { SHA256_HEX_WITHIN } from '../core/sha256-hex.js';

/** The image contract: what every house image says about itself, as labels (docs/runtime/worker.md,
 * "What a house image must say"). The version this worker reads; the node program to run the body
 * program with; and, for each harness the house serves, that harness's body file. */
export const HOUSE_LABEL = 'loom.house', HOUSE_VERSION = '1';
export const HOUSE_LABEL_NODE = 'loom.house.node', HOUSE_LABEL_BODY = 'loom.house.body.';
/** How many images of one house are kept (the one in use and the one before it), and how many house
 * images in all. */
export const HOUSE_IMAGES_PER_HOUSE = 2, HOUSE_IMAGES_KEPT = 10;
/** What the engine is asked to forget after a build: unnamed images older than this, build cache unused for that. */
const LEFTOVER_IMAGES = '24h', LEFTOVER_CACHE = '168h';
const PREFIX = 'localhost/loom-house-';
const IMAGE_ID = new RegExp(`^(sha256:)?${SHA256_HEX_WITHIN}$`);
/** A house image's name: the house, then the commit (the one shape of a commit, apps/merge-target.ts). */
const NAME = new RegExp(`^localhost/loom-house-[0-9a-f]{16}:${COMMIT.source.slice(1, -1)}$`);
/** A harness's name as a label can carry it. */
const HARNESS = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const repositoryOf = (house: House) => `${PREFIX}${createHash('sha256').update(`${house.repository}\0${house.file}`).digest('hex').slice(0, 16)}`;
/** The image of this repository and Housefile at this commit. */
export const houseImage = (house: House, commit: string): string => `${repositoryOf(house)}:${commit}`;
const filters = (value: Record<string, string[]>) => encodeURIComponent(JSON.stringify(value));
const missing = (error: unknown) => error instanceof DockerResponseError && error.status === 404;

/** Whether the engine has this image. */
export async function houseBuilt(engine: DockerEngine, image: string, signal: AbortSignal): Promise<boolean> {
  if (!NAME.test(image)) throw new Error('Invalid house image');
  try { await engine.json('GET', `/images/${image}/json`, undefined, signal); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}
/** Have the engine build the image from this context. Resolves only when the image is there afterwards:
 * an engine's build can end without one and without saying so. */
export async function buildHouse(engine: DockerEngine, image: string, file: string, context: Readable, signal: AbortSignal): Promise<void> {
  if (!NAME.test(image) || !houseFile(file)) { context.destroy(); throw new Error('Invalid house image'); }
  // Quiet, intermediate containers removed whether it works or not, nothing pulled that is already here.
  // No build argument, no label of the worker's, no network or privilege setting: the engine's defaults.
  await engine.build(`/build?t=${encodeURIComponent(image)}&dockerfile=${encodeURIComponent(file)}&q=1&rm=1&forcerm=1`, context, signal);
  if (!await houseBuilt(engine, image, signal)) throw new Error('House image was not built');
}

/** How a body starts in a house image: the image itself, by its id; the node program; the harness's body
 * file; the directory to start in. */
export interface HouseStart { id: string; node: string; body: string; cwd: string }
/** Read the image contract for one harness. @throws UnmetHouseError (WORKER_EXIT.house) when the image does not meet it. */
export async function houseStart(engine: DockerEngine, image: string, harness: string, signal: AbortSignal): Promise<HouseStart> {
  if (!image.trim() || /[\s\0?#]/.test(image)) throw new Error('Invalid house image');
  const found: unknown = await engine.json('GET', `/images/${image}/json`, undefined, signal);
  const refuse = (): never => { throw new UnmetHouseError('House image does not say how a body starts in it'); };
  if (!found || typeof found !== 'object' || !('Id' in found) || typeof found.Id !== 'string' || !IMAGE_ID.test(found.Id)) throw new Error('Invalid image identity');
  const config: unknown = 'Config' in found ? found.Config : undefined;
  if (!config || typeof config !== 'object') return refuse();
  const labels: unknown = 'Labels' in config ? config.Labels : undefined, cwd: unknown = 'WorkingDir' in config ? config.WorkingDir : undefined;
  if (!labels || typeof labels !== 'object' || !HARNESS.test(harness)) return refuse();
  const label = (name: string): unknown => Object.hasOwn(labels, name) ? (labels as Record<string, unknown>)[name] : undefined;
  const node = label(HOUSE_LABEL_NODE), body = label(`${HOUSE_LABEL_BODY}${harness}`);
  if (label(HOUSE_LABEL) !== HOUSE_VERSION || !plainPath(node) || !plainPath(body) || !plainPath(cwd)) return refuse();
  return { id: found.Id, node, body, cwd };
}

/** After a build: remove the house images this worker no longer needs, and what builds left behind.
 * Never the image named, never by force (the engine refuses one a container uses), and never an error:
 * what could not be removed now is found again after the next build. */
export async function pruneHouses(engine: DockerEngine, keep: readonly string[], leftovers: boolean, signal: AbortSignal): Promise<void> {
  try {
    const listed: unknown = await engine.json('GET', `/images/json?filters=${filters({ reference: [`${PREFIX}*`] })}`, undefined, signal);
    if (!Array.isArray(listed)) return;
    const images: { name: string; built: number }[] = [];
    for (const row of listed as unknown[]) {
      if (!row || typeof row !== 'object' || !('RepoTags' in row) || !Array.isArray(row.RepoTags)) continue;
      const built = 'Created' in row && typeof row.Created === 'number' ? row.Created : 0;
      for (const name of row.RepoTags as unknown[]) if (typeof name === 'string' && NAME.test(name)) images.push({ name, built });
    }
    images.sort((one, other) => other.built - one.built);
    const perHouse = new Map<string, number>(); let kept = 0;
    for (const { name } of images) {
      const house = name.slice(0, name.indexOf(':')), count = perHouse.get(house) ?? 0;
      if (keep.includes(name) || (count < HOUSE_IMAGES_PER_HOUSE && kept < HOUSE_IMAGES_KEPT)) { perHouse.set(house, count + 1); kept++; continue; }
      try { await engine.json('DELETE', `/images/${name}`, undefined, signal); } catch { /* in use, or gone */ }
    }
    if (!leftovers) return;
    try { await engine.json('POST', `/images/prune?filters=${filters({ dangling: ['true'], until: [LEFTOVER_IMAGES] })}`, undefined, signal); } catch { /* an engine without it */ }
    try { await engine.json('POST', `/build/prune?filters=${filters({ until: [LEFTOVER_CACHE] })}`, undefined, signal); } catch { /* an engine without it */ }
  } catch { /* best effort */ }
}
