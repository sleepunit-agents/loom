/** A name that goes nowhere but down from where it starts: relative, with no part that is empty, `.` or `..`.
 * The one rule for a file's name in a context and for a Housefile's path. */
export const relativeName = (name: string): boolean => name.length > 0 && !name.startsWith('/') && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/** A branch name plain enough to be put in a refspec: no option, no range, no pattern, no ref trickery. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const hasControlCharacter = (text: string) => /[\0-\x1f\x7f]/.test(text);

/** The Housefile's path inside the repository: relative, going nowhere but down. */
export const houseFile = (file: unknown): file is string => typeof file === 'string' && file.length <= 512 && !hasControlCharacter(file) && !file.includes('\\') && relativeName(file);
export const houseBranch = (branch: unknown): branch is string => typeof branch === 'string' && BRANCH.test(branch)
  && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.') && !branch.endsWith('.lock');
/** The repository's address as a URL, when it is one the worker fetches. */
export function houseAddress(repository: unknown, protocols: readonly string[]): URL | undefined {
  // No backslash and no `@` anywhere: a URL parser and git do not read either the same way.
  if (typeof repository !== 'string' || repository.length > 2048 || hasControlCharacter(repository) || /[\s\\@]/.test(repository)) return undefined;
  let url: URL;
  try { url = new URL(repository); } catch { return undefined; }
  if (!protocols.includes(url.protocol.slice(0, -1)) || !repository.startsWith(`${url.protocol}//`)) return undefined;
  if (url.username || url.password || url.search || url.hash || repository.includes('?') || repository.includes('#')) return undefined;
  // As it is written, not as a URL parser mends it: `https:///x` has no host, whatever a parser makes of it.
  if (url.protocol === 'https:' ? !url.hostname || !repository.toLowerCase().startsWith(`https://${url.host}`) : url.hostname !== '' || !repository.startsWith('file:///')) return undefined;
  return url;
}
/** Whether this is an address a worker fetches a house from: `https`, with no user, password, query or
 * fragment in it. Such an address holds no credential and can be told to a body. */
export const houseRepository = (repository: unknown): repository is string => houseAddress(repository, ['https']) !== undefined;
