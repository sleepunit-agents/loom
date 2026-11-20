/** Scroll state holds sequence numbers only, never message words. */
export class ReplyCursor {
 private through:number|undefined;
 reset(){this.through=undefined;}
 advance(rows:readonly {seq:number;kind:string}[]){
  const previous=this.through;
  this.through=Math.max(previous??0,...rows.map(row=>row.seq));
  return previous===undefined?{initial:true,added:0,sent:false}:{initial:false,added:rows.filter(row=>row.seq>previous&&row.kind!=='card').length,sent:rows.some(row=>row.seq>previous&&row.kind==='message')};
 }
}
