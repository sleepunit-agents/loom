/** Bridge metadata controls in the built disposable home, without a provider. */
import {join} from 'node:path';
export async function bridgeSettingsAction({page,tile,out}){
 let phase='channel';
 try{
  const submit=async(form,label)=>{
   const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/bridges/command'&&value.request().method()==='POST',{timeout:4000});
   void response.catch(()=>{});await form.getByRole('button',{name:label,exact:true}).click();
   const result=await response,body=await result.json();
   if(result.status()!==200||body.ok!==true||body.value?.saved!==true)throw Error('Bridge setting was refused');
   await form.getByRole('status').filter({hasText:'Saved.'}).waitFor();
  };
  await tile.getByRole('button',{name:/^Channel rules/}).click();
  await tile.getByText('New channel rule',{exact:true}).click();
  const channel=tile.locator('details').filter({hasText:'New channel rule'}).locator('form');
  await channel.getByRole('combobox',{name:/^Platform/}).selectOption('discord');
  await channel.getByLabel('Server or workspace ID',{exact:true}).fill('example-discord-server');
  await channel.getByLabel('Channel ID',{exact:true}).fill('example-garden-channel');
  await channel.getByLabel('Agent answering when nobody is addressed',{exact:true}).fill('fern');
  await channel.getByLabel('Bots may talk',{exact:true}).check();
  await submit(channel,'Save channel rule');
  phase='person';await tile.getByRole('button',{name:/^Person links/}).click();
  await tile.getByText('New person link',{exact:true}).click();
  const person=tile.locator('details').filter({hasText:'New person link'}).locator('form');
  await person.getByRole('combobox',{name:/^Platform/}).selectOption('slack');
  await person.getByLabel('Server or workspace ID',{exact:true}).fill('example-slack-workspace');
  await person.getByLabel('Outside user ID',{exact:true}).fill('example-slack-user');
  await person.getByLabel('Household member ID',{exact:true}).fill('alex');
  await submit(person,'Save person link');
  phase='reload';await page.reload();await page.locator('.next-shell').waitFor();
  const persisted=page.getByRole('region',{name:'Bridges tile',exact:true});
  await persisted.getByText('alex',{exact:true}).click();
  await persisted.getByText('Outside user: example-slack-user',{exact:true}).waitFor();
  await persisted.getByText('slack · example-slack-workspace',{exact:true}).waitFor();
  await page.screenshot({path:join(out,'action-bridge-person.png'),fullPage:true});
  await persisted.getByRole('button',{name:'Back to person links',exact:true}).click();
  await persisted.getByRole('button',{name:/^Channel rules/}).click();
  await persisted.getByText('example-garden-channel',{exact:true}).click();
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
