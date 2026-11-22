#!/usr/bin/env node
/** Standalone work-plane executable. Never imported by loom's server. */
import { readFile } from 'node:fs/promises';
import { workerProgram } from './runtime/worker-program.js';
if(process.argv[2]==='request-join'){
  const [address,name,directory,...rest]=process.argv.slice(3);
  if(!address||!name||!directory||rest.length){
    process.stderr.write('Usage: loom-worker request-join <loom-url> <machine-name> <private-directory>\n');
    process.exitCode=2;
  }else{
    try{
      const {requestWorkerJoin}=await import('./runtime/worker-join.js');
      const result=await requestWorkerJoin(address,name,directory);
      process.stdout.write(JSON.stringify(result)+'\n');
      if(result.state==='blocked'||result.state==='expired')process.exitCode=1;
    }catch{
      process.stderr.write('Worker join unavailable. Check the address and private join directory before retrying.\n');
      process.exitCode=1;
    }
  }
}else process.exitCode = await workerProgram({ args: process.argv.slice(2),
  read: path => readFile(path, 'utf8'),
  on: (name, stop) => { process.on(name, stop); },
  off: (name, stop) => { process.off(name, stop); },
  error: text => { process.stderr.write(text); },
  output: text => { process.stdout.write(text); },
});
