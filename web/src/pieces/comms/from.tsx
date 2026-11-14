import { useRecords } from '../../data';
interface Provenance {id:string;label:string;url?:string;[key:string]:unknown}
/** No cached call result: access loss/disconnection hides the private label. */
export function FromConversation({conversation}:{conversation:string}) {
 const {records,status}=useRecords<Provenance>('commsFrom',conversation);
 const record=status==='live'?records.find(row=>row.id===conversation):undefined;
 return <p>{record?.url?<a href={record.url}>{record.label}</a>:record?.label??'From a conversation'}</p>;
}
