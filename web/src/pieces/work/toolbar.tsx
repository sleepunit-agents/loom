import {createContext, useContext, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

const controlsSlot = createContext<HTMLDivElement|null>(null);
const views = [
  {label:'Overview', suffix:''},
  {label:'Board', suffix:'/board'},
  {label:'Pull requests', suffix:'/changes'},
  {label:'History', suffix:'/history'},
] as const;

/** Keep the filter's state and query with its view while drawing it in the app chrome. */
export function WorkControls({children}:{children:ReactNode}) {
  const slot = useContext(controlsSlot);
  return slot && createPortal(children,slot);
}

export function WorkFrame({title,path,project,go,controls,children}:{
  title:string; path:string; project?:string; go:(path:string)=>void; controls?:ReactNode; children:ReactNode;
}) {
  const [slot,setSlot] = useState<HTMLDivElement|null>(null);
  const home = '/p/work';
  const route = path.split('?')[0].replace(/\/$/,'');
  const root = project && home+'/project/'+encodeURIComponent(project);
  return <div className={'work-desk'+(project ? ' work-project' : '')}>
    <header className="work-toolbar">
      <div className="work-toolbar-title">
        <span className="work-mark" aria-hidden="true"><i/><i/><i/></span>
        <h1>{title}</h1>
        {route!==home && <button type="button" className="work-return" onClick={()=>go(home)}><span aria-hidden="true">← </span>Projects</button>}
      </div>
      {root && <nav aria-label="Project views" className="work-view-switch">
        {views.map(({label,suffix})=>{
          const href=root+suffix;
          return <button type="button" key={label} aria-current={route===href ? 'page' : undefined}
            onClick={()=>{if(route!==href)go(href);}}>{label}</button>;
        })}
        <button type="button" className="work-backlog" onClick={()=>go('/p/tasks-preview/?folder='+encodeURIComponent('project:'+project))}>
          Backlog <span aria-hidden="true">↗</span></button>
      </nav>}
      <div ref={setSlot} className="work-context-controls">{controls}</div>
    </header>
    <controlsSlot.Provider value={slot}>{children}</controlsSlot.Provider>
  </div>;
}
