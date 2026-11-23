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

const slackAccount=/^[UW][A-Z0-9]{8,}$/;

/** An older Slack card may contain the account in prose. Only the explicit registry
 * can supply its missing workspace. Multiple cards naming the same token veto a match. */
export function legacySlackHolder(db:Database, workspace:string, user:string, scope:'registry-import'|'workspace'='registry-import'): string|undefined {
  if(!slackAccount.test(user))return;
  const rows=db.prepare(`SELECT slug, json_extract(card_json,'$.where.slack_workspace.value') AS workspace,
    json_extract(card_json,'$.where.slack.value') AS value FROM people
    WHERE archived_at IS NULL AND json_valid(card_json) AND instr(json_extract(card_json,'$.where.slack.value'),?)>0`).all(user) as
    {slug:string;workspace:string|null;value:string}[];
  const token=new RegExp(`(?<![a-zA-Z0-9_])${user}(?![a-zA-Z0-9_])`);
  const holders=rows.filter(row=>token.test(row.value) && (scope==='registry-import' || row.workspace===null || row.workspace===workspace));
  if(holders.length===1&&(holders[0].workspace===null||holders[0].workspace===workspace))return holders[0].slug;
}

/** A registry-derived match applies only to sightings. An outbound address still requires a single scoped account value. */
export function sightingHolder(db:Database, platform:AccountPlatform, workspace:string, user:string):string|undefined {
  const scoped=accountHolders(db,platform,workspace,user).map(row=>row.slug);
  const alias=platform==='slack'
    ? db.prepare('SELECT slug FROM person_sighting_aliases WHERE workspace=? AND account=?').get(workspace,user) as {slug:string}|undefined
    : undefined;
  return resolveSightingHolder(scoped,alias?.slug,alias?legacySlackHolder(db,workspace,user,'workspace'):undefined);
}

function resolveSightingHolder(scoped:string[],alias:string|undefined,live:string|undefined){
  if(alias){
    if(live===alias && scoped.every(slug=>slug===alias))return live;
    if(scoped.length===1 && live===scoped[0])return live;
    return;
  }
  return scoped.length===1?scoped[0]:undefined;
}

interface SightingRow {platform:AccountPlatform;workspace:string;account:string;label:string|null;seenAt:string;alias:string|null}
interface Candidates {row:SightingRow;scoped:string[];legacy:string[]}

/** Within a card read transaction, validate every saved sighting against current cards.
 * Read the cards of each relevant workspace once; several accounts may name one card.
 * Only a registry-backed Slack sighting also considers old, unscoped prose. */
export function listAccountSightings(db:Database,slug:string){
  const rows=db.prepare(`SELECT s.platform,s.workspace,s.account,s.label,s.seen_at AS seenAt,a.slug AS alias
    FROM person_account_sightings s LEFT JOIN person_sighting_aliases a
    ON s.platform='slack' AND a.workspace=s.workspace AND a.account=s.account
    WHERE s.slug=? ORDER BY s.seen_order DESC,s.platform,s.workspace,s.account`).all(slug) as SightingRow[];
  const matched=new Set<SightingRow>();
  for(const platform of accountPlatforms){
    const spaces=new Map<string,Map<string,Candidates>>();
    const aliases=new Map<string,Candidates[]>();
    for(const row of rows){
      if(row.platform!==platform)continue;
      const candidate:Candidates={row,scoped:[],legacy:[]};
      let accounts=spaces.get(row.workspace);
      if(!accounts){
        accounts=new Map();
        spaces.set(row.workspace,accounts);
      }
      accounts.set(row.account,candidate);
      if(row.alias && slackAccount.test(row.account)){
        const existing=aliases.get(row.account);
        if(existing)existing.push(candidate);
        else aliases.set(row.account,[candidate]);
      }
    }
    if(!spaces.size)continue;
    const [space,account]=accountColumns(platform);
    const cards=db.prepare(`SELECT slug,${space} AS workspace,${account} AS value,
      json_type(card_json,'$.where.${platform}.value') AS kind FROM people
      WHERE archived_at IS NULL AND json_valid(card_json) AND
      (${space} IN (SELECT value FROM json_each(?)) ${aliases.size?'OR '+space+' IS NULL':''})
      AND ${account} IS NOT NULL`).iterate(JSON.stringify([...spaces.keys()])) as Iterable<
        {slug:string;workspace:string|null;value:string|number;kind:string}>;
    for(const card of cards){
      const accounts=card.workspace!==null?spaces.get(card.workspace):undefined;
      if(accounts&&(card.kind==='array'||card.kind==='text')){
        const value:unknown=card.kind==='array'?JSON.parse(String(card.value)):card.value;
        const values=Array.isArray(value)?value:[value];
        for(const id of new Set(values)){
          if(typeof id==='string')accounts.get(id)?.scoped.push(card.slug);
        }
      }
      if(aliases.size){
        // Same ASCII token boundary as legacySlackHolder, including repeated tokens on a card.
        for(const id of new Set(String(card.value).match(/[a-zA-Z0-9_]+/g))){
          for(const item of aliases.get(id)??[]){
            if(card.workspace===null||card.workspace===item.row.workspace)item.legacy.push(card.slug);
          }
        }
      }
    }
    for(const accounts of spaces.values()){
      for(const {row,scoped,legacy} of accounts.values()){
        const live=legacy.length===1?legacy[0]:undefined;
        if(resolveSightingHolder(scoped,row.alias??undefined,live)===slug)matched.add(row);
      }
    }
  }
  return rows.filter(row=>matched.has(row)).map(({alias:_alias,...row})=>row);
}
