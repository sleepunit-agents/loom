import {expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {commsDeliveryEvidence} from './comms-delivery-evidence.js';
const expected={thread:'th:fiction',conversation:'fictional-conversation',agent:'fern'},receipt={thread:'th:fiction',seq:1,item:'one'};
function fixture(count:number,thread=expected.thread){
 const db=new Database(':memory:');db.exec('CREATE TABLE inbox(id TEXT,conversation TEXT,to_kind TEXT,"to" TEXT,source TEXT,thread TEXT,message_seq INTEGER)');
 for(let n=0;n<count;n++)db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?,?)').run(n===0?'one':'duplicate',expected.conversation,'agent','fern','thread',thread,1);
 return db;
}
it.each([[0,false],[1,true],[2,false]] as const)('counts every delivery row, not only the returned primary key: copies=%s', (count,ok)=>{
 const db=fixture(count);try{expect(commsDeliveryEvidence(db,expected,receipt)).toEqual({ok,count});}finally{db.close();}
});
it('refuses a receipt for another thread even when that receipt has its own stored delivery',()=>{
 const db=fixture(1,'th:other');try{expect(commsDeliveryEvidence(db,expected,{...receipt,thread:'th:other'}).ok).toBe(false);}finally{db.close();}
});
it('binds the receipt item instead of accepting a different stored item at the same message',()=>{
 const db=fixture(1);try{expect(commsDeliveryEvidence(db,expected,{...receipt,item:'not-the-stored-item'}).ok).toBe(false);}finally{db.close();}
});
it.each([['conversation','other-conversation'],['to_kind','person'],['to','moss'],['source','notice']] as const)('refuses a delivery with the wrong %s', (column,value)=>{
 const db=fixture(1);try{db.prepare('UPDATE inbox SET "'+column+'"=?').run(value);expect(commsDeliveryEvidence(db,expected,receipt).ok).toBe(false);}finally{db.close();}
});
