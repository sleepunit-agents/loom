import {createContext, useContext, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import './toolbar.css';

const controlsSlot = createContext<HTMLDivElement|null>(null);

/** Let the view that owns a filter render it in this window's toolbar. */
export function ToolbarControls({children}:{children:ReactNode}) {
  const slot = useContext(controlsSlot);
  return slot && createPortal(children,slot);
}

type Destination = {label:string; open:()=>void};
export function ToolbarFrame({title,mark,back,navigation,action,controls,children}:{
  title:string; mark?:ReactNode; back?:Destination;
  navigation?:{label:string; views:(Destination & {current:boolean})[]};
  action?:Destination; controls?:ReactNode; children:ReactNode;
}) {
  const [slot,setSlot] = useState<HTMLDivElement|null>(null);
  return <>
    <header className="loom-toolbar" aria-label={title+' toolbar'}>
      <div className="loom-toolbar-title">
        {mark}<h1>{title}</h1>
        {back && <button type="button" className="loom-toolbar-return" onClick={back.open}><span aria-hidden="true">← </span>{back.label}</button>}
      </div>
      {navigation && <nav aria-label={navigation.label} className="loom-toolbar-views">
        {navigation.views.map(view=><button type="button" key={view.label} aria-current={view.current ? 'page' : undefined}
          onClick={()=>{if(!view.current)view.open();}}>{view.label}</button>)}
        {action && <button type="button" className="loom-toolbar-action" onClick={action.open}>{action.label} <span aria-hidden="true">↗</span></button>}
      </nav>}
      <div ref={setSlot} className="loom-toolbar-controls">{controls}</div>
    </header>
    <controlsSlot.Provider value={slot}>{children}</controlsSlot.Provider>
  </>;
}
