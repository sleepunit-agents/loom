import {randomUUID} from 'node:crypto';
import {closeSync,constants,fchmodSync,fstatSync,linkSync,lstatSync,mkdirSync,openSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {WorkerStop} from './worker-stop.js';
import {BODY_PROGRAM_TARGET,HOUSE_CLI_FILE,houseCliSource,plainPath} from './worker-mounts.js';

const script = `#!/bin/sh\nexec ${BODY_PROGRAM_TARGET}/${HOUSE_CLI_FILE} "$@"\n`;

function checkExisting(path:string): void {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.uid!==process.getuid?.() || (stat.mode & 0o7777)!==0o555 ||
        stat.size!==Buffer.byteLength(script) || readFileSync(fd,'utf8')!==script) throw new WorkerStop('state');
  } finally {closeSync(fd);}
}

export function prepareHouseCli(state: string): void {
  // A bind source stays a pathname until the engine mounts it. Check each parent
  // before entering it. Sticky shared roots (such as /tmp) protect our owned child.
  if (!plainPath(state)) throw new WorkerStop('state');
  const uid=process.getuid?.();
  let directory='/';
  for (const component of state.slice(1).split('/')) {
    directory=join(directory,component);
    if (!lstatSync(directory,{throwIfNoEntry:false})) {
      try {mkdirSync(directory,{mode:0o700});} catch (error) {
        if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
      }
    }
    const info=lstatSync(directory);
    if (!info.isDirectory() || (info.uid!==0 && info.uid!==uid) ||
        ((info.mode & 0o022)!==0 && (info.mode & 0o1000)===0) ||
        (directory===state && (info.uid!==uid || (info.mode & 0o077)!==0))) throw new WorkerStop('state');
  }
  const dest=houseCliSource(state);
  if (lstatSync(dest,{throwIfNoEntry:false})) return checkExisting(dest);
  const temp=join(state,'cli-'+randomUUID());
  const fd=openSync(temp,'wx',0o600);
  try {
    writeFileSync(fd,script);
    fchmodSync(fd,0o555);
    try {linkSync(temp,dest);} catch (error) {
      if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
      checkExisting(dest);
    }
  } finally {closeSync(fd);rmSync(temp,{force:true});}
}
