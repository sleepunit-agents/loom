import { OperationError } from '../../core/index.js';
export const invalid = (message: string): never => { throw new OperationError('invalid', message); };
export const denied = (message: string): never => { throw new OperationError('denied', message); };
export const name = '[a-z][a-z0-9-]{0,39}';
export const person = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function exactTarget(target: string) {
  if (target.length > 200 || !/^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(target)) invalid("--target is printable ASCII, at most 200 characters, single spaces between words: it's matched exactly as shown");
  return target;
}
export function repoOf(target: string) {
  const m = /^([a-z][a-z0-9-]{0,23}):([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,3})#([1-9][0-9]{0,9})@([0-9a-f]{40})$/.exec(target);
  return m && m[2].length <= 120 ? { repo: `${m[1]}:${m[2].toLowerCase()}`, forge: m[1], locator: m[2].toLowerCase(), number: Number(m[3]), head: m[4] } : undefined;
}
export const hostVerbs = ['unit-status','journal','art-chain-check','read','deploy-loom','pieces-update','restart'];
export function hostOf(target: string) {
  const m = /^([^:]+):([A-Za-z0-9@._/-]{1,200})$/.exec(target);
  return m && hostVerbs.includes(m[1]) && !m[2].split('/').includes('..') ? { verb: m[1], arg: m[2] } : undefined;
}
export function grantOf(target: string) {
  const m = new RegExp(`^(${name}):(${name})(?::((?:\\*|[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*(?:/\\*)?)(?:,(?:\\*|[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*(?:/\\*)?)){0,9}))?$`).exec(target);
  if (!m) return;
  const paths = m[3]?.split(',') ?? ['*'];
  if (paths.some(p => p.split('/').some(x => x === '.' || x === '..'))) return;
  return { piece: m[1], agent: m[2], paths };
}
export function vouchOf(target: string) {
  const m = new RegExp(`^(${name}):(w-[0-9a-f]{6}(?:,w-[0-9a-f]{6}){0,11})$`).exec(target);
  if (!m) return;
  const ids = m[2].split(',');
  return JSON.stringify(ids) === JSON.stringify([...new Set(ids)].sort()) ? { agent: m[1], ids } : undefined;
}
export function resetOf(target: string) { const m = new RegExp(`^(${name}):(cv-[0-9a-f]{12})$`).exec(target); return m ? { agent: m[1], conversation: m[2] } : undefined; }
export function writeoffOf(target: string) { const m = new RegExp(`^(${name}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([0-9]{1,12})$`).exec(target); return m ? { agent: m[1], box: m[2], since: Number(m[3]) } : undefined; }
export const covered = (a: { kind: string; target: string }) => a.kind === 'vouch-wake' ? vouchOf(a.target)?.ids ?? [] : a.kind === 'principal-reset' ? [resetOf(a.target)?.conversation].filter((s): s is string => !!s) : [];
export const globMatch = (pattern: string, text: string) => new RegExp(`^${pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(text);
export const standingTarget = new RegExp(`^(${name}):[0-9a-f]{16}$`);
