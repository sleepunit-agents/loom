/** Explicit snapshot path classification; no configured path is ever opened. */
import { basename } from 'node:path';
import type { BridgeImportSources } from '../pieces/bridges/import-plan.js';
export function bridgeMigrationSources(paths:{name:string;path:string}[]):BridgeImportSources{
  const result:BridgeImportSources={files:[],stores:[]};
  for(const f of paths){
    const leaf=basename(f.name);
    if(leaf==='shuttle.db'||leaf==='runtime.db')result.stores.push({...f,kind:leaf==='shuttle.db'?'shuttle':'runtime'});
    else{
      const kind=leaf==='shuttle.json'?'shuttle':leaf==='people.json'?'people':leaf==='routes.json'?'routes':f.name.endsWith('/discord/settings.json')?'discord-settings':f.name.endsWith('/slack/settings.json')?'slack-settings':undefined;
      if(!kind)throw Error('Unknown Bridges snapshot source');result.files.push({...f,kind});
    }
  }
  return result;
}
export const bridgeSourcePath=(p:string)=>/(?:^|\/)(?:shuttle|people|routes)\.json$/.test(p)||/\/pieces\/(?:discord|slack)\/settings\.json$/.test(p)||p==='home/commons/stores/shuttle.db'||p==='home/commons/stores/runtime.db';
