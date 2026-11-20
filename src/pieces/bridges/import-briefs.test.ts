import {expect,it} from 'vitest';
import {channelBriefOrder} from './import-briefs.js';
it('keeps Python insertion order for numeric/escaped keys and last duplicate maps without reading nested/string punctuation',()=>{
 expect(channelBriefOrder('{"other":{"channel_notes":{"wrong":"x"}},"channel_notes":{"10":"}\\\"", "\\u0032":"two", "10":"last", "_note":"skip", "🐟":"x"}}')).toEqual(['10','2','🐟']);
 expect(channelBriefOrder('{"channel_notes":{"old":"a"},"channel_notes":{"3":"c","1":"a"}}')).toEqual(['3','1']);
 expect(channelBriefOrder('{"channel_notes":{"old":"a"},"channel_notes":{}}')).toEqual([]);
});
