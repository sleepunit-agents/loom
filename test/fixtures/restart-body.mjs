import {bodyCommandClient} from '../../src/runtime/body-command-client.ts';
let bytes = '';
for await (const chunk of process.stdin) bytes += chunk;
const startup = JSON.parse(bytes);
const client = bodyCommandClient({url:startup.origin, token:startup.token, signal:new AbortController().signal});
process.send('working');
process.once('message', async () => {
  try {
    const answer = await client.command('conversation.message',
      {kind:'reply', words:'Finished the fixture tool', clientId:'reply', model:'fixture'}, 'reply-receipt');
    if (!answer.ok) throw Error('Body reply refused');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally { client.close(); process.disconnect(); }
});
