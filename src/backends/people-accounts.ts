import type {Database} from 'better-sqlite3';
/** A directory card can record an account in where.slack/discord and its
 * workspace in where.slack_workspace/discord_workspace. Both must match. */
export const accountPlatforms = ['slack', 'discord'] as const;
export type AccountPlatform = typeof accountPlatforms[number];
export const accountIndex = (platform: AccountPlatform) => `people_${platform}_account`;
export const accountColumns = (platform: AccountPlatform) => [
  `json_extract(card_json, '$.where.${platform}_workspace.value')`,
  `json_extract(card_json, '$.where.${platform}.value')`,
] as const;

// Scoped card values can name several accounts. Each can identify its holder on
// an Inbox card; choosing where to send a message still requires a single text value.
export function accountHolders(db: Database, platform: AccountPlatform, workspace: string, user: string) {
  const [space, account] = accountColumns(platform);
  const path = `'$.where.${platform}.value'`;
  return db.prepare(`SELECT slug, json_extract(card_json, '$.name') AS name FROM people
    WHERE archived_at IS NULL AND json_valid(card_json) AND ${space}=? AND
    ((json_type(card_json, ${path})='text' AND ${account}=?) OR
     (json_type(card_json, ${path})='array' AND EXISTS
       (SELECT 1 FROM json_each(card_json, ${path}) WHERE type='text' AND value=?))) LIMIT 2`)
    .all(workspace,user,user) as {slug:string;name:string}[];
}
