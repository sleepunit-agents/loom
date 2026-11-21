import { useEffect, useState, type ReactNode } from 'react';
import { AppIcon } from '../app-icon';
import { DeskOpening, LoadContext, useLoadCount, usePendingRead } from '../data/loading';
import { Weave } from './signin';
import './loading.css';

/** Leave a frame for newly mounted reads (including lazy screens) to register.
 * A stalled optional feed must never make the desk or window unusable. */
function useOpening(busy: boolean) {
  const [opening, setOpening] = useState(true);
  useEffect(() => {
    if (!opening || busy) return;
    const id = setTimeout(() => setOpening(false), 100);
    return () => clearTimeout(id);
  }, [busy, opening]);
  const [slow,setSlow] = useState(false);
  useEffect(() => {
    if (!opening) return;
    const id = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(id);
  }, [opening]);
  return {opening, slow, reveal: () => setOpening(false)};
}

export function DesktopBoot({children}: {children: ReactNode}) {
  const {busy, start} = useLoadCount();
  const {opening, slow, reveal} = useOpening(busy);
  return <LoadContext.Provider value={opening ? start : undefined}><DeskOpening.Provider value={opening}>
    <div className="loom-desk-mount" inert={opening}>{children}</div>
    {opening && <main className="loom-gate loom-desk-boot" data-state="connecting" role="status">
      <Weave />
      <div className="loom-gate__column">
        <div className="loom-gate__mark" aria-label="Loom OS">LOOM<i aria-hidden="true">//</i>OS</div>
        <div className="loom-gate__thread" aria-hidden="true"><i /></div>
        <p className="loom-gate__status">Opening your desk…</p>
        {slow && <button className="loom-gate__go" data-kind="quiet" onClick={reveal}>Show desk while loading</button>}
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
