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
import { DockerResponseError, LISTING_MAX, type DockerEngine } from './docker-engine.js';
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
/** How a house image's name begins, and how many hex digits of the house's digest follow. */
const PREFIX = 'localhost/loom-house-', HOUSE_DIGITS = 16;
const IMAGE_ID = new RegExp(`^(sha256:)?${SHA256_HEX_WITHIN}$`);
const HOUSE = new RegExp(`^[0-9a-f]{${HOUSE_DIGITS}}$`);
/** Whether this is the name of a house image, the one shape asked about everywhere an image is named: how
 * it begins, the house's digits, a colon, and a commit (the one shape of a commit, apps/merge-target.ts). */
export const houseImageName = (image: unknown): image is string => {
  if (typeof image !== 'string' || !image.startsWith(PREFIX)) return false;
  const [house, commit, ...more] = image.slice(PREFIX.length).split(':');
  return more.length === 0 && HOUSE.test(house) && commit !== undefined && COMMIT.test(commit);
};
/** A harness's name as a label can carry it. */
const HARNESS = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const repositoryOf = (house: House) => `${PREFIX}${createHash('sha256').update(`${house.repository}\0${house.file}`).digest('hex').slice(0, HOUSE_DIGITS)}`;
/** The image of this repository and Housefile at this commit. */
export const houseImage = (house: House, commit: string): string => `${repositoryOf(house)}:${commit}`;
const filters = (value: Record<string, string[]>) => encodeURIComponent(JSON.stringify(value));
const missing = (error: unknown) => error instanceof DockerResponseError && error.status === 404;

