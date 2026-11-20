/** A directory card can record an account in where.slack/discord and its
 * workspace in where.slack_workspace/discord_workspace. Both must match. */
export const accountPlatforms = ['slack', 'discord'] as const;
export type AccountPlatform = typeof accountPlatforms[number];
export const accountIndex = (platform: AccountPlatform) => `people_${platform}_account`;
export const accountColumns = (platform: AccountPlatform) => [
  `json_extract(card_json, '$.where.${platform}_workspace.value')`,
  `json_extract(card_json, '$.where.${platform}.value')`,
] as const;
