/**
 * Resolve the bundled SKILL.md path. Works from both `src/` (dev via
 * tsx) and `dist/` (published via `npx loom`) because
 * `resolveRepoRoot()` walks one level up from the running module and
 * both `src/` and `dist/` sit alongside `assets/` at the project root.
 */
import { join } from 'node:path';
import { resolveRepoRoot } from '../config.js';

export function resolveSkillSourcePath(): string {
  return join(resolveRepoRoot(), 'assets', 'skill', 'SKILL.md');
}
