import type {ReactNode} from 'react';
import {ToolbarFrame} from '../../kit/toolbar';
const views = [
  {label:'Overview', suffix:''},
  {label:'Board', suffix:'/board'},
  {label:'Backlog', suffix:'/backlog'},
  {label:'Pull requests', suffix:'/changes'},
  {label:'History', suffix:'/history'},
  {label:'Agent notes', suffix:'/notes'},
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
      back={project || route===home+'/unfiled' || route.startsWith(home+'/unfiled/') ? {label:'Projects',open:()=>go(home)} : undefined}
      navigation={root ? {label:'Project views',views:views.map(({label,suffix})=>({
        label,current:route===root+suffix || (suffix==='/notes' && route.startsWith(root+'/notes/')) || (suffix==='/changes' && route.startsWith(root+'/changes/change/')) || (suffix==='/backlog' && route.startsWith(root+'/backlog/task/')),open:()=>go(root+suffix),
      }))} : {label:'Work views',views:[
        {label:'Projects',current:route===home,open:()=>go(home)},
        {label:'Pull requests',current:route===home+'/changes' || route.startsWith(home+'/changes/'),open:()=>go(home+'/changes')},
        {label:'Agent notes',current:route===home+'/notes' || route.startsWith(home+'/notes/'),open:()=>go(home+'/notes')},
        {label:'Backlog',current:route===home+'/backlog' || route.startsWith(home+'/backlog/'),open:()=>go(home+'/backlog')},
      ]}}>
      {children}
    </ToolbarFrame>
  </div>;
}
