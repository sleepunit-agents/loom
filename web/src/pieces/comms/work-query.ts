export const sourceQuery = 'query ConversationWork($conversation:String!,$offset:Int!){tasks(where:{sourceKind:{eq:"conversation"},sourceId:{eq:$conversation}},orderBy:{id:{direction:asc,priority:0}},limit:51,offset:$offset){id title status} conversationMadeChanges(conversation:$conversation,limit:51,offset:$offset){id}}';
export const changeQuery = 'query MentionedChange($id:String!,$conversation:String!){changes(where:{id:{eq:$id}},limit:1){id title state draft checks review waitingOn} conversationMadeChanges(conversation:$conversation,change:$id,limit:1){id}}';
export const taskQuery = 'query MentionedWork($id:String!){tasks(where:{id:{eq:$id}},limit:1){id title status sourceKind sourceId}}';

export const conversationApprovalsQuery = `query ConversationQuestions($conversation:String!,$offset:Int!){
 inboxItems(conversation:$conversation,source:"approval",limit:11,offset:$offset){id sourceId}
 approvals(where:{conversation:{eq:$conversation}},orderBy:{askedAt:{direction:desc,priority:0}},limit:11,offset:$offset){id}
}`;
