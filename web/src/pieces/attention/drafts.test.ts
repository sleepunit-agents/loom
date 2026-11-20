import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer has no declaration package.
import { act, create } from 'react-test-renderer';
import { draftKey, useReplyDraft, type ReplyDraft } from './drafts';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create> | undefined, editor: ReplyDraft;
let data: Map<string,string>, events: EventTarget;
function Editor({ member = 'alice', ask = 'one' }: {member?:string;ask?:string}) { editor = useReplyDraft(member,ask); return h('textarea',{value:editor.value.text}); }
async function mount(member = 'alice', ask = 'one') { await act(async()=>{tree=create(h(Editor,{member,ask}));}); }
async function unmount() { await act(async()=>tree?.unmount()); tree=undefined; }
async function edit(text:string) { await act(async()=>editor.edit(text)); }
beforeEach(()=>{
  data=new Map();events=new EventTarget();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)});
  vi.stubGlobal('window',events);
});
afterEach(async()=>{await unmount();vi.unstubAllGlobals();});
it('restores navigation/reload drafts and isolates members and asks, including separator-shaped ids',async()=>{
  await mount();await edit('Keep these words');const version=editor.value.version;
  await unmount();await mount('bob');expect(editor.value.text).toBe('');await edit('Bob words');
  await unmount();await mount('alice','two');expect(editor.value.text).toBe('');
  await unmount();await mount();expect(editor.value).toEqual({text:'Keep these words',version});
  expect(draftKey('a:b','c')).not.toBe(draftKey('a','b:c'));
});
it('acknowledges only the sent version, preserving newer same-text and other-window edits',async()=>{
  await mount();await edit('First');const sent=editor.value;
  await edit('Second');await act(async()=>editor.acknowledged(sent));expect(editor.value.text).toBe('Second');
  await edit('First');await act(async()=>editor.acknowledged(sent));expect(data.has(draftKey('alice','one'))).toBe(true);
  const sentAgain=editor.value;
  data.set(draftKey('alice','one'),'aaaaaaaaaaaaaaaa');
  data.set(`${draftKey('alice','one')}:aaaaaaaaaaaaaaaa`,'Other window');
  await act(async()=>editor.acknowledged(sentAgain));
  expect(editor.value.text).toBe('Other window');expect(data.get(`${draftKey('alice','one')}:aaaaaaaaaaaaaaaa`)).toBe('Other window');
  await act(async()=>editor.acknowledged(editor.value));expect(editor.value.text).toBe('');expect([...data.values()]).not.toContain('Other window');
});
it('takes storage changes from other windows without writing them back and leaves unrelated asks alone',async()=>{
  await mount();await edit('Here');
  data.set(draftKey('alice','one'),'aaaaaaaaaaaaaaaa');data.set(`${draftKey('alice','one')}:aaaaaaaaaaaaaaaa`,'There');
  const event=Object.assign(new Event('storage'),{key:draftKey('alice','two')});
  await act(async()=>events.dispatchEvent(event));expect(editor.value.text).toBe('Here');
  await act(async()=>events.dispatchEvent(Object.assign(new Event('storage'),{key:draftKey('alice','one')})));
  expect(editor.value.text).toBe('There');expect(data.get(`${draftKey('alice','one')}:aaaaaaaaaaaaaaaa`)).toBe('There');
  data.clear();await act(async()=>events.dispatchEvent(Object.assign(new Event('storage'),{key:null})));expect(editor.value.text).toBe('');
});
it('ignores malformed storage, retains in-window words when storage is blocked, and clears on acknowledged success',async()=>{
  data.set(draftKey('alice','one'),'{bad');await mount();expect(editor.value.text).toBe('');
  vi.stubGlobal('localStorage',{getItem:()=>{throw Error('Denied');},setItem:()=>{throw Error('Full');},removeItem:()=>{throw Error('Denied');}});
  await edit('Still here');expect(editor.value.text).toBe('Still here');expect(editor.persistent).toBe(false);
  await act(async()=>editor.acknowledged(editor.value));expect(editor.value.text).toBe('');
});

it('cannot erase an edit interleaved at acknowledgement deletion',async()=>{
  await mount();await edit('Sent');const sent=editor.value,key=draftKey('alice','one');
  vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>{
    data.set(`${key}:bbbbbbbbbbbbbbbb`,'Concurrent edit');data.set(key,'bbbbbbbbbbbbbbbb');data.delete(k);
  }});
  await act(async()=>editor.acknowledged(sent));
  expect(editor.value.text).toBe('Concurrent edit');expect(data.get(key)).toBe('bbbbbbbbbbbbbbbb');
  expect([...data.values()]).not.toContain('Sent');
});
