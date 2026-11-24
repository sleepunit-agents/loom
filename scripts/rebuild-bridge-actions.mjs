/** Bridge metadata controls in the built disposable home, without a provider. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {holderValueEquals} from './rebuild-secret-holder.mjs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {approveRequestedChange} from './rebuild-access-actions.mjs';
const proposedInput=words=>JSON.parse(words.slice(words.indexOf('{')));
export async function bridgeSettingsAction({page,tile,out,app,home}){
 let phase='connection';
 try{
  const db=app.services.comms.db.$client;
  assert.equal(app.services.bridges.daemon,undefined,"Bridge settings walkthrough requires an offline provider fixture");
  const submit=async(form,label,input,exists)=>{
   const button=form.getByRole('button',{name:label,exact:true});
   await button.click();
   const composer=tile.getByRole('region',{name:'Bridge change request'});
   if(input.action==='connection'){
    const words=await composer.getByRole('textbox',{name:/^Message\b/}).inputValue();
    const {id}=proposedInput(words);
    assert.match(id,/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    input={...input,id};
   }
   await approveRequestedChange({page,app,composer,change:'bridge',input,exists,
    expectedWords:words=>isDeepStrictEqual(proposedInput(words),input)});
   const folder={connection:'connections',channel:'channels',person:'people'}[input.action];
   await page.goto(new URL('/p/bridges-preview/'+folder,app.url).href);
   await tile.waitFor();
  };
  const tokenName='WALKTHROUGH_BRIDGE_BOT', fixtureValue='fictional-garden-bot-value';
  await app.services.secrets.values.set({member:'alex',id:randomUUID(),name:tokenName,
   description:'Fictional garden bot',value:fixtureValue,mode:'add'});
  assert.ok(await holderValueEquals(home,tokenName,fixtureValue));
  await tile.getByRole('button',{name:/^Connections/}).click();
  await tile.getByRole('button',{name:'New connection',exact:true}).click();
  const form=tile.locator('article').filter({has:page.getByRole('heading',{name:'New connection',exact:true})}).locator('form');
  await form.getByLabel('Server or workspace ID',{exact:true}).fill('garden-bot-workspace');
  await form.getByRole('combobox',{name:/^Agent ID/}).selectOption('fern');
  await form.getByLabel('Bot user ID',{exact:true}).fill('garden-bot');
  await form.getByLabel('Bot token secret name',{exact:true}).fill(tokenName);
  await form.getByLabel('Enabled',{exact:true}).uncheck();
  await submit(form,'Review connection',{action:'connection',platform:'discord',workspace:'garden-bot-workspace',
   agent:'fern',botUser:'garden-bot',tokenSecret:tokenName,appSecret:null,enabled:false,only:[],ignore:[]},
   ()=>db.prepare('SELECT id FROM bridge_connections WHERE workspace=?').get('garden-bot-workspace'));
  await page.reload();
  await tile.locator('[data-split-row]').filter({hasText:'garden-bot-workspace'}).click();
  await tile.getByText('Bot token: '+tokenName,{exact:true}).waitFor();
  assert.equal(await tile.getByLabel('Bot token secret name',{exact:true}).inputValue(),tokenName);
  assert.ok(!(await tile.innerText()).includes(fixtureValue));
  assert.deepEqual(db.prepare('SELECT agent,bot_user,token_secret,enabled FROM bridge_connections WHERE workspace=?').get('garden-bot-workspace'),
   {agent:'fern',bot_user:'garden-bot',token_secret:tokenName,enabled:0});
  const backToList=tile.getByRole('button',{name:'Back to connections',exact:true});
  if(await backToList.isVisible())await backToList.click();
  phase='channel';
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
  await persisted.getByRole('region',{name:'Bridges: the open item',exact:true}).getByRole('heading',{name:'alex',exact:true}).waitFor();
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
  return {ok:true,discordConnection:true,storedSecretName:true,discordChannel:true,slackPerson:true,persistedAfterReload:true,screenshot};
 }catch(error){
  const screenshot='action-bridge-settings-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,phase,error:String(error),screenshot};
 }
}
