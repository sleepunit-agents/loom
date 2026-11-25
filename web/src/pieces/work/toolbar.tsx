import type {ReactNode} from 'react';
import {ToolbarFrame} from '../../kit/toolbar';
const views = [
  {label:'Overview', suffix:''},
  {label:'Board', suffix:'/board'},
  {label:'Pull requests', suffix:'/changes'},
  {label:'History', suffix:'/history'},
] as const;

export function WorkFrame({title,path,project,go,controls,children}:{
  title:string; path:string; project?:string; go:(path:string)=>void; controls?:ReactNode; children:ReactNode;
}) {
  const home = '/p/work';
  const route = path.split('?')[0].replace(/\/$/,'');
  const root = project && home+'/project/'+encodeURIComponent(project);
  return <div className={'work-desk'+(project ? ' work-project' : '')}>
    <ToolbarFrame title={title} controls={controls}
      mark={<span className="work-mark" aria-hidden="true"><i/><i/><i/></span>}
      back={route!==home ? {label:'Projects',open:()=>go(home)} : undefined}
      navigation={root ? {label:'Project views',views:views.map(({label,suffix})=>({
        label,current:route===root+suffix,open:()=>go(root+suffix),
      }))} : undefined}
      action={root ? {label:'Backlog',open:()=>go('/p/tasks-preview/?folder='+encodeURIComponent('project:'+project))} : undefined}>
      {children}
    </ToolbarFrame>
  </div>;
}
