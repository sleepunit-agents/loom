#!/usr/bin/env node
/** Run on the worker machine after building a self-contained release directory.
 * Usage: node scripts/check-house-cli.mjs <Podman image ID> <worker release directory> [mapped unprivileged UID/GID]
 * The image receives the worker's read-only program and no account or agent mounts.
 */
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [image, directory, user='65534'] = process.argv.slice(2);
if ((process.argv.length < 4 || process.argv.length > 5 || !/^[1-9][0-9]{0,4}$/.test(user)) || !/^(?:sha256:)?[a-f0-9]{12,64}$/.test(image ?? '')) {
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
  import {copyFileSync,mkdtempSync,readFileSync} from 'node:fs';
  import {bodyNoteFileReader} from '${BODY_PROGRAM_TARGET}/dist/runtime/body-files.js';
  import {execFile} from 'node:child_process';
  import {promisify} from 'node:util';
  import {createHash} from 'node:crypto';
  import {bodySecretTools} from '${BODY_PROGRAM_TARGET}/dist/runtime/body-secret-tools.js';
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
  // The offline image has no household credential. A job-local listener serves fixture notes.
  const work=mkdtempSync('/tmp/loom-note-'), source=work+'/fixture.png';
  copyFileSync('/opt/loom/assets/icons/loom-32.png',source);
  const readFixture=bodyNoteFileReader(work,[work]);
  const notes=new Map(),attachments=new Map();
  const tools=await bodySecretTools({agent:'fixture',job:'job',conversation:'room',url:'https://fixture.invalid',
    token:'fixture',signal:new AbortController().signal,
    houseSend:{venue:'loom',denied:[],async call(name,args){
      assert.equal(name,'loom_command');assert.equal(args.operation,'conversation.message');
      assert.equal(args.input.kind,'progress');assert.equal(args.input.words,'fixture progress');
      return {content:[{type:'text',text:JSON.stringify({ok:true,value:{saved:true,seq:1}})}]};
    }},houseNotes:{denied:[],async call(name,args){
      let value;
      if(name==='loom_command'&&args.operation==='memory.noteAttach'){
        const {contents:bytes}=readFixture(args.input.source);
        const sha256=createHash('sha256').update(bytes).digest('hex');
        attachments.set(args.input.path,bytes);
        value={ok:true,value:{name:args.input.name,sha256,bytes:bytes.length,added:'2026-01-01'}};
      }else if(name==='loom_command'&&args.operation==='memory.noteFile'){
        const bytes=attachments.get(args.input.path);
        assert.ok(notes.has(args.input.path));assert.equal(args.input.name,'sample.bin');
        value={ok:true,value:{contents:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
      }else if(name==='loom_command'&&args.operation==='memory.noteDelete'){
        value={ok:true,value:{deleted:notes.delete(args.input.path)}};
      }else if(name==='loom_command'&&args.operation==='memory.notePin'){
        notes.get(args.input.path).pinned=args.input.pinned;
        value={ok:true,value:{...args.input,expires:null}};
      }else if(name==='loom_command'){
        assert.equal(args.operation,'memory.noteWrite');
        notes.set(args.input.path,{...args.input,updated:'2026-01-01',pinned:false,files:0});
        value={ok:true,value:{saved:true}};
      }else{
        assert.equal(args.variables.agent,'fixture');
        value={data:args.variables.path?{memoryNote:notes.get(args.variables.path)}:{memoryNotes:[...notes.values()]}};
      }
      return {content:[{type:'text',text:JSON.stringify(value)}]};
    }}});
  try{
    for(const [shell,flags,path] of [['/bin/sh','-c','fixture/normal'],['/bin/bash','-lc','fixture/login']]){
      const run=async command=>(await promisify(execFile)(shell,[flags,command],{env:{...env,LOOM_BODY_HOUSE_NOTE:tools.houseNote,LOOM_BODY_HOUSE_SEND:tools.houseSend}})).stdout;
      assert.match(await run('loom note write '+path+' --body words --lifespan short'),/Saved/);
      assert.equal((await run('loom note read '+path)).trim(),'words');
      assert.ok(JSON.parse(await run('loom note list --json')).some(n=>n.path===path));
      assert.ok(JSON.parse(await run('loom note attach '+path+' '+source+' --name sample.bin --json')).bytes>0);
      const binary=await promisify(execFile)(shell,[flags,'loom note file '+path+' sample.bin'],{encoding:'buffer',env:{...env,LOOM_BODY_HOUSE_NOTE:tools.houseNote}});
      assert.deepEqual(binary.stdout,readFileSync('/opt/loom/assets/icons/loom-32.png'));
      for(const command of ['pin','unpin']){
        const changed=JSON.parse(await run('loom note '+command+' '+path+' --json'));
        assert.equal(changed.pinned,command==='pin');
      }
      assert.ok(JSON.parse(await run('loom note delete '+path+' --json')).deleted);
      console.log(shell,flags,'note write/read/list/attach/file/pin/unpin/delete passed');
      const update=JSON.parse(await run('loom runtime send --conversation room --text "fixture progress"'));
      assert.equal(update.recorded,true);assert.equal(update.seq,1);
      console.log(shell,flags,'runtime send recorded the fixture progress message');
    }
  }finally{await tools.close();}

`;
execFileSync('podman',['run','--rm','--pull=never','--network=none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777','--cap-drop=ALL',
  '--user',user+':'+user,'--env','LOOM_BODY_OWN_HARNESS=0',
  ...mounts.flatMap(({source,target,readOnly})=>{
    if (!readOnly) throw Error('Expected a read-only program mount');
    return ['--volume',source+':'+target+':ro'];
  }), '--entrypoint','/usr/local/bin/node',image,'--input-type=module','-e',probe],{stdio:'inherit'});
