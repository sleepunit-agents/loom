/** Household setup's portrait change without its form: the two chosen files read and checked against loom's limits,
 * and what a refusal means. No component, so the boards' household brick (web/src/boards/bricks-household-portrait.tsx)
 * imports it as the desktop's form (./portrait.tsx) does, without the desktop's kit. */
import {DOOR_REQUEST_BYTES} from '../../../../src/core/data/door-limit';
import {manifestFromPixelLab} from '../../../../src/pixellab-manifest';
import {SPRITE_MAX_BYTES} from '../../../../src/desk-sprite-layout';

export const SHEET_LIMIT_WORDS='Choose a PNG sheet up to 4 MB.',METADATA_LIMIT_WORDS='Choose PixelLab animation JSON up to 1 MB.';
/** A portrait as household.setPortrait takes it, from the two chosen files, each checked against loom's limits
 * before anything is sent. */
export async function readPortraitFiles(sheet:unknown,metadata:unknown){
  if(!(sheet instanceof File)||!sheet.size||sheet.size>SPRITE_MAX_BYTES)throw Error(SHEET_LIMIT_WORDS);
  if(!(metadata instanceof File)||!metadata.size||metadata.size>DOOR_REQUEST_BYTES)throw Error(METADATA_LIMIT_WORDS);
  const layout=manifestFromPixelLab(JSON.parse(await metadata.text()));
  const png=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(Error('Could not read the sheet.'));
    reader.readAsDataURL(sheet);
  });
  return {layout,png};
}
/** What loom's refusal (a 4xx) of a portrait change means, in the desktop's words. */
export const portraitRefusal=(status:number)=>status===409?'The portrait changed. Review the current face and choose the files again.':
  (status===401||status===403)?'Sign in as a household owner to change a portrait.':
  'Choose a valid PNG sheet up to 16 megapixels and its matching PixelLab animation JSON.';
export type PortraitInput={agent:string;version:string|null;portrait:Awaited<ReturnType<typeof readPortraitFiles>>|null};
