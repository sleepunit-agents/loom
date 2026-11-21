import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { identityToRecipient } from 'age-encryption';
import { z } from 'zod';
import { agentInput, memberInput, settingsInput } from '../apps/household.js';
import { clock as systemClock } from '../core/clock.js';
import { readKey } from '../pieces/comms/crypto.js';
import { initializeSharedHome, type InitialHousehold } from '../shared-initialize.js';
import { householdId } from '../slug.js';

const member = z.object({person:householdId,role:z.enum(['owner','member']),agents:z.union([z.literal('*'),z.array(householdId)])});
const doc = z.object({
  v:z.literal(1), agents:z.array(householdId.regex(/^[a-z][a-z0-9-]{0,39}$/)).nonempty(), default:householdId.optional(),
  members:z.array(member).nonempty().optional(), owner:z.string().optional(), tz:z.string().default('UTC'),
  github:z.string().nullish(), comms_days:z.number().default(14), about:z.record(z.string(),z.string()).default({}),
  marks:z.record(z.string(),z.object({bg:z.string(),fg:z.string()})).default({}),
  faces:z.record(z.string(),z.object({shape:agentInput.shape.faceShape.optional(),eyes:agentInput.shape.faceEyes.optional()})).default({}),
});
const palette = [
  ['#B8A6FF','#1D1240'], ['#7A2E4F','#FFE3EE'], ['#2F6B5A','#E2F5EE'],
  ['#E3B341','#2B1D00'], ['#3D5A99','#E6ECFF'], ['#F09A7A','#3A140A'],
];

class PreparationError extends Error {}

function readDirectory(source:string):InitialHousehold {
  const fd=openSync(join(source,'household.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const raw=(()=>{try {
    if(!fstatSync(fd).isFile())throw Error('Expected a household document');
    return doc.parse(JSON.parse(readFileSync(fd,'utf8')));
  } finally {closeSync(fd);}})();
  const defaultAgent=raw.default??raw.agents[0];
  if(!raw.agents.includes(defaultAgent)||new Set(raw.agents).size!==raw.agents.length)throw Error('Invalid agent directory');
  const agents=raw.agents.map((id,i)=>{
    const [bg,fg]=palette[i%palette.length], mark=raw.marks[id], face=raw.faces[id];
    const about=Object.hasOwn(raw.about,id)?raw.about[id].trim():'';
    return agentInput.parse({id,about,markBg:mark?.bg??bg,markFg:mark?.fg??fg,
      faceShape:face?.shape??['pebble','trefoil','clover','drop'][i%4],faceEyes:face?.eyes??['dot','oval'][i%2]});
  });
  const oldOwner=raw.owner?.toLowerCase()??'owner';
  const implicitOwner=/^[a-z0-9]+(-[a-z0-9]+)*$/.test(oldOwner)?oldOwner:'owner';
  const members=(raw.members??[{person:implicitOwner,role:'owner',agents:'*'} as const]).map(m=>{
    if(Array.isArray(m.agents) && (m.agents.some(id=>!raw.agents.includes(id)) || (m.role==='owner' && !m.agents.length)))throw Error('Invalid agent ownership');
    return memberInput.parse({id:m.person,role:m.role,fullOwner:m.agents==='*',agents:m.agents==='*'?[]:m.agents});
  });
  if(!members.some(m=>m.fullOwner)||new Set(members.map(m=>m.id)).size!==members.length)throw Error('Invalid membership');
  const settings=settingsInput.parse({defaultAgent,timezone:raw.tz,commsDays:raw.comms_days,githubOwner:raw.github??''});
  return {defaultAgent,populate(house){
    for(const agent of agents)house.setAgent(agent);
    for(const person of members)house.setMember(person);
    house.initialize(defaultAgent);
    house.setSettings(settings);
  }};
}
function present(path:string){
  try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
export async function prepareArchiveHome(args:string[],io:{stdout(text:string):void;stderr(text:string):void}){
  const usage='loom migrate prepare --source STOPPED_ARCHIVE --home EMPTY_HOME';
  let sourceArg:string,homeArg:string;
  try{
    const {values}=parseArgs({args,options:{source:{type:'string'},home:{type:'string'}}});
    if(!values.source||!values.home)throw Error();
    sourceArg=values.source;homeArg=resolve(values.home);
  }catch{io.stderr(usage+'\n');return 2;}
  try {
    const source=realpathSync(sourceArg);
    const home=present(homeArg)?realpathSync(homeArg):join(realpathSync(dirname(homeArg)),basename(homeArg));
    const contains=(parent:string,child:string)=>{
      const path=relative(parent,child);
      return !isAbsolute(path) && path!=='..' && !path.startsWith('..'+sep);
    };
    if(contains(source,home)||contains(home,source))throw new PreparationError('The source archive and the destination must be separate directories.');
    if(present(join(home,'program.json')))throw new PreparationError('The destination already contains an installed household.');
    const household=readDirectory(source);
    const key=join(source,'comms.key');
    if(present(key)){
      household.commsIdentity=readKey(key);
      await identityToRecipient(household.commsIdentity);
    }else if(present(join(source,'comms.db')))throw new PreparationError('The archive contains Comms data and needs its original comms.key.');
    await initializeSharedHome(home,systemClock,household);
    io.stdout('Prepared the household directory and Comms key.\n');
    return 0;
  }catch(error){
    io.stderr((error instanceof PreparationError ? error.message : 'Could not prepare the household. Check the archived directory and Comms key, and use an empty destination.')+'\n');
    return 1;
  }
}
