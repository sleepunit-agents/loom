import { expect,it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Database from 'better-sqlite3';
import { createDataSchema } from '../../../../src/core/data/database';
import { FakeClock } from '../../../../src/core/clock';
import { tempoSettingsService } from '../../../../src/core/tempo/settings';
import { readTempoChange,renderTempoChange } from './settings';
it('shows the actual prepared Tempo card before and after without applying it',()=>{
 const client=new Database(':memory:'),db=createDataSchema(client),clock=new FakeClock(),service=tempoSettingsService(db,clock),who={kind:'person' as const,id:'sam'};
 try{
  const card=service.prepare(who,{settleSeconds:60,dimDays:2,muteDays:3});
  expect(readTempoChange(card)).toEqual({who,before:{settleSeconds:5,dimDays:1,muteDays:7},after:{settleSeconds:60,dimDays:2,muteDays:3}});
  const text=renderToStaticMarkup(renderTempoChange(card));
  for(const words of ['Tempo settings change','Before','After','5 seconds','60 seconds','1 day','2 days','7 days','3 days','Deny keeps'])expect(text).toContain(words);
  expect(service.read(who)).toEqual({settleSeconds:5,dimDays:1,muteDays:7});
  for(const bad of [{...card,kind:'command'},{...card,target:'tempo:person:other'},{...card,changeSummary:'Altered'},{...card,details:'invalid'},{...card,details:JSON.stringify({who,before:{settleSeconds:5,dimDays:1,muteDays:7},after:{settleSeconds:60,dimDays:2,muteDays:0}})}])expect(renderTempoChange(bad)).toBeNull();
 }finally{client.close();}
});
