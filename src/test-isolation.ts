/**
 * Vitest setup: keep every test file off the machine's own loom (t-1748).
 *
 * Without this, a test that doesn't set LOOM_HOME itself falls back to
 * $HOME/.config/loom, and finds the pieces installed there: on loom's own
 * machine, the relay test ran the real managed `loom-clock`, the project hub
 * test saw the real `tasks` piece's section, and the piece-api flood test
 * waited on the real pieces behind /pieces.json. CI has none of those, so the
 * suite passed there and failed here.
 *
 *  - LOOM_HOME is a fresh, empty dir per test file (removed when the worker
 *    exits). A test that wants a household still sets its own.
 *  - PATH keeps its dirs, but a dir that holds a `loom-<piece>` executable is
 *    stood in for by a dir of links to everything else in it (so `age`, `git`
 *    and the rest are still found), and the only pieces a test finds are the
 *    ones it put on PATH itself.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'loom-test-env-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home');
mkdirSync(home);
process.env.LOOM_HOME = home;

const ls = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
process.env.PATH = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir, i) => {
  const names = ls(dir);
  if (!names.some((f) => f.startsWith('loom-'))) return dir;
  const stand = join(root, `path-${i}`);
  mkdirSync(stand);
  for (const f of names) if (!f.startsWith('loom-')) symlinkSync(join(dir, f), join(stand, f));
  return stand;
}).join(delimiter);
