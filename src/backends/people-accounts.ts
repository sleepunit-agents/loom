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

/** Resolve the current holder of a sighting. Recipient display requires its separate approval for that same slug. */
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
type AccountLookup=Pick<SightingRow,'platform'|'workspace'|'account'|'alias'>;
interface Candidates<T extends AccountLookup> {row:T;scoped:string[];legacy:string[]}

/** Within a card read transaction, validate every saved sighting against current cards.
 * Read the cards of each relevant workspace once; several accounts may name one card.
 * Only a registry-backed Slack sighting also considers old, unscoped prose. */
export function listAccountSightings(db:Database,slug:string){
  const rows=db.prepare(`SELECT s.platform,s.workspace,s.account,s.label,s.seen_at AS seenAt,a.slug AS alias
    FROM person_account_sightings s LEFT JOIN person_sighting_aliases a
    ON s.platform='slack' AND a.workspace=s.workspace AND a.account=s.account
    WHERE s.slug=? ORDER BY s.seen_order DESC,s.platform,s.workspace,s.account`).all(slug) as SightingRow[];
  const matches=matchAccounts(db,rows);
  return rows.filter(row=>matches.get(row)?.holder===slug).map(({alias:_alias,...row})=>row);
}

function matchAccounts<T extends AccountLookup>(db:Database,rows:T[]){
  const matches=new Map<T,{scoped?:string;holder?:string}>();
  for(const platform of accountPlatforms){
    const spaces=new Map<string,Map<string,Candidates<T>>>();
    // Keep at most two distinct slugs. A third cannot restore a unique match.
    const unscoped=new Map<string,string[]>();
    for(const row of rows){
      if(row.platform!==platform)continue;
      const candidate:Candidates<T>={row,scoped:[],legacy:[]};
      let accounts=spaces.get(row.workspace);
      if(!accounts){
        accounts=new Map();
        spaces.set(row.workspace,accounts);
      }
      accounts.set(row.account,candidate);
      if(row.alias && slackAccount.test(row.account)){
        if(!unscoped.has(row.account))unscoped.set(row.account,[]);
      }
    }
    if(!spaces.size)continue;
    const [space,account]=accountColumns(platform);
    const cards=db.prepare(`SELECT slug,${space} AS workspace,${account} AS value,
      json_type(card_json,'$.where.${platform}.value') AS kind FROM people
      WHERE archived_at IS NULL AND json_valid(card_json) AND
      (${space} IN (SELECT value FROM json_each(?)) ${unscoped.size?'OR '+space+' IS NULL':''})
      AND ${account} IS NOT NULL`).iterate(JSON.stringify([...spaces.keys()])) as Iterable<
        {slug:string;workspace:string|null;value:string|number;kind:string}>;
    for(const card of cards){
      const accounts=card.workspace!==null?spaces.get(card.workspace):undefined;
      if(accounts&&(card.kind==='array'||card.kind==='text')){
        const value:unknown=card.kind==='array'?JSON.parse(String(card.value)):card.value;
        const values=Array.isArray(value)?value:[value];
        for(const id of new Set(values)){
          const found=typeof id==='string'?accounts.get(id):undefined;
          if(found && found.scoped.length<2)found.scoped.push(card.slug);
        }
      }
      if(unscoped.size){
        // Same ASCII token boundary as legacySlackHolder, including repeated tokens on a card.
        for(const id of new Set(String(card.value).match(/[a-zA-Z0-9_]+/g))){
          if(!unscoped.has(id))continue;
          const candidates=card.workspace===null?unscoped.get(id):accounts?.get(id)?.legacy;
          if(candidates && candidates.length<2)candidates.push(card.slug);
        }
      }
    }
    for(const accounts of spaces.values()){
      for(const {row,scoped,legacy} of accounts.values()){
        const tokens=row.alias?[...legacy,...(unscoped.get(row.account)??[])]:[];
        const live=tokens.length===1?tokens[0]:undefined;
        matches.set(row,{scoped:scoped.length===1?scoped[0]:undefined,holder:resolveSightingHolder(scoped,row.alias??undefined,live)});
      }
    }
  }
  return matches;
}

export function approvedSlackRecipient(db:Database,workspace:string,user:string):string|undefined{
  const alias=db.prepare(`SELECT a.slug,json_extract(p.card_json,'$.name') AS name
  FROM person_sighting_aliases a JOIN people p ON p.slug=a.slug
  WHERE a.workspace=? AND a.account=? AND a.recipient_display_slug=a.slug AND p.archived_at IS NULL`).get(workspace,user) as {slug:string;name:string}|undefined;
  if (alias && sightingHolder(db,'slack',workspace,user)===alias.slug) return alias.name;
}

/** Resolve a page of owner-visible Slack recipients against one directory snapshot. */
export function slackGrantDirectory(db:Database,accounts:{workspace:string;user:string}[]){
  const keys=new Map(accounts.map(({workspace,user})=>[JSON.stringify([workspace,user]),{platform:'slack' as const,workspace,account:user,alias:null as string|null}]));
  const rows=[...keys.values()];
  const names=new Map<string,{name:string;alias:boolean}>();
  if(!rows.length)return names;
  // One unresolved recipient can use the existing point lookup without decoding unrelated cards.
  if(rows.length===1){
    const {workspace,account}=rows[0]!;
    const direct=accountHolders(db,'slack',workspace,account);
    const name=direct.length===1?direct[0]?.name:undefined;
    const key=JSON.stringify([workspace,account]);
    if(name)names.set(key,{name,alias:false});
    else{
      try{
        const alias=approvedSlackRecipient(db,workspace,account);
        if(alias)names.set(key,{name:alias,alias:true});
      }catch{ /* An unavailable alias cannot supply a recipient. */ }
    }
    return names;
  }
  // Older directories may have only the People cards. An unreadable alias source
  // has no bearing on an exact, scoped account recorded on a healthy card.
  try{
    const approved=db.prepare(`SELECT a.workspace,a.account,a.slug FROM json_each(?) r JOIN person_sighting_aliases a
      ON a.workspace=json_extract(r.value,'$.workspace') AND a.account=json_extract(r.value,'$.account') AND a.recipient_display_slug=a.slug`).all(JSON.stringify(rows)) as {workspace:string;account:string;slug:string}[];
    for(const alias of approved)keys.get(JSON.stringify([alias.workspace,alias.account]))!.alias=alias.slug;
  }catch{ /* Only verified aliases participate in the legacy search. */ }
  const matches=matchAccounts(db,rows);
  const selected=new Map<string,{slug:string;alias:boolean}>();
  for(const [key,row] of keys){
    const match=matches.get(row);
    if(match?.scoped)selected.set(key,{slug:match.scoped,alias:false});
    else if(row.alias && row.alias===match?.holder)selected.set(key,{slug:row.alias,alias:true});
  }
  if(!selected.size)return names;
  const slugs=JSON.stringify([...new Set([...selected.values()].map(person=>person.slug))]);
  const labels=db.prepare(`SELECT slug,json_extract(card_json,'$.name') AS name FROM people
    WHERE archived_at IS NULL AND json_valid(card_json) AND slug IN (SELECT value FROM json_each(?))`).all(slugs) as {slug:string;name:string}[];
  const bySlug=new Map(labels.map(row=>[row.slug,row.name]));
  for(const [key,person] of selected){
    const name=bySlug.get(person.slug);
    if(name)names.set(key,{name,alias:person.alias});
  }
  return names;
}
