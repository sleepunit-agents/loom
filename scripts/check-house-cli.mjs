#!/usr/bin/env node
/** Run on the worker machine after building a self-contained release directory.
 * Usage: node scripts/check-house-cli.mjs <Podman image ID> <worker release directory>
 * The image receives the worker's read-only program and no account or agent mounts.
 */
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [image, directory] = process.argv.slice(2);
if (process.argv.length !== 4 || !/^(?:sha256:)?[a-f0-9]{12,64}$/.test(image ?? '')) {
  throw Error('Expected a local image ID and the self-contained worker release directory');
}
const program = realpathSync(directory);
const {bodyMounts,BODY_PROGRAM,BODY_PROGRAM_TARGET,HOUSE_CLI_FILE,HOUSE_CLI_TARGET} = await import(pathToFileURL(join(program,'dist/runtime/worker-mounts.js')));
const {prepareHouseCli}=await import(pathToFileURL(join(program,'dist/runtime/house-cli-file.js')));
const state=mkdtempSync(join(realpathSync(tmpdir()),'loom-cli-check-'));
process.on('exit',()=>rmSync(state,{recursive:true,force:true}));
prepareHouseCli(state);
const mounts = bodyMounts({program,state})({agent:'fixture',harness:'codex',account:'fixture'});
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
    const found=invoke('command -v loom').trim();
    assert.equal(found,flags==='-lc' ? '${HOUSE_CLI_TARGET}' : '${BODY_PROGRAM_TARGET}/${HOUSE_CLI_FILE}');
    console.log(shell,flags,found,version);
  }
`;
execFileSync('podman',['run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL',
  '--user','65534:65534','--env','LOOM_BODY_OWN_HARNESS=0',
  ...mounts.flatMap(({source,target,readOnly})=>{
    if (!readOnly) throw Error('Expected a read-only program mount');
    return ['--volume',source+':'+target+':ro'];
  }), '--entrypoint','/usr/local/bin/node',image,'--input-type=module','-e',probe],{stdio:'inherit'});
