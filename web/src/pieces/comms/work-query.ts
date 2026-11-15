export const sourceQuery = 'query ConversationWork($conversation:String!,$offset:Int!){tasks(where:{sourceKind:{eq:"conversation"},sourceId:{eq:$conversation}},orderBy:{id:{direction:asc,priority:0}},limit:51,offset:$offset){id title status}}';
export const changeQuery = 'query MentionedChange($id:String!){changes(where:{id:{eq:$id}},limit:1){id title state draft checks review waitingOn}}';
export const taskQuery = 'query MentionedWork($id:String!){tasks(where:{id:{eq:$id}},limit:1){id title status}}';
