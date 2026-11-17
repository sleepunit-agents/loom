/** A house's image on the engine: what it is called, whether it is there, building it, what it says about
 * starting a body, and removing old ones.
 *
 * The image is built by the engine from a tar stream of the house's repository at one commit
 * (house-source.ts) and the path of its Housefile inside that stream. The worker reads neither. What a
 * build step may do is what the engine lets a build do: the worker adds one build argument (the core house's image) and no secret, host
 * path, socket or privilege (docs/accepted-tradeoffs.md, "A Housefile is as dangerous as the engine's
 * builder lets it be").
 *
 * The name is the repository, the Housefile, the commit and the core house it was built on: the same four
 * are found again with one question. A house is built again when one of them changes: its own commit, or
 * the core (a new definition of it in a new loom, or a new week). Nothing else of the worker is in a name.
 *
 * The core house is an image of the same kind that the worker builds from a definition in its own
 * install (house-core.ts): named by that definition's digest and the week, handed to every house's build
 * as the build argument CORE_ARGUMENT, and held to the image contract like any house. */
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DockerResponseError, LISTING_MAX, type DockerEngine } from './docker-engine.js';
import { UnmetHouseError } from './worker.js';
import { houseFile, type House } from './house-source.js';
import { HARNESS_NAME } from './house-layout.js';
import { COMMIT } from '../apps/merge-target.js';
import { SHA256_HEX_WITHIN } from '../core/sha256-hex.js';

/** The image contract: what every house image says about itself, as labels (docs/runtime/worker.md,
 * "What a house image must say"). The version this worker reads, and which harnesses the house serves.
 * Where things are in a house is not the image's to say: that is the layout (house-layout.ts). */
export const HOUSE_LABEL = 'loom.house', HOUSE_VERSION = '2';
export const HOUSE_LABEL_HARNESSES = 'loom.house.harnesses';
/** How many images of one house are kept (the one in use and the one before it), and how many house
 * images in all. */
export const HOUSE_IMAGES_PER_HOUSE = 2, HOUSE_IMAGES_KEPT = 10;
/** What the engine is asked to forget after a build: unnamed images older than this, build cache unused for that. */
const LEFTOVER_IMAGES = '24h', LEFTOVER_CACHE = '168h';
/** How a house image's name begins, and how many hex digits of the house's digest follow. */
const PREFIX = 'localhost/loom-house-', HOUSE_DIGITS = 16;
/** The core house's image: one name, tagged with so many hex digits of its definition's digest, a dash, and
 * the week it was built for (house-core.ts). */
const CORE_PREFIX = 'localhost/loom-core:';
const CORE_TAG_SHAPE = `[0-9a-f]{${HOUSE_DIGITS}}-[0-9]{4}w[0-9]{2}`, CORE_TAG = new RegExp(`^${CORE_TAG_SHAPE}$`);
/** The build argument every house's build is given: the core house's image, to start `FROM`. */
export const CORE_ARGUMENT = 'LOOM_CORE';
/** The path the core's own Housefile has in its context. */
export const CORE_FILE = 'Housefile';
const IMAGE_ID = new RegExp(`^(sha256:)?${SHA256_HEX_WITHIN}$`);
const HOUSE = new RegExp(`^[0-9a-f]{${HOUSE_DIGITS}}$`);
/** Whether this is the name of a core house image. */
export const coreImageName = (image: unknown): image is string => typeof image === 'string' && image.startsWith(CORE_PREFIX) && CORE_TAG.test(image.slice(CORE_PREFIX.length));
/** The core house's image for this definition in this week. */
export const coreImage = (digest: string, week: string): string => {
  const image = `${CORE_PREFIX}${digest.slice(0, HOUSE_DIGITS)}-${week}`;
  if (!coreImageName(image)) throw new Error('Invalid core house image');
  return image;
};
/** Whether this is the name of a house image, the one shape asked about everywhere an image is named: how
 * it begins, the house's digits, a colon, a commit (the one shape of a commit, apps/merge-target.ts), a
 * dash, and the tag of the core house it was built on. */
