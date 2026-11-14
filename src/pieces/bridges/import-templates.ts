/** Offline startup validation of explicitly captured shuttle template families.
 * No path lookup, execution, rendering with real values, or Runtime authority. */
export const bridgeTemplateSlots: Record<'discord'|'slack',Record<string,readonly string[]>> = {
 discord:{
  discord:['where','chan_id','chan_name','new','context','send','owner_line','notes'],
  'discord-owner':['label','id'],'discord-no-owner':[],
  'discord-guest':['cards','send','notify_chan'],'discord-peer':['peers','pair'],
  'discord-peer-bot':['label','name','note','uid'],'discord-peer-webhook':['name'],'discord-pair':['name'],
 },
 slack:{
  'slack-dm':['name','slug','tier','tier_note','card_note','cid','send','new','context'],
  'slack-tier-2':['name','role','send_discord','general'],'slack-tier-3':['name','role','send_discord','general'],
  'slack-card':['slug','card'],'slack-grant':['grant'],'slack-restrict':['restrict'],
  'slack-group':['cid','names','roster','tier','note','restricts','cards','slugs','send','new','context'],
  'slack-group-tier-2':['send_discord','general'],'slack-group-tier-3':['send_discord','general'],
  'slack-group-owner-present':[],'slack-group-restrict':['name','restrict'],
 },
};
const uses:Record<string,readonly string[]>={discord:['notes'],'discord-guest':['cards'],
 'slack-dm':['tier_note','card_note'],'slack-card':['card'],'slack-grant':['grant'],'slack-restrict':['restrict'],
 'slack-group':['note','restricts','cards'],'slack-group-restrict':['restrict']};
/** Python string.Template's ASCII identifiers and $$ escaping. Replacement
 * values are deliberately absent: captured text stays byte-for-byte evidence. */
export function bridgeTemplateReferences(text:string):string[] {
 const found:string[]=[];
 for(let i=0;i<text.length;i++){
  if(text[i]!=='$')continue;
  if(text[i+1]==='$'){i++;continue;}
  const token=/^(?:\{([a-z_][a-z_0-9]*)\}|([a-z_][a-z_0-9]*))/i.exec(text.slice(i+1));
  if(!token)throw Error('Invalid offline Bridges template syntax');
  found.push(token[1]??token[2]);i+=token[0].length;
 }
 return found;
}
export function validateBridgeTemplate(platform:'discord'|'slack',brief:string,content:string):string[] {
 const slots=Object.hasOwn(bridgeTemplateSlots[platform],brief)?bridgeTemplateSlots[platform][brief]:undefined;
 if(!slots)throw Error('Unknown offline Bridges template');
 const references=bridgeTemplateReferences(content);
 if(references.some(slot=>!slots.includes(slot))||(uses[brief]??[]).some(slot=>!references.includes(slot)))throw Error('Invalid offline Bridges template slots');
 return [...new Set(references)];
}
