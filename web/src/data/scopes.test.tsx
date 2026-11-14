import {expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Existing renderer has no declarations.
import {act,create} from 'react-test-renderer';
import {useRecordScopes,type Socket} from './index';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('shares one socket, replaces exact scopes and withdraws all snapshots on session loss',async()=>{
 const sockets:FakeSocket[]=[];
 class FakeSocket implements Socket {
  constructor(){sockets.push(this);}
  readyState=0;onopen:Socket['onopen']=null;onmessage:Socket['onmessage']=null;onclose:Socket['onclose']=null;onerror:Socket['onerror']=null;sent:Record<string,unknown>[]=[];
  send(raw:string){this.sent.push(JSON.parse(raw));}close(){this.readyState=3;this.onclose?.({code:1008});}
  set(scope:string,records:unknown[]){this.onmessage?.({data:JSON.stringify({kind:'set',type:'cards',scope,records})});}
 }
 vi.stubGlobal('location',{protocol:'https:',host:'loom.test'});vi.stubGlobal('WebSocket',FakeSocket);
 const draw=vi.fn();
 function Reader({scopes}:{scopes:string[]}){const snapshot=useRecordScopes('cards',scopes);draw(snapshot);return h('p',null,JSON.stringify(snapshot));}
 let tree:ReturnType<typeof create>;
 try{
  await act(async()=>{tree=create(h(Reader,{scopes:['one','two']}));});
  expect(sockets).toHaveLength(1);const socket=sockets[0];
  await act(async()=>{socket.readyState=1;socket.onopen?.();socket.set('one',[{id:'one',title:'PRIVATE one'}]);socket.set('two',[{id:'two',title:'PRIVATE two'}]);});
  expect(JSON.stringify(tree.toJSON())).toContain('PRIVATE one');expect(JSON.stringify(tree.toJSON())).toContain('PRIVATE two');
  const previous=draw.mock.lastCall![0];
  await act(async()=>tree.update(h(Reader,{scopes:['one','two']})));
  expect(draw.mock.lastCall![0]).toBe(previous);
  await act(async()=>tree.update(h(Reader,{scopes:['three']})));
  expect(JSON.stringify(tree.toJSON())).not.toContain('PRIVATE');
  expect(socket.sent).toEqual(expect.arrayContaining([{kind:'unsubscribe',type:'cards',scope:'one'},{kind:'unsubscribe',type:'cards',scope:'two'},{kind:'subscribe',type:'cards',scope:'three'}]));
  await act(async()=>socket.set('one',[{id:'old',title:'PRIVATE stale'}]));
  expect(JSON.stringify(tree.toJSON())).not.toContain('PRIVATE');
  await act(async()=>socket.set('three',[{id:'three',title:'PRIVATE three'}]));
  expect(JSON.stringify(tree.toJSON())).toContain('PRIVATE three');
  await act(async()=>socket.close());
  expect(JSON.stringify(tree.toJSON())).not.toContain('PRIVATE');expect(JSON.stringify(tree.toJSON())).toContain('denied');
  await act(async()=>tree.unmount());
 }finally{vi.unstubAllGlobals();}
});
