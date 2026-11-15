/** Storage entry for the separate shared-program holder; never opens loom.db. */
import {generateX25519Identity} from 'age-encryption';
import {randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,writeFileSync,fsyncSync,lstatSync,mkdirSync,mkdtempSync,readdirSync,renameSync,realpathSync} from 'node:fs';
import {dirname,basename,join,isAbsolute} from 'node:path';
import {assertPrivateDirectory} from './pieces/secrets/local-holder.js';
import {openHolderStore} from './pieces/secrets/holder-store.js';
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
export async function openSharedHolderStorage(directory:string){
 if(!isAbsolute(directory)||realpathSync(dirname(directory))!==dirname(directory))throw Error('Secret holder storage unavailable');
 assertPrivateDirectory(dirname(directory));
 try{lstatSync(directory);assertPrivateDirectory(directory);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;mkdirSync(directory,{mode:0o700});}
 if(!readdirSync(directory).length){
  // A crash can leave this private, unpublished key-only stage. Never adopt
  // or scan/delete similarly named directories on a later startup.
  const stage=mkdtempSync(join(dirname(directory),'.'+basename(directory)+'.initializing-'));
  const publish=(name:string,value:Uint8Array)=>{const fd=openSync(join(stage,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);value.fill(0);}};
  publish('identity',Buffer.from(await generateX25519Identity()));publish('fingerprint.key',randomBytes(32));publish('daemon-fingerprint.key',randomBytes(32));
  // Existing nonempty directories cannot be replaced. No key is regenerated
  // when a database or partial key set is already present.
  syncDirectory(stage);renameSync(stage,directory);
 }
 // Also finish a previously interrupted publication before any new DB write.
 syncDirectory(dirname(directory));
 return openHolderStore(directory,join(directory,'identity'),join(directory,'fingerprint.key'));
}
