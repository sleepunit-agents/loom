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

/** An older Slack card may contain the account in prose. Only the explicit registry
 * can supply its missing workspace. Multiple cards naming the same token veto a match. */
export function legacySlackHolder(db:Database, workspace:string, user:string): string|undefined {
  if(!/^[UW][A-Z0-9]{8,}$/.test(user))return;
  const rows=db.prepare(`SELECT slug, json_extract(card_json,'$.where.slack_workspace.value') AS workspace,
    json_extract(card_json,'$.where.slack.value') AS value FROM people
    WHERE archived_at IS NULL AND json_valid(card_json) AND instr(json_extract(card_json,'$.where.slack.value'),?)>0`).all(user) as
    {slug:string;workspace:string|null;value:string}[];
  const token=new RegExp(`(?<![a-zA-Z0-9_])${user}(?![a-zA-Z0-9_])`);
  const holders=rows.filter(row=>token.test(row.value));
  if(holders.length===1&&(holders[0].workspace===null||holders[0].workspace===workspace))return holders[0].slug;
}

/** A registry-derived match applies only to sightings. Outgoing messages use accountHolders. */
export function sightingHolder(db:Database, platform:AccountPlatform, workspace:string, user:string):string|undefined {
  const scoped=accountHolders(db,platform,workspace,user);
  if(platform==='slack'){
    const alias=db.prepare('SELECT slug FROM person_sighting_aliases WHERE workspace=? AND account=?').get(workspace,user) as {slug:string}|undefined;
    if(alias){
      if(legacySlackHolder(db,workspace,user)!==alias.slug || scoped.some(row=>row.slug!==alias.slug))return;
      return alias.slug;
    }
  }
  return scoped.length===1?scoped[0].slug:undefined;
}
