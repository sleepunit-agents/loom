#!/usr/bin/env node
/** Run on the worker machine after building a self-contained release directory.
 * Usage: node scripts/check-house-cli.mjs <Podman image ID> <worker release directory>
 * The image receives the worker's read-only program and no account or agent mounts.
 */
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [image, directory] = process.argv.slice(2);
if (process.argv.length !== 4 || !/^(?:sha256:)?[a-f0-9]{12,64}$/.test(image ?? '')) {
  throw Error('Expected a local image ID and the self-contained worker release directory');
}
const program = realpathSync(directory);
const {bodyMounts,BODY_PROGRAM,BODY_PROGRAM_TARGET} = await import(pathToFileURL(join(program,'dist/runtime/worker-mounts.js')));
const mounts = bodyMounts({program})({agent:'fixture',harness:'codex',account:'fixture'});
const probe = `
  import assert from 'node:assert/strict';
  import {execFileSync} from 'node:child_process';
  import {readFileSync} from 'node:fs';
  import {bodyCommandEnvironment} from '${BODY_PROGRAM_TARGET}/dist/runtime/worker-mounts.js';
  const env = bodyCommandEnvironment('${BODY_PROGRAM}',process.env);
  const version = JSON.parse(readFileSync('${BODY_PROGRAM_TARGET}/package.json','utf8')).version;
  for (const [shell,flags] of [['/bin/sh','-c'],['/bin/bash','-lc']]) {
    const invoke = command => execFileSync(shell,[flags,command],{env,encoding:'utf8'});
    assert.equal(invoke('loom --version').trim(),'loom v'+version);
    assert.match(invoke('loom --help'),/loom serve --home/);
    console.log(shell,flags,invoke('command -v loom').trim(),version);
  }
`;
execFileSync('podman',['run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL',
  '--user','65534:65534','--env','LOOM_BODY_OWN_HARNESS=0',
  ...mounts.flatMap(({source,target,readOnly})=>{
    if (!readOnly) throw Error('Expected a read-only program mount');
    return ['--volume',source+':'+target+':ro'];
  }), '--entrypoint','/usr/local/bin/node',image,'--input-type=module','-e',probe],{stdio:'inherit'});
