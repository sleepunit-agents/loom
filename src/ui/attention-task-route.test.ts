import { expect, it } from 'vitest';
import { inboxSourcePath } from '../../web/src/pieces/attention/inbox-query';
import type { InboxItem } from '../../web/src/pieces/inbox-view/model';
import { taskId, taskSegment } from '../task-route.js';
const item=(sourceId:string):InboxItem=>({id:'source',source:'task',sourceId,at:'2026-11-14T00:00:00Z',state:'waiting',volume:'full',read:true,refs:[],body:{words:'Source task'}});
it.each(['t-1','~t-1','.','..','a/b',':d800','~:d800','\ud800','\ud801','\ufffd'])('opens exact imported source task %j through its canonical route',id=>{
 const path=inboxSourcePath(item(id))!;
 expect(path).toBe(`/p/work/backlog/task/${taskSegment(id)}`);
 expect(taskId(new URL(path,'https://fixture.test').pathname)).toBe(id);
});
it('offers no route for an item whose source names no task',()=>{expect(inboxSourcePath(item(''))).toBeUndefined();});
it('preserves generated and existing canonical imported task segments and refuses malformed encodings',()=>{
 expect(taskSegment('t-1')).toBe('t-1');expect(taskSegment('~t-1')).toBe('~~t-1');
 expect(taskSegment('.')).toBe('~.');expect(taskSegment(':d800')).toBe('~%3Ad800');
 expect(taskId('/task/~:d80')).toBeUndefined();expect(taskId('/task/~:zzzz')).toBeUndefined();
});
