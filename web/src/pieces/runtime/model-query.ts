/** The worker breaks equal preference positions by the model identifier. */
export const agentModelsSelection='agentModels(orderBy:{agent:{direction:asc,priority:2},position:{direction:asc,priority:1},model:{direction:asc,priority:0}}){agent model position}';
export const runtimeAccountsQuery=`query RuntimeModelAccounts {
 deskTime { timezone }
 ${agentModelsSelection}
 modelAccounts {
  __typename
  ... on RuntimeAccount { label level }
  ... on RuntimeAccountDetail { id owner provider usage usageReadAt resetsAt hasRoom signedInOn { id name } }
 }
}`;
