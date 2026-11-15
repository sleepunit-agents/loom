/** Wordless history uses the existing generated relational read and visibility. */
export const conversationActivityQuery = `query ConversationActivity($id:String!,$before:Int!) {
  activity:conversationsSingle(where:{id:{eq:$id}}) {
    id label agent venue
    turnsByConversation(where:{seq:{lt:$before}},orderBy:{seq:{direction:desc,priority:0}},limit:50) {
      seq at kind fromKind fromId outcome
    }
  }
}`;
export interface ConversationTurn {seq:number;at:string;kind:string;fromKind:string;fromId:string|null;outcome:string|null}
export interface ConversationActivityData {activity:{id:string;label:string;agent:string;venue:string;turnsByConversation:ConversationTurn[]}|null}
