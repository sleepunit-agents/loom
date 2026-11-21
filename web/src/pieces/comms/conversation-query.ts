/** Wordless history uses the existing generated relational read and visibility. */
export const conversationActivityQuery = `query ConversationActivity($id:String!,$before:Int!) {
  deskTime { timezone }
  latestBridgeReceipt(conversation:$id){agent receivedAt acceptedAt replied}
  activity:conversationsSingle(where:{id:{eq:$id}}) {
    id label agent venue place
    turnsByConversation(where:{seq:{lt:$before}},orderBy:{seq:{direction:desc,priority:0}},limit:50) {
      seq at kind fromKind fromId outcome
    }
  }
}`;
export interface ConversationTurn {seq:number;at:string;kind:string;fromKind:string;fromId:string|null;outcome:string|null}
export interface ConversationActivityData {latestBridgeReceipt:{agent:string;receivedAt:string;acceptedAt:string|null;replied:boolean}|null;deskTime:{timezone:string}|null;activity:{id:string;label:string;agent:string;venue:string;place:string;turnsByConversation:ConversationTurn[]}|null}
