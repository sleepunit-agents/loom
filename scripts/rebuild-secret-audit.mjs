/** Read-only acceptance oracle over the actual disposable Root database. */
import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
export function assertSecretAudit({home,name,member,writeIds,actions,values}){
 const patterns=[];
 for(const value of values){
  const bytes=Buffer.from(value),digest=createHash('sha256').update(bytes).digest();
  patterns.push(bytes,digest,Buffer.from(bytes.toString('hex')),Buffer.from(bytes.toString('base64')),Buffer.from(digest.toString('hex')),Buffer.from(digest.toString('base64')));
 }
 const containsValue=bytes=>patterns.some(pattern=>bytes.includes(pattern));
 try{
   const program=JSON.parse(readFileSync(join(home,'program.json'),'utf8')),db=new Database(program.database,{readonly:true,fileMustExist:true});
   try{
    // Read only: never manufacture metadata or use a special frontend API.
    for(const {name:table} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
     const quoted='"'+table.replaceAll('"','""')+'"';
     for(const row of db.prepare('SELECT * FROM '+quoted).iterate())for(const value of Object.values(row)){
      if(typeof value==='string'){const bytes=Buffer.from(value);try{if(containsValue(bytes))throw Error('A value appeared in the Root database');}finally{bytes.fill(0);}}
      else if(Buffer.isBuffer(value)){try{if(containsValue(value))throw Error('A value appeared in the Root database');}finally{value.fill(0);}}
     }
    }
    for(const file of [program.database,program.database+'-wal']){
     if(!existsSync(file))continue;
     const bytes=readFileSync(file);try{if(containsValue(bytes))throw Error('A value appeared in the Root database file');}finally{bytes.fill(0);}
    }
    const rows=db.prepare('SELECT id,action,secret,"by",at FROM secret_changes WHERE secret=? ORDER BY rowid').all(name);
    for(const [index,row] of rows.entries()){
     const journal=db.prepare('SELECT state,member FROM secret_write_journal WHERE id=?').get(row.id);
     if(row.id!==writeIds[index]||row.by!==member||row.secret!==name||!Number.isFinite(Date.parse(row.at))||journal?.state!=='committed'||journal.member!==member)throw Error('A Secret change record did not match the signed-in owner write');
    }
    if(rows.length!==actions.length||rows.some((row,index)=>row.action!==actions[index]))throw Error('Secret changes were not recorded exactly');
   }finally{db.close();}
 }finally{for(const bytes of patterns)bytes.fill(0);}
}
