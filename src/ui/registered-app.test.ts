import { it, expect, vi } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
const f=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../../web/src/loom',()=>({fetchView:f.fetch}));
import { isUiRequest } from './handler.js';
import { usePage, type PageState } from '../../web/src/page';
import { nameOf } from '../../web/src/tiling/name';
import { apps, appAt } from '../../web/src/apps';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('a registered app opens through shell navigation without fetching a page or starting a refresh timer',async()=>{
  vi.stubGlobal('addEventListener',vi.fn());vi.stubGlobal('removeEventListener',vi.fn());
  const timer=vi.spyOn(globalThis,'setInterval');
  const nav={here:()=> '/p/tasks-preview',push:vi.fn(),replace:vi.fn(),top:vi.fn()};
  let page!:PageState;
  function Probe(){page=usePage('/p/tasks-preview',()=>{},nav);return null;}
  let tree!:ReturnType<typeof create>;
  try {
    await act(async()=>{tree=create(h(Probe));});
    await act(async()=>{await page.load('/p/tasks-preview',false);});
    expect(page.url).toBe('/p/tasks-preview');expect(page.waiting).toBe(false);expect(page.error).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();
    expect(isUiRequest({method:'GET',headers:{}} as any, apps[0].path)).toBe(true);
    expect(isUiRequest({method:'GET',headers:{}} as any, apps[0].preview)).toBe(true);
    expect(nameOf(apps[0].preview)).not.toBe(nameOf('/p/tasks'));
    expect(appAt('/p/tasks')).toBe(apps[0]);
    expect(nameOf(apps[0].path)).toBe(nameOf('/p/tasks'));
    expect(appAt('/p/tasks-preview')).toBe(apps[0]);expect(appAt('/p/tasks-preview/t-1')?.fit.ideal).toBe(1040);
  } finally { if(tree) await act(async()=>tree.unmount());timer.mockRestore();vi.unstubAllGlobals(); }
});

it('a cold app fetches only shell chrome once and keeps the latest navigation while it arrives',async()=>{
  vi.stubGlobal('addEventListener',vi.fn());vi.stubGlobal('removeEventListener',vi.fn());
  f.fetch.mockReset();
  let answer!:(value:unknown)=>void;
  f.fetch.mockReturnValue(new Promise(resolve=>{answer=resolve;}));
  const timer=vi.spyOn(globalThis,'setInterval');
  const nav={here:()=> '/p/tasks',push:vi.fn(),replace:vi.fn(),top:vi.fn()};
  const say=()=>{};
  let page!:PageState;
  function Probe(){page=usePage('/p/tasks',say,nav,true);return null;}
  let tree!:ReturnType<typeof create>;
  try {
    await act(async()=>{tree=create(h(Probe));});
    let first!:Promise<void>,second!:Promise<void>;
    await act(async()=>{first=page.load('/p/tasks',false);second=page.load('/p/tasks/task/t-2',true);});
    await act(async()=>{answer({status:200,data:{view:'home',chrome:{csrf:'shell'}}});await Promise.all([first,second]);});
    expect(f.fetch.mock.calls).toEqual([['/']]);
    expect(page.url).toBe('/p/tasks/task/t-2');expect(page.data?.chrome.csrf).toBe('shell');
    expect(nav.push.mock.calls).toEqual([['/p/tasks/task/t-2']]);expect(timer).not.toHaveBeenCalled();
  } finally {if(tree) await act(async()=>tree.unmount());timer.mockRestore();vi.unstubAllGlobals();f.fetch.mockReset();}
});
