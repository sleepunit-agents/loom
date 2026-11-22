import {join} from 'node:path';
import {browserRead} from './rebuild-conversation-visibility.mjs';

export async function machineRoster({page,tile,example,out}) {
 const {boxes}=await browserRead(page,'{ boxes { id name owner lastSeenAt hostsAny reportOnly boxAgentsByBox { agent } } }');
 const box=boxes.find(row=>row.id===example.runtime.box);
 if(!box?.lastSeenAt)return {inconclusive:true,reason:'The example worker had no recorded heartbeat.'};
 const screenshot='action-machine-roster.png';
 const card=tile.locator('article').filter({has:page.getByRole('button',{name:box.name,exact:true})});
 const agents=box.boxAgentsByBox.map(row=>row.agent).sort();
 const matches=box.owner==='alex'&&!box.hostsAny&&!box.reportOnly&&agents.join(',')==='fern,moss';
 await card.waitFor();
 const entries=await card.locator('dl dt').evaluateAll(terms=>Object.fromEntries(terms.map(term=>[term.textContent,term.nextElementSibling?.textContent])));
 await card.screenshot({path:join(out,screenshot)});
 if(!matches||entries.Owner!==box.owner||entries.Hosting!=='Listed agents only'||
    entries['Listed agents']?.split(', ').sort().join(',')!==agents.join(','))
  return {ok:false,error:'Machine registration, recorded roster and visible card did not agree.',screenshot};
 return {ok:true,reason:'The reporting worker’s registered owner and both listed agents matched its machine card.',owner:box.owner,agents,screenshot};
}
