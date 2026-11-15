/** Translate existing isolated UI fixtures into the shared Inbox wire shape.
 * Production authority, classification and counts are tested against SQL. */
export function deskWaitingFixture(document:string,variables:Record<string,unknown>|undefined,snapshot:{status:string;records:readonly any[]},member='owner',total?:number) {
  const all=snapshot.records.map(row=>({
    id:row.id,toKind:row.toKind??'person',to:row.to??row.member??'owner',source:typeof row.source==='string'?row.source:'notice',
    agent:row.agent??null,at:row.at??new Date(row.createdAt??1).toISOString(),state:row.state==='open'?'waiting':row.state,
    volume:row.volume??'full',answers:row.answers===null?null:row.answers??'yes-no',thread:row.thread??null,
    bodyKeepUntil:row.bodyKeepUntil??null,body:row.body===null?null:row.body??{words:row.ask??'Waiting item',why:row.why??null},read:false,refs:row.refs??[],
  })).filter(row=>row.toKind==='person'&&row.to===member&&row.volume!=='mute');
  const needs=all.filter(row=>row.state==='waiting'&&row.answers);
  const homeComms=member?{member}:null;
  if(document.includes('DeskWaitingCounts')) {
    const ids=[...new Set(all.map(row=>row.agent).filter(Boolean))];
    return {status:snapshot.status,data:{homeComms,inboxFolders:{needs:total??needs.length,agents:ids.map(id=>({id,needs:needs.filter(row=>row.agent===id).length}))}}};
  }
  const rows=needs.filter(row=>!variables?.agent||row.agent===variables.agent).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||b.id.localeCompare(a.id)).slice(0,1);
  return {status:snapshot.status,data:{homeComms,inboxItems:rows}};
}