export const houseImageName = (image: unknown): image is string => {
  if (typeof image !== 'string' || !image.startsWith(PREFIX)) return false;
  const [house, tag, ...more] = image.slice(PREFIX.length).split(':');
  if (more.length || !HOUSE.test(house) || tag === undefined) return false;
  const cut = tag.indexOf('-');
  return cut > 0 && COMMIT.test(tag.slice(0, cut)) && CORE_TAG.test(tag.slice(cut + 1));
};
/** A house image as a worker named it before houses were built on a core: the house's digits and a commit,
 * with no core's tag. No worker starts a body in one any more; they are only ever removed (pruneHouses). */
const earlierHouseImage = (image: unknown): image is string => {
  if (typeof image !== 'string' || !image.startsWith(PREFIX)) return false;
  const [house, commit, ...more] = image.slice(PREFIX.length).split(':');
  return more.length === 0 && HOUSE.test(house) && commit !== undefined && COMMIT.test(commit);
};
/** The commit a house image was built from, by its name: the one thing that says so, whatever the
 * job's branch has moved to since. */
export const houseCommit = (image: string): string => {
  if (!houseImageName(image)) throw new Error('Invalid house image');
  return image.slice(image.indexOf(':') + 1, image.indexOf(':') + 1 + image.slice(image.indexOf(':') + 1).indexOf('-'));
};
/** The core house a house image was built on, by its name. */
export const houseCore = (image: string): string => {
  if (!houseImageName(image)) throw new Error('Invalid house image');
  const tag = image.slice(image.indexOf(':') + 1);
  return `${CORE_PREFIX}${tag.slice(tag.indexOf('-') + 1)}`;
};

const repositoryOf = (house: House) => `${PREFIX}${createHash('sha256').update(`${house.repository}\0${house.file}`).digest('hex').slice(0, HOUSE_DIGITS)}`;
/** The image of this repository and Housefile at this commit, built on this core house. A house with no
 * Housefile (an empty path) is the core with the repository copied in, and is named the same way. */
export const houseImage = (house: House, commit: string, core: string): string => {
  if (!coreImageName(core)) throw new Error('Invalid core house image');
  return `${repositoryOf(house)}:${commit}-${core.slice(CORE_PREFIX.length)}`;
};
const filters = (value: Record<string, string[]>) => encodeURIComponent(JSON.stringify(value));
const missing = (error: unknown) => error instanceof DockerResponseError && error.status === 404;

