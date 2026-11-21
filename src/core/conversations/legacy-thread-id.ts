import { createHash, createHmac } from 'node:crypto';
import type Database from 'better-sqlite3';

export function legacyConversationId(agent:string, venue:string, place:string) {
  return 'cv-' + createHash('sha256').update([agent, venue, place].join('\0')).digest('hex').slice(0,12);
}

// The v1 writer used lowercase RFC 4648 base32 without padding for both prefixes.
function prefix(bytes:Buffer, length:number) {
  let bits=0, value=0, result='';
  for (const byte of bytes) {
    value=(value<<8)|byte;
    bits+=8;
    while (bits>=5) {
      bits-=5;
      result+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>bits)&31];
      if (result.length===length) return result;
    }
  }
  throw Error('Incomplete thread prefix');
}

export function deletedThreadLookup(open:(agent:string)=>Database.Database, readSalt:()=>Buffer) {
  const agents=new Map<string,{ordinary:Map<string,string>; spawned:string[]}>();
  const memberships=new Map<string,Map<string,Set<string>>>();
  return (agent:string, member:string, thread:string):string|undefined => {
    let records=agents.get(agent);
    if (!records) {
      const source=open(agent);
      if (!source.readonly) throw Error('Expected a read-only conversation archive');
      records={ordinary:new Map(),spawned:[]};
      const rows=source.prepare("SELECT id,venue,place FROM conversations WHERE agent=? AND venue IN ('loom','spawn')").iterate(agent);
      for (const {id,venue,place} of rows as Iterable<{id:string;venue:string;place:string}>) {
        if (id!==legacyConversationId(agent,venue,place)) throw Error('Inconsistent legacy conversation identity');
        if (venue==='loom') records.ordinary.set(place,id);
        else records.spawned.push(id);
      }
      agents.set(agent,records);
    }
    const key=JSON.stringify([agent,member]);
    let spawned=memberships.get(key);
    if (!spawned) {
      spawned=new Map();
      if (records.spawned.length) {
        const salt=readSalt();
        if (salt.length!==32) throw Error('Expected original Comms salt');
        for (const cv of records.spawned) {
          const first=prefix(createHash('sha256').update(`spawn:${agent}:${cv}`).digest(),16);
          const place='th:'+prefix(createHmac('sha256',salt).update([member,agent,first].join('\0')).digest(),10);
          const ids=spawned.get(place) ?? new Set<string>();
          ids.add(cv);
          spawned.set(place,ids);
        }
      }
      memberships.set(key,spawned);
    }
    const matches=new Set(spawned.get(thread));
    const ordinary=records.ordinary.get(thread);
    if (ordinary) matches.add(ordinary);
    return matches.size===1 ? [...matches][0] : undefined;
  };
}
