import { it, expect, vi } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
const f=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../../web/src/loom',()=>({fetchView:f.fetch}));
import { usePage, type PageState } from '../../web/src/page';
import { apps, appAt } from '../../web/src/apps';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('a registered app opens through shell navigation without fetching a page or starting a refresh timer',async()=>{
  vi.stubGlobal('addEventListener',vi.fn());vi.stubGlobal('removeEventListener',vi.fn());
  const timer=vi.spyOn(globalThis,'setInterval');
  const nav={here:()=> '/_dev/tasks',push:vi.fn(),replace:vi.fn(),top:vi.fn()};
  let page!:PageState;
  function Probe(){page=usePage('/_dev/tasks',()=>{},nav);return null;}
  let tree!:ReturnType<typeof create>;
  try {
    await act(async()=>{tree=create(h(Probe));});
    await act(async()=>{await page.load('/_dev/tasks',false);});
    expect(page.url).toBe('/_dev/tasks');expect(page.waiting).toBe(false);expect(page.error).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();
    expect(appAt('/_dev/tasks')).toBe(apps[0]);expect(appAt('/_dev/tasks/t-1')?.fit.ideal).toBe(1040);
  } finally { if(tree) await act(async()=>tree.unmount());timer.mockRestore();vi.unstubAllGlobals(); }
});
