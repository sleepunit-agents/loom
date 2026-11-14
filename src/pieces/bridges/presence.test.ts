import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixture as homeFixture, fixtureSharing } from '../../fixture.js';
import { presence, type PresenceSnapshot } from './presence.js';
const closes: Array<() => Promise<void>> = [], homes: string[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, {recursive:true,force:true}); });
async function fixture(slack = false) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-presence-')); homes.push(home); homeFixture(home);
  const clock = new FakeClock(100_000);
  const app = await startLoom({home,next:true,clock,sharing:fixtureSharing,stdout:()=>{}});
  closes.push(() => app.close());
  // Explicit fake owning role: actual Runtime has no venue presence source yet.
  let snapshot: PresenceSnapshot | 'wait' | undefined = {working:true,heartbeat:clock.now(),taken:[{id:'101',at:clock.now()}]};
  let live = true, released = true;
  const reaction = vi.fn(async (_id: string, _add: boolean, current: () => boolean) => { if (!current()) throw Error('held'); });
  const typing = vi.fn(async (current: () => boolean) => { if (!current()) throw Error('held'); });
  const read = vi.fn(() => snapshot);
  const controller = presence({clock,source:{snapshot:read},effects:{reaction,...(slack?{}:{typing})},current:()=>live,beforeEffect:()=>released});
  closes.unshift(controller.close);
  return {clock,controller,reaction,typing,read,set:(s: typeof snapshot)=>{snapshot=s;},get:()=>snapshot as PresenceSnapshot,live:(v:boolean)=>{live=v;},released:(v:boolean)=>{released=v;}};
}
const calls = (f: Awaited<ReturnType<typeof fixture>>) => f.reaction.mock.calls.map(([id,add]) => [id,add]);
async function settle() { for (let i=0;i<100;i++) await Promise.resolve(); }
function deferred() { let resolve!:()=>void; const promise = new Promise<void>(r=>{resolve=r;}); return {promise,resolve}; }
describe('internal exact-place presence with a fake owning lifecycle', () => {
  it('reacts once, pulses Discord typing, clears after posting and handles a new take then done', async () => {
    const f=await fixture(); await f.controller.flush(); await f.controller.flush();
    expect(calls(f)).toEqual([['101',true]]); expect(f.typing).toHaveBeenCalledOnce();
    f.clock.advance(5000); await settle(); expect(f.typing).toHaveBeenCalledTimes(2);
    f.set({...f.get(),postedAt:f.clock.now()}); await f.controller.flush();
    expect(calls(f)).toEqual([['101',true],['101',false]]); expect(f.typing).toHaveBeenCalledTimes(2);
    f.clock.advance(1); f.set({...f.get(),heartbeat:f.clock.now(),taken:[...f.get().taken,{id:'102',at:f.clock.now()}]}); await f.controller.flush();
    expect(calls(f).at(-1)).toEqual(['102',true]);
    f.set({...f.get(),working:false}); await f.controller.flush();
    expect(calls(f).at(-1)).toEqual(['102',false]);
    f.set(undefined); await f.controller.flush(); expect(f.reaction).toHaveBeenCalledTimes(4);
  });
  it('removes eyes exactly at the 90 second stale boundary, and a heartbeat preserves original take times', async () => {
    const f=await fixture(); await f.controller.flush();
    f.clock.advance(89_999); await settle(); await f.controller.flush(); expect(calls(f)).toEqual([['101',true]]);
    f.clock.advance(1); await f.controller.flush(); expect(calls(f)).toEqual([['101',true],['101',false]]);
    f.set({...f.get(),heartbeat:f.clock.now(),postedAt:100_000}); await f.controller.flush();
    expect(f.reaction).toHaveBeenCalledTimes(2);
  });
  it('does not issue typing on Slack and removes reactions when a place disappears', async () => {
    const f=await fixture(true); await f.controller.flush(); f.set(undefined); await f.controller.flush();
    expect(calls(f)).toEqual([['101',true],['101',false]]); expect(f.typing).not.toHaveBeenCalled();
  });
  it('holds every effect while staged or the owner is unavailable; release resumes cleanup', async () => {
    const f=await fixture(); f.released(false); await f.controller.flush(); expect(f.reaction).not.toHaveBeenCalled();
    f.released(true); f.set('wait'); await f.controller.flush(); expect(f.reaction).not.toHaveBeenCalled();
    f.set({working:true,heartbeat:f.clock.now(),taken:[{id:'101',at:f.clock.now()}]}); await f.controller.flush();
    f.released(false); f.set(undefined); await f.controller.flush(); expect(calls(f)).toEqual([['101',true]]);
    f.released(true); await f.controller.flush(); expect(calls(f).at(-1)).toEqual(['101',false]);
  });
  it('cleans up a late add after done during IO without typing', async () => {
    const f=await fixture(), pending=deferred(); f.reaction.mockImplementationOnce(async()=>pending.promise);
    const first=f.controller.flush(); await settle(); expect(calls(f)).toEqual([['101',true]]);
    f.set(undefined); const second=f.controller.flush(); expect(second).toBe(first);
    pending.resolve(); await first; expect(calls(f)).toEqual([['101',true],['101',false]]); expect(f.typing).not.toHaveBeenCalled();
  });
  it('passes a fresh per-effect gate across staging loss and never resumes a lost lifetime', async () => {
    const f=await fixture(), pending=deferred(); let checked: boolean | undefined;
    f.reaction.mockImplementationOnce(async(_id,_add,current)=>{await pending.promise;checked=current();if(!checked)throw Error('held');});
    const first=f.controller.flush(); await settle(); f.released(false); pending.resolve(); await first;
    expect(checked).toBe(false); expect(f.typing).not.toHaveBeenCalled();
    f.released(true); f.live(false); await f.controller.flush(); f.live(true); await f.controller.flush();
    expect(f.reaction).toHaveBeenCalledOnce();
  });
  it('retries uncertain adds idempotently, and failed removals before adding new eyes', async () => {
    const f=await fixture(); f.reaction.mockRejectedValueOnce(Error('upstream secret diagnostics'));
    await expect(f.controller.flush()).resolves.toBeUndefined(); await f.controller.flush();
    expect(calls(f)).toEqual([['101',true],['101',true]]);
    f.set(undefined); f.reaction.mockRejectedValueOnce(Error('lost removal acknowledgement'));
    await f.controller.flush(); await f.controller.flush();
    expect(calls(f).slice(-2)).toEqual([['101',false],['101',false]]);
  });
  it('retains the newest twenty unique takes and removes displaced eyes', async () => {
    const f=await fixture(); await f.controller.flush();
    f.set({...f.get(),taken:[{id:'101',at:100_000},...Array.from({length:21},(_,i)=>({id:String(200+i),at:100_000}))]});
    await f.controller.flush(); expect(calls(f)[1]).toEqual(['101',false]);
    expect(calls(f).slice(2)).toEqual(Array.from({length:20},(_,i)=>[String(201+i),true]));
    await f.controller.flush(); expect(f.reaction).toHaveBeenCalledTimes(22);
  });
  it('bounds uncertain eyes even if all cleanup fails while new takes arrive', async () => {
    const f=await fixture(); f.reaction.mockRejectedValue(Error('platform unavailable'));
    f.set({...f.get(),taken:Array.from({length:20},(_,i)=>({id:String(i),at:100_000}))}); await f.controller.flush();
    f.set({...f.get(),taken:Array.from({length:20},(_,i)=>({id:String(100+i),at:100_000}))}); await f.controller.flush();
    expect(f.reaction.mock.calls.filter(([,add])=>add)).toHaveLength(20);
    f.reaction.mockImplementation(async()=>{}); await f.controller.flush();
    expect(f.reaction.mock.calls.filter(([,add])=>add)).toHaveLength(40);
  });
  it('holds malformed/future facts without losing cleanup state', async () => {
    const f=await fixture(); await f.controller.flush();
    f.set({...f.get(),heartbeat:NaN}); await f.controller.flush(); expect(f.reaction).toHaveBeenCalledOnce();
    f.set({working:true,heartbeat:f.clock.now()+1,taken:[]}); await f.controller.flush(); expect(f.reaction).toHaveBeenCalledOnce();
    f.set(undefined); await f.controller.flush(); expect(calls(f).at(-1)).toEqual(['101',false]);
  });
  it('holds a throwing owning source and recovers its pending cleanup', async () => {
    const f=await fixture(); await f.controller.flush();
    f.read.mockImplementationOnce(()=>{throw Error('owner unavailable');});
    await expect(f.controller.flush()).resolves.toBeUndefined(); expect(f.reaction).toHaveBeenCalledOnce();
    f.set(undefined); await f.controller.flush(); expect(calls(f).at(-1)).toEqual(['101',false]);
  });
  it('rechecks done after an async typing transport acquires its credential', async () => {
    const f=await fixture(), pending=deferred(); let permitted: boolean | undefined;
    f.typing.mockImplementationOnce(async current=>{await pending.promise;permitted=current();if(!permitted)throw Error('held');});
    const first=f.controller.flush(); await settle(); expect(f.typing).toHaveBeenCalledOnce();
    f.set(undefined); pending.resolve(); await first; expect(permitted).toBe(false);
    await f.controller.flush(); expect(calls(f).at(-1)).toEqual(['101',false]);
  });
  it('awaits in-flight IO on close and prevents subsequent cleanup/typing/timers', async () => {
    const f=await fixture(), pending=deferred(); f.reaction.mockImplementationOnce(async()=>pending.promise);
    const first=f.controller.flush(); await settle(); let ended=false;
    const close=f.controller.close().then(()=>{ended=true;}); await settle(); expect(ended).toBe(false);
    pending.resolve(); await first; await close; f.clock.advance(100_000); await settle(); await f.controller.flush();
    expect(f.reaction).toHaveBeenCalledOnce(); expect(f.typing).not.toHaveBeenCalled();
  });
});
