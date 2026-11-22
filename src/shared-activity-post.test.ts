import { afterEach, expect, it } from 'vitest';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { bodyProgramTools } from './runtime/body-program-tools.js';
import { agentPosts, inbox, messages } from './core/data/schema.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });

it('posts, resumes and renames activities through the body MCP tool and reads them on the member desk', async () => {
  const f = await bodyFixture(clean);
  const tools = bodyProgramTools({
    url:'https://loom.invalid', token:bodyCredentials.body, clock:f.clock, signal:new AbortController().signal,
    fetch:async (url,init) => f.root.http.request(new Request(String(url),init)), onStop() {}, onStatus() {},
  });
  clean.push(() => tools.close());
  const post = async (id:string,input:Record<string,unknown>) => {
    const result = await tools.call('loom_command',{operation:'conversation.activityPost',id,input});
    expect(result.isError,result.content[0].text).not.toBe(true);
    return JSON.parse(result.content[0].text).value.thread as string;
  };
  const opening = {action:'open',words:'Making boot scroll.'};
  const boot = await post('start-boot',opening);
  expect(await post('start-boot',opening)).toBe(boot);
  const disk = await post('start-disk',{action:'open',words:'What filled the disk?'});
  await post('found-it',{action:'reply',thread:disk,words:'It was my test homes.'});
  await post('rename',{action:'rename',thread:disk,title:'The test homes'});
  await post('resume',{action:'reply',thread:boot,words:'It scrolls!'});
  expect(f.db.select().from(agentPosts).all()).toHaveLength(4);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(f.db.select().from(messages).all()).toEqual([]);
  const response = await f.root.http.request('/graphql',{method:'POST', headers:{'content-type':'application/json',
    cookie:'loom_ui='+bodyCredentials.memberCookie},body:JSON.stringify({query:`{
      agentActivityFeed(agent:"art"){thread title latest{words source} parent{words}}
    }`})});
  expect(await response.json()).toEqual({data:{agentActivityFeed:[
    {thread:boot,title:opening.words,latest:{words:'It scrolls!',source:f.thread.id},parent:{words:opening.words}},
    {thread:disk,title:'The test homes',latest:{words:'It was my test homes.',source:f.thread.id},parent:{words:'What filled the disk?'}},
  ]}});
});