/** Whether the engine has this image. */
export async function houseBuilt(engine: DockerEngine, image: string, signal: AbortSignal): Promise<boolean> {
  if (!houseImageName(image)) throw new Error('Invalid house image');
  try { await engine.json('GET', `/images/${image}/json`, undefined, signal); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}
/** Have the engine build the image from this context. Resolves only when the image is there afterwards:
 * an engine's build can end without one and without saying so. */
export async function buildHouse(engine: DockerEngine, image: string, file: string, context: Readable, signal: AbortSignal): Promise<void> {
  if (!houseImageName(image) || !houseFile(file)) { context.destroy(); throw new Error('Invalid house image'); }
  // Quiet, intermediate containers removed whether it works or not, nothing pulled that is already here.
  // No build argument, no label of the worker's, no network or privilege setting: the engine's defaults.
  await engine.build(`/build?t=${encodeURIComponent(image)}&dockerfile=${encodeURIComponent(file)}&q=1&rm=1&forcerm=1`, context, signal);
  if (!await houseBuilt(engine, image, signal)) throw new Error('House image was not built');
}

/** How a body starts in a house image: the image itself, by its id; the node program; the harness's body
 * file; the directory to start in. */
export interface HouseStart { id: string; node: string; body: string; cwd: string }
/** Read the image contract for one harness, and check all of it that an image's inspection can show,
 * before any container is made of the image. Whether the node program and the body file are really in the
 * image at the paths its labels name cannot be seen from here: an image that names one that is not there
 * fails when its body is started (WORKER_EXIT.launch, or the body's own code for its file).
 * @throws UnmetHouseError (WORKER_EXIT.house), naming the label or rule, when the image does not meet it. */
export async function houseStart(engine: DockerEngine, image: string, harness: string, signal: AbortSignal): Promise<HouseStart> {
  if (!houseImageName(image)) throw new Error('Invalid house image');
  const found: unknown = await engine.json('GET', `/images/${image}/json`, undefined, signal);
  const refuse = (rule: string): never => { throw new UnmetHouseError(rule); };
  if (!found || typeof found !== 'object' || !('Id' in found) || typeof found.Id !== 'string' || !IMAGE_ID.test(found.Id)) throw new Error('Invalid image identity');
  const config: unknown = 'Config' in found ? found.Config : undefined;
  if (!config || typeof config !== 'object') return refuse(HOUSE_LABEL);
  const labels: unknown = 'Labels' in config ? config.Labels : undefined, cwd: unknown = 'WorkingDir' in config ? config.WorkingDir : undefined;
  const volumes: unknown = 'Volumes' in config ? config.Volumes : undefined;
  if (!labels || typeof labels !== 'object') return refuse(HOUSE_LABEL);
  const label = (name: string): unknown => Object.hasOwn(labels, name) ? (labels as Record<string, unknown>)[name] : undefined;
  if (label(HOUSE_LABEL) !== HOUSE_VERSION) return refuse(HOUSE_LABEL);
  const node = label(HOUSE_LABEL_NODE);
  if (!plainPath(node)) return refuse(HOUSE_LABEL_NODE);
  // A harness's own name is said only when it is one a label could carry.
  if (!HARNESS.test(harness)) return refuse(`${HOUSE_LABEL_BODY}<harness>`);
  const body = label(`${HOUSE_LABEL_BODY}${harness}`);
  if (!plainPath(body)) return refuse(`${HOUSE_LABEL_BODY}${harness}`);
  if (!plainPath(cwd)) return refuse('WORKDIR');
  // A volume the image or its base declares would be storage the worker did not ask for.
  if (volumes !== undefined && volumes !== null && (typeof volumes !== 'object' || Object.keys(volumes).length > 0)) return refuse('VOLUME');
  return { id: found.Id, node, body, cwd };
}

/** Who says whether an image may be removed. Asked for each image at the moment it is about to be removed,
 * not before: a job can take hold of an image while the removals are under way. `take` answers and, when
 * it says yes, marks the image as being removed until `done` is called for it, so that whoever wants
 * that image meanwhile can wait for the removal to be over and not find it half gone. */
export interface HouseGuard { take(image: string): boolean; done(image: string): void }
/** After a build: remove the house images this worker no longer needs, and what builds left behind.
 * Never one the guard holds back, never by force (the engine refuses one a container uses), never an error.
 * @returns false when the engine's images could not be listed, so that nothing was looked at: whoever
 * asked says so. What could not be removed now is found again after the next build. */
export async function pruneHouses(engine: DockerEngine, guard: HouseGuard, leftovers: boolean, signal: AbortSignal): Promise<boolean> {
  let listed: unknown;
  // Only loom's own house images are asked for. Each comes with its labels, so the answer may be long.
  try { listed = await engine.json('GET', `/images/json?filters=${filters({ reference: [`${PREFIX}*`] })}`, undefined, signal, LISTING_MAX); }
  catch { return false; }
  if (!Array.isArray(listed)) return false;
  const images: { name: string; built: number }[] = [];
  for (const row of listed as unknown[]) {
    if (!row || typeof row !== 'object' || !('RepoTags' in row) || !Array.isArray(row.RepoTags)) continue;
    const built = 'Created' in row && typeof row.Created === 'number' ? row.Created : 0;
    for (const name of row.RepoTags as unknown[]) if (houseImageName(name)) images.push({ name, built });
  }
  images.sort((one, other) => other.built - one.built);
  const perHouse = new Map<string, number>(); let kept = 0;
  for (const { name } of images) {
    const house = name.slice(0, name.indexOf(':')), count = perHouse.get(house) ?? 0;
    if (count < HOUSE_IMAGES_PER_HOUSE && kept < HOUSE_IMAGES_KEPT) { perHouse.set(house, count + 1); kept++; continue; }
    // Held back: it stays, and counts among what is kept.
    if (!guard.take(name)) { perHouse.set(house, count + 1); kept++; continue; }
    try { await engine.json('DELETE', `/images/${name}`, undefined, signal); } catch { /* in use, or gone */ }
    finally { guard.done(name); }
  }
  if (!leftovers) return true;
  try { await engine.json('POST', `/images/prune?filters=${filters({ dangling: ['true'], until: [LEFTOVER_IMAGES] })}`, undefined, signal); } catch { /* an engine without it */ }
  try { await engine.json('POST', `/build/prune?filters=${filters({ until: [LEFTOVER_CACHE] })}`, undefined, signal); } catch { /* an engine without it */ }
  return true;
}
