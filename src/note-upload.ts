import {z} from 'zod';
import {FILE_NAME,MAX_FILE_BYTES,NOTE_PATH,NOTE_PATH_MAX} from './notes.js';

const metadata=z.object({path:z.string().max(NOTE_PATH_MAX).regex(NOTE_PATH),name:z.string().regex(FILE_NAME),
  type:z.string().min(1).max(255).optional()}).strict();
export const noteUploadInput=metadata.extend({contents:z.base64().max(4*Math.ceil(MAX_FILE_BYTES/3))});
const fields=z.object({input:metadata,id:z.string().min(1).max(200)}).strict();
/** Multipart headers, the receipt ID, and bounded note metadata accompany one file. */
export const NOTE_UPLOAD_REQUEST_BYTES=MAX_FILE_BYTES+16*1024;

export function noteUploadForm(input:unknown,id:string):FormData {
  const {contents,...note}=noteUploadInput.parse(input);
  const bytes=Buffer.from(contents,'base64');
  try{
    if(bytes.length>MAX_FILE_BYTES)throw Error('Attachment too large');
    const form=new FormData();
    form.set('metadata',JSON.stringify(fields.parse({input:note,id})));
    form.set('file',new Blob([bytes]),'attachment');
    return form;
  }finally{bytes.fill(0);}
}

export async function noteUploadEnvelope(form:FormData){
  const meta=form.get('metadata'),file=form.get('file');
  if([...form.keys()].length!==2||typeof meta!=='string'||!(file instanceof Blob)||file.size>MAX_FILE_BYTES)throw Error('Invalid attachment');
  const {input,id}=fields.parse(JSON.parse(meta));
  const bytes=Buffer.from(await file.arrayBuffer());
  try{return {id,input:{...input,contents:bytes.toString('base64')}};}finally{bytes.fill(0);}
}
