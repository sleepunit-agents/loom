import {expect,it} from 'vitest';
import {bridgeTemplateReferences,validateBridgeTemplate} from './import-templates.js';
import families from './__fixtures__/template-families.json' with {type:'json'};
it('checks all pinned Discord and Slack startup templates with their exact provided slots',()=>{
 expect(Object.keys(families.discord)).toHaveLength(8);expect(Object.keys(families.slack)).toHaveLength(11);
 for(const platform of ['discord','slack'] as const)for(const [brief,text] of Object.entries(families[platform]))expect(()=>validateBridgeTemplate(platform,brief,text)).not.toThrow();
});
it('recognizes Python ASCII identifiers, braces, escapes and repeated substitutions without touching text',()=>{
 expect(bridgeTemplateReferences('$new ${context} $$notes $$$cards $new ${NEW}')).toEqual(['new','context','cards','new','NEW']);
 for(const text of ['$','$5','$ name','${}','${notes','${notes.x}','$é','$魚','${a-b}'])expect(()=>bridgeTemplateReferences(text)).toThrow('syntax');
 expect(bridgeTemplateReferences('$$5 $$$$ ${_x9}')).toEqual(['_x9']);
});
it('refuses unknown and case-mismatched slots and required uses hidden by escaping',()=>{
 for(const text of ['$conext $notes','$Notes','$$notes','notes','${notes} $cards'])expect(()=>validateBridgeTemplate('discord','discord',text)).toThrow('slots');
 expect(validateBridgeTemplate('discord','discord','${notes} $$cards')).toEqual(['notes']);
 expect(()=>validateBridgeTemplate('discord','toString','')).toThrow('Unknown');
 expect(()=>validateBridgeTemplate('slack','discord','$notes')).toThrow('Unknown');
});
it('requires every pinned rule/card/restriction-bearing slot individually',()=>{
 for(const [platform,brief,required] of [
  ['discord','discord',['notes']],['discord','discord-guest',['cards']],
  ['slack','slack-dm',['tier_note','card_note']],['slack','slack-card',['card']],
  ['slack','slack-grant',['grant']],['slack','slack-restrict',['restrict']],
  ['slack','slack-group',['note','restricts','cards']],['slack','slack-group-restrict',['restrict']],
 ] as const){
  for(const missing of required){
   const text=required.map(slot=>slot===missing?`$$${slot}`:`$${slot}`).join(' ');
   expect(()=>validateBridgeTemplate(platform,brief,text)).toThrow('slots');
  }
 }
});
it('retains unique references in first-use order, excluding escaped occurrences',()=>{
 expect(validateBridgeTemplate('discord','discord','$new $$notes ${context} $notes $new ${notes} $where $context')).toEqual(['new','context','notes','where']);
});
