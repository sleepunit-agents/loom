import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AgentPostFeed, AgentPostHistory } from './agent-posts';

const now = Date.parse('2026-11-22T11:03:00Z');
const boot = { id: '1', at: '2026-11-22T11:00:00Z', words: 'Giving boot a console.' };
const disk = { id: '2', at: '2026-11-22T11:01:00Z', words: 'What filled the disk?' };
const reply = { id: '3', at: '2026-11-22T11:02:00Z', words: 'The console moves now.' };
const threads = [
  { thread: 'boot', title: 'LOOM//OS boot', latest: reply, parent: boot },
  { thread: 'disk', title: 'Where did the disk go?', latest: disk, parent: null },
];
it('keeps the returning activity and its reply context on the rail', () => {
  const html = renderToStaticMarkup(h(AgentPostFeed, { threads, compact: true, open() {}, now }));
  expect(html).toContain(boot.words);
  expect(html).toContain(reply.words);
  expect(html).toContain('1m ago');
  expect(html).not.toContain(disk.words);
});
it('shows both activities on the card and the selected thread in reading order', () => {
  const html = renderToStaticMarkup(h(AgentPostFeed, { threads, open() {}, now }));
  expect(html.indexOf(reply.words)).toBeLessThan(html.indexOf(disk.words));
  const history = renderToStaticMarkup(h(AgentPostHistory, { title: 'Boot console', posts: [boot, reply], now }));
  expect(history).toContain('Boot console');
  expect(history.indexOf(boot.words)).toBeLessThan(history.indexOf(reply.words));
  expect(history).not.toContain(disk.words);
});

it('shows the confirmed work link beside the update and keeps the rail compact', () => {
  const work = [{id:'t-17',title:'Fix disk cleanup',state:'closed',href:'/p/tasks-preview/task/t-17'}];
  const latest = {...reply,work};
  const rows = [{...threads[0],latest}];
  const feed = renderToStaticMarkup(h(AgentPostFeed,{threads:rows,open(){},now}));
  const history = renderToStaticMarkup(h(AgentPostHistory,{title:'Disk',posts:[latest],now}));
  for (const view of [feed,history]) {
    expect(view).toContain('Fix disk cleanup · closed');
    expect(view).toContain('href="/p/tasks-preview/task/t-17"');
  }
  expect(renderToStaticMarkup(h(AgentPostFeed,{threads:rows,compact:true,open(){},now}))).not.toContain('Fix disk cleanup');
});
