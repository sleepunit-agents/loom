const recentOrder = 'orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}}';
const fields = 'id title status changedAt';
/** Tickets filed under no project, closed ones included so a completed ticket's story stays reachable from Work.
 * The tasks rule decides who reads each one (its owner and household owners), so the home entry, the rows, the
 * next-page probe and the empty state all come from what this reader may see. */
const unfiledWhere = 'where:{project:{isNull:true}}';
export const unfiledPageSize = 50;
export const workHomeQuery = `query WorkHome {
  inFlight:projects { id tasksByProject(where:{status:{eq:in_progress}},limit:1){id} }
  projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}}) {
    id name goal lifecycle tasksByProject(${recentOrder},limit:1){${fields}}
  }
  unfiled:tasks(${unfiledWhere},${recentOrder},limit:1){${fields}}
}`;
export const workProjectQuery = `query WorkProject($id:String!){
  project:projectsSingle(where:{id:{eq:$id}}){ id name goal lifecycle }
  working:tasks(where:{project:{eq:$id},status:{eq:in_progress}},${recentOrder},limit:10){${fields}}
  recent:tasks(where:{project:{eq:$id}},${recentOrder},limit:10){${fields}}
}`;
export const workUnfiledQuery = `query WorkUnfiled($offset:Int!){
  unfiled:tasks(${unfiledWhere},${recentOrder},limit:${unfiledPageSize+1},offset:$offset){${fields}}
}`;
export const unfiledBase = '/p/work/unfiled';

/** The page in the route is 1-based and absent for the first page, so Back from a ticket story lands on the page it was opened from. */
export function unfiledPage(path:string):number {
  const raw = path.split('/')[4];
  if (!raw) return 0;
  return /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw)-1 : -1;
}
export const unfiledPath = (page:number) => page>0 ? `${unfiledBase}/${page+1}` : unfiledBase;
