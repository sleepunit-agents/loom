/** The selections the removed desktop asked loom for (t-2428; the desktop's files are in git before that), kept
 * verbatim as fixtures. The reads they ask are loom's data API, not the desktop's: the boards page and agents read
 * them too, and the server's tests hold each read to its policy and limits with these exact documents. Strings
 * only; nothing here is shipped. */
import { threadFields } from '../../web/src/pieces/comms/thread-fields.js';

/** The desktop bar's ticker (pieces/attention/bar-stats.ts). */
export const deskTempoQuery = `query DeskTempo {
  triggers { id enabled state }
  triggerLog(orderBy: {seq: {direction: desc, priority: 0}}, limit: 1) { seq event }
  agentPauses { agent }
}`;
export const deskBoxesQuery = `query DeskBoxes { boxes { id revokedAt } boxReadings(where: {level: {ne: ok}}) { box } }`;
export const deskBridgesQuery = `query DeskBridges { bridgeConnections { id enabled } }`;
export const deskChangesQuery = `query DeskChanges { changes(where: {state: {eq: open}}) { id checks } }`;
export const deskTasksQuery = `query DeskTasks {
  inProgress: tasks(where: {status: {eq: in_progress}}) { id isShelved }
  readyTasks { id }
}`;
/** The desktop bar's clock (pieces/attention/desk-time.ts). */
export const deskTimeQuery = 'query DeskTime { deskTime { at timezone } }';

/** Home's first waiting ask for one agent (pieces/attention/waiting.tsx). */
const waitingFields = 'id toKind to source agent at state volume answers waitsOnKind waitsOnId thread bodyKeepUntil body { words why } read refs';
export const deskAgentWaitingQuery = `query DeskAgentWaiting($agent:String!) { homeComms { member } inboxItems(folder:"needs",agent:$agent,limit:1) { ${waitingFields} } }`;

/** Home's agent card (pieces/attention/talk.tsx). */
export const cardTalkQuery = `query DeskCardTalk($agent: String!, $limit: Int!) {
  recent: recentConversations(agent: $agent, limit: $limit) { id agent label venue place lastAt }
  answered: recentConversations(agent: $agent, limit: 1, answeredOnly: true) { id agent venue place lastAnswer { at words } }
}`;

/** Comms' work beside a conversation (pieces/comms/work-query.ts). */
export const sourceQuery = 'query ConversationWork($conversation:String!,$offset:Int!){tasks(where:{sourceKind:{eq:"conversation"},sourceId:{eq:$conversation}},orderBy:{id:{direction:asc,priority:0}},limit:51,offset:$offset){id title status isShelved} conversationMadeChanges(conversation:$conversation,limit:51,offset:$offset){id}}';
export const changeQuery = 'query MentionedChange($id:String!,$conversation:String!){changes(where:{id:{eq:$id}},limit:1){id title state draft checks review waitingOn} conversationMadeChanges(conversation:$conversation,change:$id,limit:1){id}}';
export const taskQuery = 'query MentionedWork($id:String!){tasks(where:{id:{eq:$id}},limit:1){id title status isShelved sourceKind sourceId}}';
export const conversationApprovalsQuery = `query ConversationQuestions($conversation:String!,$offset:Int!){
 inboxItems(conversation:$conversation,source:"approval",limit:11,offset:$offset){id sourceId}
 taskQuestions:inboxItems(conversation:$conversation,source:"task",limit:11,offset:$offset){id sourceId}
 approvals(where:{conversation:{eq:$conversation}},orderBy:{askedAt:{direction:desc,priority:0}},limit:11,offset:$offset){id}
}`;

/** Comms' list of threads and one open thread (pieces/comms/shared-query.ts). */
const archivedQuestionFields = 'thread ref raisedAt verdict answeredBy answeredAt wordsKeepUntil body{text kind why if_yes if_no fine refs relayedFrom}';
const messageFields = 'thread seq kind sender clientId at words wordsKeepUntil inboxItem verdict tool cardState delivery notice { error attempt settled retryAt } stepInfo { exit limit parent t0 t1 } stepDetails { detail body result items { text state } }';
export const commsQuery = `query Comms($archived:Boolean!,$search:String!,$offset:Int!){
 homeComms { member agents }
 commsFolders { threads archived }
 commsThreads(archived:$archived,search:$search,offset:$offset,limit:51){${threadFields}}
}`;
export const commsThreadQuery = `query CommsThread($id:String!,$before:Int,$earlier:Boolean!=false){
 commsArchivedQuestions(thread:$id,limit:51) @skip(if:$earlier){${archivedQuestionFields}}
 commsThread(id:$id){${threadFields}}
 commsMessages(thread:$id,beforeSeq:$before,limit:51){${messageFields}}
 commsRefs(thread:$id){ref messageSeq}
}`;