/** Whether the engine has this image: a house's, or a core house's. */
export async function houseBuilt(engine: DockerEngine, image: string, signal: AbortSignal): Promise<boolean> {
  if (!houseImageName(image) && !coreImageName(image)) throw new Error('Invalid house image');
  try { await engine.json('GET', `/images/${image}/json`, undefined, signal); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}
// Quiet, intermediate containers removed whether it works or not, nothing pulled that is already here.
// No label of the worker's, no secret, no network or privilege setting: the engine's defaults.
const BUILD = 'q=1&rm=1&forcerm=1';
/** Have the engine build the image from this context. Resolves only when the image is there afterwards:
 * an engine's build can end without one and without saying so. The build is given one argument, the core
 * house the image is named for; a Housefile that does not start from it leaves the argument unused. */
export async function buildHouse(engine: DockerEngine, image: string, file: string, context: Readable, signal: AbortSignal): Promise<void> {
  if (!houseImageName(image) || !houseFile(file)) { context.destroy(); throw new Error('Invalid house image'); }
  const given = encodeURIComponent(JSON.stringify({ [CORE_ARGUMENT]: houseCore(image) }));
  await engine.build(`/build?t=${encodeURIComponent(image)}&dockerfile=${encodeURIComponent(file)}&buildargs=${given}&${BUILD}`, context, signal);
  if (!await houseBuilt(engine, image, signal)) throw new Error('House image was not built');
}
/** Whether the engine has this core house, and it is one: an image under the core's name that does not
 * meet the image contract (one whose removal failed after a build that made no house, say) is removed and
 * counts as not there, so that it is built again and no house is ever built on it. */
export async function coreThere(engine: DockerEngine, image: string, signal: AbortSignal): Promise<boolean> {
  if (!coreImageName(image)) throw new Error('Invalid core house image');
  let found: unknown;
  try { found = await engine.json('GET', `/images/${image}/json`, undefined, signal); } catch (error) { if (missing(error)) return false; throw error; }
  try { contract(found); return true; }
  catch (error) { if (!(error instanceof UnmetHouseError)) throw error; await engine.json('DELETE', `/images/${image}`, undefined, signal).catch(() => {}); return false; }
}
/** Have the engine build the core house from the worker's own definition of it, with no argument at all.
 * The core is held to what a house is: when what was built does not say it is a house of this layout,
 * names no harness, or declares a volume, the image is removed again and the build has failed. */
export async function buildCore(engine: DockerEngine, image: string, context: Readable, signal: AbortSignal): Promise<void> {
  if (!coreImageName(image)) { context.destroy(); throw new Error('Invalid core house image'); }
  await engine.build(`/build?t=${encodeURIComponent(image)}&dockerfile=${CORE_FILE}&${BUILD}`, context, signal);
  try { contract(await engine.json('GET', `/images/${image}/json`, undefined, signal)); }
  catch (error) {
    if (error instanceof UnmetHouseError) await engine.json('DELETE', `/images/${image}`, undefined, signal).catch(() => {});
    throw new Error('Core house image was not built');
  }
}

/** What an image's inspection says of the image contract: the image, and the harnesses it serves.
 * @throws UnmetHouseError naming the label or rule it breaks. */
function contract(found: unknown): { id: string; harnesses: string[] } {
  const refuse = (rule: string): never => { throw new UnmetHouseError(rule); };
  if (!found || typeof found !== 'object' || !('Id' in found) || typeof found.Id !== 'string' || !IMAGE_ID.test(found.Id)) throw new Error('Invalid image identity');
  const config: unknown = 'Config' in found ? found.Config : undefined;
  if (!config || typeof config !== 'object') return refuse(HOUSE_LABEL);
  const labels: unknown = 'Labels' in config ? config.Labels : undefined, volumes: unknown = 'Volumes' in config ? config.Volumes : undefined;
  if (!labels || typeof labels !== 'object') return refuse(HOUSE_LABEL);
  const label = (name: string): unknown => Object.hasOwn(labels, name) ? (labels as Record<string, unknown>)[name] : undefined;
  if (label(HOUSE_LABEL) !== HOUSE_VERSION) return refuse(HOUSE_LABEL);
  // The harnesses the house serves, by name, with spaces between.
  const served = label(HOUSE_LABEL_HARNESSES);
  if (typeof served !== 'string' || !served.split(' ').some(name => HARNESS_NAME.test(name))) return refuse(HOUSE_LABEL_HARNESSES);
  // A volume the image or its base declares would be storage the worker did not ask for.
  if (volumes !== undefined && volumes !== null && (typeof volumes !== 'object' || Object.keys(volumes).length > 0)) return refuse('VOLUME');
  return { id: found.Id, harnesses: served.split(' ') };
}

/** A house image a body may be started in: the image itself, by its id. Everything else about starting
 * a body is the layout, which is the same in every house (house-layout.ts). */
export interface HouseStart { id: string }
/** Read the image contract for one harness, and check all of it that an image's inspection can show,
 * before any container is made of the image: its version, that it serves the job's harness, and that it
 * declares no volume. Whether node and the harness's body file are really in the image at their fixed
 * places cannot be seen from here: an image without them fails when its body is started
 * (WORKER_EXIT.launch, or the body's own code for its file).
 * @throws UnmetHouseError (WORKER_EXIT.house), naming the label or rule, when the image does not meet it. */
export async function houseStart(engine: DockerEngine, image: string, harness: string, signal: AbortSignal): Promise<HouseStart> {
  if (!houseImageName(image)) throw new Error('Invalid house image');
  const { id, harnesses } = contract(await engine.json('GET', `/images/${image}/json`, undefined, signal));
  // A job's own harness is one of those the house serves.
  if (!HARNESS_NAME.test(harness) || !harnesses.includes(harness)) throw new UnmetHouseError(HOUSE_LABEL_HARNESSES);
  return { id };
}

/** Who says whether an image may be removed. Asked for each image at the moment it is about to be removed,
 * not before: a job can take hold of an image while the removals are under way. `take` answers and, when
 * it says yes, marks the image as being removed until `done` is called for it, so that whoever wants
 * that image meanwhile can wait for the removal to be over and not find it half gone. */
export interface HouseGuard {
  take(image: string): boolean; done(image: string): void;
  /** When this worker last built or took this image, as a number that only grows; undefined when it never
   * has. The engine's own time for an image is when its last layer was made, which for one built again
   * from the engine's cache is long ago: by that clock an image just built can be the oldest there is. */
  used(image: string): number | undefined;
}
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
  const images: { name: string; built: number }[] = [], earlier: string[] = [];
  for (const row of listed as unknown[]) {
    if (!row || typeof row !== 'object' || !('RepoTags' in row) || !Array.isArray(row.RepoTags)) continue;
    const built = 'Created' in row && typeof row.Created === 'number' ? row.Created : 0;
    for (const name of row.RepoTags as unknown[]) if (houseImageName(name)) images.push({ name, built }); else if (earlierHouseImage(name)) earlier.push(name);
  }
  /** Ask the engine to remove one image, never by force: it refuses one a container uses, and that is left. */
  const remove = async (name: string) => { try { await engine.json('DELETE', `/images/${name}`, undefined, signal); } catch { /* in use, or gone */ } };
  // What an earlier worker built under the name houses had before the core: no job can be given one
  // again, so none is kept. One a container still runs in is refused by the engine and found again later.
  for (const name of earlier) await remove(name);
  // Newest first: what this worker used most recently, then what it never touched, by the engine's time.
  images.sort((one, other) => (guard.used(other.name) ?? -1) - (guard.used(one.name) ?? -1) || other.built - one.built);
  const perHouse = new Map<string, number>(), keptNames: string[] = []; let kept = 0;
  for (const { name } of images) {
    const house = name.slice(0, name.indexOf(':')), count = perHouse.get(house) ?? 0;
    if (count < HOUSE_IMAGES_PER_HOUSE && kept < HOUSE_IMAGES_KEPT) { perHouse.set(house, count + 1); kept++; keptNames.push(name); continue; }
    // Held back: it stays, and counts among what is kept.
    if (!guard.take(name)) { perHouse.set(house, count + 1); kept++; keptNames.push(name); continue; }
    try { await remove(name); } finally { guard.done(name); }
  }
  // Core houses: one is kept while a house image that is kept was built on it, and while the guard holds
  // it back (a build of it or on it is under way). They are not counted among the house images: there
  // are never more of them than there are house images kept, and each shares its layers with those.
  const built = new Set(keptNames.map(houseCore));
  let cores: unknown;
  try { cores = await engine.json('GET', `/images/json?filters=${filters({ reference: [CORE_PREFIX.slice(0, -1)] })}`, undefined, signal, LISTING_MAX); }
  catch { return false; }
  if (!Array.isArray(cores)) return false;
  for (const row of cores as unknown[]) {
    if (!row || typeof row !== 'object' || !('RepoTags' in row) || !Array.isArray(row.RepoTags)) continue;
    for (const name of row.RepoTags as unknown[]) {
      if (!coreImageName(name) || built.has(name) || !guard.take(name)) continue;
      try { await remove(name); } finally { guard.done(name); }
    }
  }
  if (!leftovers) return true;
  try { await engine.json('POST', `/images/prune?filters=${filters({ dangling: ['true'], until: [LEFTOVER_IMAGES] })}`, undefined, signal); } catch { /* an engine without it */ }
  try { await engine.json('POST', `/build/prune?filters=${filters({ until: [LEFTOVER_CACHE] })}`, undefined, signal); } catch { /* an engine without it */ }
  return true;
}
