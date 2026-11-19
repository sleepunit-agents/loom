import {harnessToolPrefix} from './body-harness.js';
const server=harnessToolPrefix.slice(0,-2),formerServer='mcp__loom_secrets';
/** Whether one denial entry (harness-traits.ts, denialEntries) takes away the tool with this full name. The
 * name itself does; so does its server's name alone (`mcp__loom`: every tool of it); and `*` stands for any
 * run of characters. This errs towards yes: an entry that narrows a tool to some inputs (`tool(...)`) counts
 * as the whole tool. Saying yes too often only denies a tool that might have been allowed. */
export function denialCoversTool(entry:string,tool:string):boolean{
 const pattern=entry.replace(/\([^]*$/,'').trim();
 if(pattern===tool||tool.startsWith(pattern+'__')&&(pattern===server||pattern===formerServer))return true;
 if(!pattern.includes('*'))return false;
 return new RegExp('^'+pattern.split('*').map(part=>part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(tool);
}
