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
/** A harness's name, as a path and a label can carry it. */
export const HARNESS_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A harness's body file in the image. */
export const houseBodyFile = (harness: string): string => `/etc/loom/body/${harness}.json`;
/** Where the sign-in directory of a job's account appears, for the job's harness. */
export const houseLogin = (harness: string): string => `/run/loom/login/${harness}`;
/** Where an agent's mounted directory lands: under the home, at the path the machine's configuration gives. */
export const houseMount = (relative: string): string => `${HOUSE_HOME}/${relative}`;
