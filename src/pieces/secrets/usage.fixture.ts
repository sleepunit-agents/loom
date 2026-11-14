/** In-process fixture evidence shared by the installed service consumers. */
import {once} from 'node:events';
import {inspect} from 'node:util';
import {WebSocket} from 'ws';
import {expect} from 'vitest';
import type {Foundation} from '../../core/app.js';
import type {SecretUsage} from './usage.js';

export const secretUsageEvents=(app:Foundation)=>(app.db.prepare('SELECT record FROM secrets_uses').all() as {record:string}[]).map(row=>JSON.parse(row.record) as SecretUsage);
export async function watchSecretUsage(url:string) {
  const frames:unknown[]=[];
  const socket=new WebSocket(url.replace('http:','ws:')+'/live',{headers:{authorization:'usage-fixture-owner'}});
  const initial=new Promise<void>(resolve=>socket.on('message',data=>{
    const frame=JSON.parse(String(data));frames.push(frame);
    if(frame.kind==='set'&&frame.type==='secret.use')resolve();
  }));
  await once(socket,'open');socket.send(JSON.stringify({kind:'subscribe',type:'secret.use'}));await initial;
  const current=()=>{
    const records=new Map<string,SecretUsage>();
    for(const frame of frames as Array<{kind:string;records?:SecretUsage[];record?:SecretUsage}>) {
      if(frame.kind==='set'){records.clear();for(const record of frame.records??[])records.set(record.id,record);}
      if(frame.kind==='put'&&frame.record)records.set(frame.record.id,frame.record);
    }
    return [...records.values()].sort((a,b)=>a.id.localeCompare(b.id));
  };
  return {frames,async synced(events:SecretUsage[]){
    const wanted=JSON.stringify(events.slice().sort((a,b)=>a.id.localeCompare(b.id)).map(({id,state})=>({id,state})));
    while(JSON.stringify(current().map(({id,state})=>({id,state})))!==wanted)await once(socket,'message');
  },async close(){if(socket.readyState===WebSocket.CLOSED)return;const closed=once(socket,'close');socket.terminate();await closed;}};
}
export function assertSecretUsagePrivate(app:Foundation,frames:unknown[],published:unknown[],diagnostics:unknown[],buffers:Uint8Array[]) {
  const tables=app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
  const dump=tables.map(t=>app.db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all());
  for(const value of ['PRIVATE-bot','PRIVATE-app'])expect(inspect([dump,frames,published,diagnostics],{depth:null})).not.toContain(value);
  expect(buffers.every(b=>b.every(byte=>byte===0))).toBe(true);
}
