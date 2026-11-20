/**
 * Finding the programs core runs (`age`, `age-keygen`, `tar`): LOOM_<NAME> when set (an
 * absolute path to a file; `age-keygen` is LOOM_AGE_KEYGEN), else the first on PATH. They're
 * always run without a shell, with absolute paths as arguments (so nothing reads as an option).
 * The bundle (src/bundle.ts) and the audit log (src/audit.ts) both find `age` this way.
 */
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function findProgram(name: string, env: NodeJS.ProcessEnv, neededBy = 'loom'): string {
  const v = `LOOM_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const override = env[v];
  if (override) {
    if (!override.startsWith('/') || !existsSync(override) || !statSync(override).isFile()) {
      throw new Error(`${v} must be the absolute path of the ${name} program`);
    }
    return override;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(`${name} isn't installed (or on PATH); ${neededBy} needs it. Set ${v} to its path if it lives elsewhere.`);
}
