/** Explicit offline snapshot documents. Never follows a configured legacy path. */
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
export const bridgeDocumentLimits={count:128,bytes:1024*1024,total:8*1024*1024};
export const bridgeDocumentPath=(name:string):boolean=>/^bridges-documents\/[0-9]+\.md$/.test(name);
export interface BridgeDocumentFile {name:string;path:string}
export function readBridgeDocuments(files:readonly BridgeDocumentFile[]) {
 try {
  if(files.length>bridgeDocumentLimits.count||new Set(files.map(f=>f.name)).size!==files.length||new Set(files.map(f=>f.path)).size!==files.length)throw Error();
  let total=0;
  return [...files].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(file=>{
   if(!bridgeDocumentPath(file.name))throw Error();
   const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   let bytes:Buffer;
   try{
    const stat=fstatSync(fd);total+=stat.size;if(!stat.isFile()||stat.size>bridgeDocumentLimits.bytes||total>bridgeDocumentLimits.total)throw Error();
    const buffer=Buffer.alloc(bridgeDocumentLimits.bytes+1);let length=0,count:number;
    do{count=readSync(fd,buffer,length,buffer.length-length,null);length+=count;}while(count&&length<buffer.length);
    if(length!==stat.size||length>bridgeDocumentLimits.bytes)throw Error();bytes=buffer.subarray(0,length);
   }finally{closeSync(fd);}
   const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
   return {name:file.name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,content};
  });
 }catch{throw Error('Invalid offline Bridges selected documents');}
}
