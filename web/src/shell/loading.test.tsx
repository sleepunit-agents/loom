// @ts-expect-error The renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { usePendingRead } from '../data/loading';
import { DesktopBoot, WindowLoad } from './loading';

vi.mock('./signin', () => ({ Weave: () => null }));
vi.mock('../app-icon', () => ({ AppIcon: () => null }));

function Read({busy}:{busy:boolean}) {
  usePendingRead(busy);
  return <input defaultValue="Draft"/>;
}
function Desk({busy}:{busy:boolean}) {
  return <DesktopBoot><WindowLoad title="Tasks" app="tasks" icon="check" visible><Read busy={busy}/></WindowLoad></DesktopBoot>;
}

afterEach(() => vi.useRealTimers());
it('keeps the desk mounted during boot, then shows refresh activity without taking the window away', async()=>{
  vi.useFakeTimers();
  let tree!: ReturnType<typeof create>;
  await act(async()=>{tree=create(<Desk busy/>);});
  try {
    await act(async()=>{vi.advanceTimersByTime(1000);});
    expect(tree.root.findByProps({className:'loom-desk-mount'}).props.inert).toBe(true);
    const input=tree.root.findByType('input');
    await act(async()=>{tree.update(<Desk busy={false}/>);});
    await act(async()=>{vi.advanceTimersByTime(120);});
    expect(tree.root.findByProps({className:'loom-desk-mount'}).props.inert).toBe(false);
    await act(async()=>{tree.update(<Desk busy/>);});
    expect(tree.root.findByProps({className:'next-page'}).props.inert).toBe(false);
    expect(tree.root.findByType('input')).toBe(input);
    expect(tree.root.findByProps({className:'loom-window-refresh'})).toBeTruthy();
    await act(async()=>{tree.update(<Desk busy={false}/>);});
    expect(tree.root.findAllByProps({className:'loom-window-refresh'})).toHaveLength(0);
  } finally {await act(async()=>tree.unmount());}
});

it('prints pending reads and releases a stalled desk automatically without a skip button', async()=>{
  vi.useFakeTimers();
  let tree!: ReturnType<typeof create>;
  await act(async()=>{tree=create(<DesktopBoot><Read busy/></DesktopBoot>);});
  try {
    await act(async()=>{vi.advanceTimersByTime(7000);});
    const log=tree.root.findByProps({className:'loom-boot-console'});
    expect(log.findAllByType('div').some(row=>row.children.includes('desk.io   : waiting on 1 read'))).toBe(true);
    expect(tree.root.findAllByType('button')).toHaveLength(0);
    await act(async()=>{vi.advanceTimersByTime(8000);});
    expect(tree.root.findByProps({className:'loom-desk-mount'}).props.inert).toBe(false);
  } finally {await act(async()=>tree.unmount());}
});
