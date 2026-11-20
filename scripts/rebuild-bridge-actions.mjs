/** Bridge metadata controls in the built disposable home, without a provider. */
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {approveRequestedChange} from './rebuild-access-actions.mjs';
export async function bridgeSettingsAction({page,tile,out,app}){
 let phase='channel';
 try{
  const db=app.services.comms.db.$client;
  const submit=async(form,label,input,exists)=>{
   const button=form.getByRole('button',{name:label,exact:true});
   await button.focus();await button.press('Enter');
   await approveRequestedChange({page,app,composer:tile.getByRole('region',{name:'Bridge change request'}),change:'bridge',input,exists,
    expectedWords:words=>isDeepStrictEqual(JSON.parse(words.slice(words.indexOf('{'))),input)});
   const folder=input.action==='channel'?'channels':'people';
   await page.goto(new URL('/p/bridges-preview/'+folder,app.url).href);
   await tile.waitFor();
  };
  await tile.getByRole('button',{name:/^Channel rules/}).click();
  await tile.getByRole('button',{name:'New channel rule',exact:true}).click();
  const channel=tile.locator('article').filter({has:page.getByRole('heading',{name:'New channel rule',exact:true})}).locator('form');
  await channel.getByRole('combobox',{name:/^Platform/}).selectOption('discord');
  await channel.getByLabel('Server or workspace ID',{exact:true}).fill('example-discord-server');
  await channel.getByLabel('Channel ID',{exact:true}).fill('example-garden-channel');
  await channel.getByRole('combobox',{name:/^Agent answering when nobody is addressed/}).selectOption('fern');
  await channel.getByLabel('Bots may talk',{exact:true}).check();
  await submit(channel,'Review channel rule',{action:'channel',platform:'discord',workspace:'example-discord-server',channel:'example-garden-channel',answers:'fern',botsMayTalk:true},
   ()=>db.prepare('SELECT channel FROM bridge_channels WHERE platform=? AND workspace=? AND channel=?').get('discord','example-discord-server','example-garden-channel'));
  phase='person';await tile.getByRole('button',{name:/^Person links/}).click();
  await tile.getByRole('button',{name:'New person link',exact:true}).click();
  const person=tile.locator('article').filter({has:page.getByRole('heading',{name:'New person link',exact:true})}).locator('form');
  await person.getByRole('combobox',{name:/^Platform/}).selectOption('slack');
  await person.getByLabel('Server or workspace ID',{exact:true}).fill('example-slack-workspace');
  await person.getByLabel('Outside user ID',{exact:true}).fill('example-slack-user');
  await person.getByLabel('Household member ID',{exact:true}).fill('alex');
  await submit(person,'Review person link',{action:'person',platform:'slack',workspace:'example-slack-workspace',user:'example-slack-user',member:'alex'},
   ()=>db.prepare('SELECT user FROM bridge_people WHERE platform=? AND workspace=? AND user=?').get('slack','example-slack-workspace','example-slack-user'));
  phase='reload';await page.reload();await page.locator('.next-shell').waitFor();
  const persisted=page.getByRole('region',{name:'Bridges tile',exact:true});
  await persisted.getByRole('button',{name:/^Person links/}).click();
  await persisted.locator('[data-split-row]').filter({hasText:'example-slack-user'}).click();
  await persisted.getByText('Outside user: example-slack-user',{exact:true}).waitFor();
  await persisted.getByText('slack · example-slack-workspace',{exact:true}).waitFor();
  await page.screenshot({path:join(out,'action-bridge-person.png'),fullPage:true});
  const back=persisted.getByRole('button',{name:'Back to person links',exact:true});
  if(await back.isVisible())await back.click();
  await persisted.getByRole('button',{name:/^Channel rules/}).click();
  await persisted.locator('[data-split-row]').filter({hasText:'example-garden-channel'}).click();
  await persisted.getByText('Answers when nobody is addressed: fern',{exact:true}).waitFor();
  await persisted.getByText('Bots may talk: Yes',{exact:true}).waitFor();
  await persisted.getByRole('region',{name:'Bridges: the open item',exact:true}).getByText('discord · example-discord-server',{exact:true}).waitFor();
  const screenshot='action-bridge-channel.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  return {ok:true,discordChannel:true,slackPerson:true,persistedAfterReload:true,screenshot};
 }catch(error){
  const screenshot='action-bridge-settings-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error),screenshot};
 }
}
