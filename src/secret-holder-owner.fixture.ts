import {EventEmitter} from 'node:events';
import type {HolderOwnerChannel} from './secret-holder-owner.js';
export class Channel extends EventEmitter implements HolderOwnerChannel {
  connected=true;
  peer!:Channel;
  messages:unknown[]=[];
  drop=false;
  send(value:unknown,callback:(error:Error|null)=>void) {
    const snapshot=structuredClone(value);this.messages.push(snapshot);
    queueMicrotask(()=>{
      if(!this.connected){callback(new Error('gone'));return;}
      if(!this.drop)this.peer.emit('message',snapshot);
      callback(null);
    });return true;
  }
  disconnect(){if(!this.connected)return;this.connected=this.peer.connected=false;queueMicrotask(()=>{this.emit('disconnect');this.peer.emit('disconnect');});}
}
export function pair(){const parent=new Channel(),child=new Channel();parent.peer=child;child.peer=parent;return {parent,child};}
