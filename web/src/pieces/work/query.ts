const recentOrder = 'orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}}';
const fields = 'id title status changedAt';
export const workHomeQuery = `query WorkHome {
  inFlight:projects { id tasksByProject(where:{status:{eq:in_progress}},limit:1){id} }
  projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}}) {
    id name lifecycle tasksByProject(${recentOrder},limit:1){${fields}}
  }
}`;
export const workProjectQuery = `query WorkProject($id:String!){
  project:projectsSingle(where:{id:{eq:$id}}){ id name lifecycle }
  working:tasks(where:{project:{eq:$id},status:{eq:in_progress}},${recentOrder},limit:10){${fields}}
  recent:tasks(where:{project:{eq:$id}},${recentOrder},limit:10){${fields}}
}`;
