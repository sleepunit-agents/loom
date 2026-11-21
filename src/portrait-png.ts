import {PNG} from 'pngjs';
import {inflateSync} from 'node:zlib';
import {OperationError} from './core/operations/index.js';
import {SPRITE_MAX_BYTES} from './desk-sprite-layout.js';

const maxSide=16384;
const maxPixels=16*1024*1024;
const invalid=()=>new OperationError('invalid','Choose a complete PNG sheet up to 4 MB and 16 megapixels');
/** Check the complete file before replacing a working portrait. Bound the image
 * size before decoding, including the interlaced decoder's inflation. */
export function portraitPng(encoded:string){
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length<33||bytes.length>SPRITE_MAX_BYTES||bytes.toString('base64')!==encoded||
    bytes.readUInt32BE(8)!==13||bytes.toString('latin1',12,16)!=='IHDR')throw invalid();
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width>maxSide||height>maxSide)throw new OperationError('invalid',`Use a PNG no wider or taller than ${maxSide} pixels`);
  if(!width||!height||width*height>maxPixels)throw invalid();
  let ended=false;
  const interlaced=bytes[28]===1,compressed:Buffer[]=[];
  for(let pos=8;pos+12<=bytes.length;){
    const size=bytes.readUInt32BE(pos),end=pos+size+12;
    const type=bytes.toString('latin1',pos+4,pos+8);
    if(end>bytes.length||(pos!==8&&type==='IHDR'))throw invalid();
    if(interlaced&&type==='IDAT')compressed.push(bytes.subarray(pos+8,end-4));
    if(type==='IEND'){ended=end===bytes.length&&size===0;break;}
    pos=end;
  }
  if(!ended)throw invalid();
  try{
    if(interlaced)inflateSync(Buffer.concat(compressed),{maxOutputLength:width*height*8+7*height});
    PNG.sync.read(bytes);
  }catch{throw invalid();}
  return {bytes,width,height};
}
