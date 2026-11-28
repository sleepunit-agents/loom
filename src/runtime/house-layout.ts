/** The layout loom fixes inside every house: where the tenant lives, where its repository sits, where
 * node and the body files are, and where an account's sign-in appears. It is the same in every house on
 * every machine, and this file is the one place it is written: no machine's configuration and no label
 * of an image says any of it again. Who the tenant is, is the repository; nothing here is named for an agent.
 *
 * The user is not fixed, only the home: a body runs as the image's user, and the worker sets HOME. Under a
 * rootless engine the container's root is the worker's own user, the one that can write a mounted sign-in
 * directory, so a house there runs as root with this home. */

/** The tenant's home. */
export const HOUSE_HOME = '/home/agent';
/** The agent's repository, as the house's Housefile copies it in. A body starts here. */
export const HOUSE_REPOSITORY = `${HOUSE_HOME}/repo`;
/** The node program that runs loom's body program. */
export const HOUSE_NODE = '/usr/local/bin/node';
/** The init that is PID 1 of a body's container, with node under it: Debian's tini, which the core house
 * installs. It collects every orphan a body's tools leave (node as PID 1 never did, so each left a zombie),
 * and with `-g` it passes a signal the container is sent on to the body's whole process group, the
 * harness and its tools with it. Its exit is the body's, or 128 and the signal's number. */
export const HOUSE_INIT = '/usr/bin/tini';
/** How a body's container is started, before the body program and its file. */
export const HOUSE_ENTRYPOINT: readonly string[] = Object.freeze([HOUSE_INIT, '-g', '--', HOUSE_NODE]);
/** A harness's name, as a path and a label can carry it. */
export const HARNESS_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A harness's body file in the image. */
export const houseBodyFile = (harness: string): string => `/etc/loom/body/${harness}.json`;
/** Where the sign-in directory of a job's account appears, for the job's harness. */
export const houseLogin = (harness: string): string => `/run/loom/login/${harness}`;
/** Where an agent's mounted directory lands: under the home, at the path the machine's configuration gives. */
export const houseMount = (relative: string): string => `${HOUSE_HOME}/${relative}`;
/** Where a harness keeps what it writes of a run, its sessions included: its own configuration directory
 * under the home, which is the container's own filesystem and goes with the body. The sign-in is not there:
 * it is the mounted directory at houseLogin, which a harness is pointed at separately (the core house sets
 * CLAUDE_SECURESTORAGE_CONFIG_DIR for Claude Code). So in a house this place is one body's alone for one
 * job, unless a mount is, holds, or is inside it; the worker checks that and says so to the body
 * (body-harness.ts, BODY_OWN_HARNESS), and a body keeps a session of a conversation only there
 * (body-session.ts). A harness not listed keeps no sessions loom knows of. */
const HOUSE_SESSIONS: Readonly<Record<string, string>> = Object.freeze({ claude: `${HOUSE_HOME}/.claude` });
export const houseSessions = (harness: string): string | undefined => Object.hasOwn(HOUSE_SESSIONS, harness) ? HOUSE_SESSIONS[harness] : undefined;
/** Whether one path is the other or inside it, either way round: a mount at, above or under a place. */
export const houseOverlap = (one: string, other: string): boolean => one === other || one.startsWith(other + '/') || other.startsWith(one + '/');
/** What a body is told of the house it is in, as variables the worker sets on its container: the
 * repository's address as it was fetched, the branch the job's settings name, and the commit the image was
 * built from. The worker sets them, so an image's own `ENV` of these names does not hold. With them a
 * repository can turn the copy of itself at HOUSE_REPOSITORY into a checkout of exactly that commit. */
export const HOUSE_ENV = { repository: 'LOOM_HOUSE_REPOSITORY', branch: 'LOOM_HOUSE_BRANCH', commit: 'LOOM_HOUSE_COMMIT' } as const;
