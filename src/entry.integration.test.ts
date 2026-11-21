import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The packaged shape, exercised.
 *
 * Every install route — `npm i -g`, `npm link`, `npx` — puts a SYMLINK in a
 * bin directory pointing at dist/index.js, and the entry-point guard used to
 * compare `process.argv[1]` (the symlink) against `import.meta.url` (the real
 * file) as raw strings. It never matched, so `loom --version` exited 0 with no
 * output and `loom serve` started nothing. Running `node dist/index.js`
 * directly — which is what every other test and every dev machine does —
 * hides it completely. So: invoke through a symlink, like a user would.
 */
describe('entry point — invoked through a symlinked bin', () => {
  const dist = resolve(__dirname, '..', 'dist', 'index.js');
  let bin: string;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-entry-bin-'));
    bin = join(dir, 'loom');
    await symlink(dist, bin);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(dist))('installs loom-wake from the npm tarball', async () => {
    const repo = resolve(__dirname,'..');
    const {stdout} = await run('npm',['pack','--offline','--ignore-scripts','--json','--pack-destination',dir],
      {cwd:repo,maxBuffer:8*1024*1024});
    const [{filename}] = JSON.parse(stdout);
    const target = join(dir,'node_modules','@jbarket','loomai');
    await mkdir(target,{recursive:true});
    await run('tar',['-xzf',join(dir,filename),'--strip-components=1','-C',target]);
    await symlink(await realpath(join(repo,'node_modules')),join(target,'node_modules'));
    const manifest = JSON.parse(await readFile(join(target,'package.json'),'utf8'));
    await writeFile(join(dir,'package.json'),JSON.stringify({private:true,dependencies:{[manifest.name]:manifest.version}}));
    await run('npm',['rebuild',manifest.name,'--offline','--ignore-scripts','--no-audit','--no-fund'],{cwd:dir});
    const command = join(dir,'node_modules','.bin','loom-wake');
    expect((await run(command,['--help'])).stdout).toContain('usage: loom-wake');
  },60_000);

  it.skipIf(!existsSync(dist))('dispatches --version through the symlink', async () => {
    const { stdout } = await run(process.execPath, [bin, '--version']);
    expect(stdout).toMatch(/^loom v\d+\.\d+\.\d+/);
  });

  it.skipIf(!existsSync(dist))('prints its usage through the symlink', async () => {
    const { stdout } = await run(process.execPath, [bin, '--help']);
    expect(stdout).toContain('loom serve --home <dir>');
  });
});
