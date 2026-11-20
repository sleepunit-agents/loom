import {useEffect,useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {HomeMessageComposer} from './home-composer';
import {threadPath} from './home-comms-data';

export type Navigation={go:(path:string)=>void};
export function useSettingRequest({go}:Navigation,subject:string,label:string){
 const feed=useDataQuery<{homeComms:{member:string;agents:string[]}|null;householdSetup:{defaultAgent:string|null}|null}>('{ homeComms { member agents } householdSetup { defaultAgent } }');
 const mailbox=feed.status==='live'?feed.data?.homeComms:null;
 const agent=mailbox?.agents.find(id=>id===feed.data?.householdSetup?.defaultAgent)??mailbox?.agents[0];
 const member=mailbox?.member;
 const [draft,setDraft]=useState<{member:string;agent:string;words:string}>();
 useEffect(()=>{setDraft(undefined);},[member,agent]);
 const prepare=(input:object)=>{
  if(member&&agent)setDraft({member,agent,words:`Please propose this ${subject}.\n`+JSON.stringify(input,null,2)});
 };
 const reader=!member||!agent?<p>Connect to your agent in Comms to request this change.</p>:
  draft&&draft.member===member&&draft.agent===agent&&<section aria-label={label}>
   <p>Review the message to {agent}. You can answer the proposed change in Inbox.</p>
   <HomeMessageComposer key={draft.words} member={member} agent={agent} suggestedText={draft.words} onOpened={id=>{setDraft(undefined);go(threadPath(id));}}/>
  </section>;
 return {prepare,clear:()=>setDraft(undefined),disabled:!member||!agent,reader};
}
