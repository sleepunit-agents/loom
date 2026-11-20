import { expect, it } from 'vitest';
import { decisionLink, type Ask } from '../../web/src/pieces/attention/model';
import { taskId, taskSegment } from '../../web/src/pieces/tasks/route';
it.each(['t-1','~t-1','.','..','a/b','',':d800','~:d800','\ud800','\ud801','\ufffd'])('opens exact imported source task %j through its canonical route',id=>{
 const ask:Ask={id:'source',ask:'Source task',source:{kind:'task',id},state:'open',createdAt:0,changedAt:0};
 const link=decisionLink(ask)!;
 expect(link.path).toBe(`/p/tasks-preview/task/${taskSegment(id)}`);
 expect(taskId(new URL(link.path,'https://fixture.test').pathname)).toBe(id);
});
it('preserves generated and existing canonical imported task segments and refuses malformed encodings',()=>{
 expect(taskSegment('t-1')).toBe('t-1');expect(taskSegment('~t-1')).toBe('~~t-1');
 expect(taskSegment('.')).toBe('~.');expect(taskSegment(':d800')).toBe('~%3Ad800');
 expect(taskId('/task/~:d80')).toBeUndefined();expect(taskId('/task/~:zzzz')).toBeUndefined();
});
