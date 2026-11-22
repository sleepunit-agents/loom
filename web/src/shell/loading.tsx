import { useEffect, useState, type ReactNode } from 'react';
import { AppIcon } from '../app-icon';
import { DeskOpening, LoadContext, useLoadCount, usePendingRead } from '../data/loading';
import { Weave } from './signin';
import './loading.css';

/** Leave a frame for newly mounted reads (including lazy screens) to register.
 * A stalled optional feed must never make the desk or window unusable. */
function useOpening(busy: boolean, autoReveal = false) {
  const [opening, setOpening] = useState(true);
  useEffect(() => {
    if (!opening || busy) return;
    const id = setTimeout(() => setOpening(false), 100);
    return () => clearTimeout(id);
  }, [busy, opening]);
  const [slow,setSlow] = useState(false);
  useEffect(() => {
    if (!opening) return;
    const id = autoReveal
      ? setTimeout(() => setOpening(false), 15_000)
      : setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(id);
  }, [opening, autoReveal]);
  return {opening, slow, reveal: () => setOpening(false)};
}

function BootConsole({count}: {count: number}) {
  const [started] = useState(() => performance.now());
  const [lines, setLines] = useState([
    {time: '0.000', message: 'loom.init : mount desktop shell'},
    {time: '0.000', message: 'weave.fb  : attach woven ground'},
    {time: '0.000', message: 'desk.io   : poll work queue'},
  ]);
  useEffect(() => {
    function append() {
      const time = ((performance.now() - started) / 1000).toFixed(3);
      const message = count ? `desk.io   : waiting on ${count} read${count === 1 ? '' : 's'}` : 'desk.init : checking work queue';
      setLines(previous => [...previous.slice(-2), {time, message}]);
    }
    const timer = setInterval(append, 680);
    return () => clearInterval(timer);
  }, [count, started]);
  return <div className="loom-boot-console" aria-hidden="true">
    {lines.map((line) => <div key={line.time + line.message}><span>[{line.time}]</span> {line.message}</div>)}
  </div>;
}

export function DesktopBoot({children}: {children: ReactNode}) {
  const {busy, count, start} = useLoadCount();
  const {opening} = useOpening(busy, true);
  return <LoadContext.Provider value={opening ? start : undefined}><DeskOpening.Provider value={opening}>
    <div className="loom-desk-mount" inert={opening}>{children}</div>
    {opening && <main className="loom-gate loom-desk-boot" data-state="connecting" role="status">
      <Weave />
      <div className="loom-gate__column">
        <div className="loom-gate__mark" aria-label="Loom OS">LOOM<i aria-hidden="true">//</i>OS</div>
        <BootConsole count={count}/>
        <p className="loom-gate__status">Opening your desk…</p>
      </div>
    </main>}
  </DeskOpening.Provider></LoadContext.Provider>;
}

export function WindowLoad({app,icon,title,visible,children}: {app:string; icon:string; title:string; visible:boolean; children:ReactNode}) {
  const {busy,start} = useLoadCount();
  const {opening, slow, reveal} = useOpening(busy);
  const covered = opening && busy;
  usePendingRead(visible && covered);
  return <LoadContext.Provider value={start}>
    <div className="loom-window-body">
      <div className="next-page" data-opening={covered || undefined} inert={covered}>{children}</div>
      {covered && <div className="loom-window-start" role="status"><span className="loom-loading-icon" aria-hidden="true"><AppIcon app={app} name={icon} house={48}/></span><span className="loom-read-beam" aria-hidden="true"/><span>Opening {title}…</span>{slow && <button onClick={reveal}>Show window while loading</button>}</div>}
      {busy && !opening && <div className="loom-window-refresh" role="status" aria-label={`Updating ${title}`}><i /></div>}
    </div>
  </LoadContext.Provider>;
}
