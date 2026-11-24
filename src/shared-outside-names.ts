/** The names loom already holds for outside accounts, channels and workspaces: the one place a proposal card
 * asks "who is U07V8CZUC1J?" (shared-household-proposals.ts, household.proposalPreview).
 *
 * The owner-only preview reads person links and connections (policy.ts, `bridgePeople` and
 * `bridgeConnections`) and labels of shared conversations without a member or direct-message scope.
 *
 * Names come from indexed person links, the people directory, and retained channel labels.
 * A workspace can be identified by a connection configured for its exact platform and id.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { agents, bridgeConnections, bridgeIncoming, bridgePeople, conversations } from './core/data/schema.js';
import { outsidePersonKey } from './pieces/bridges/keys.js';
import { slackRoomLabel } from './pieces/bridges/place.js';
import type { CardNames, HeldName, SlackInboxName, SlackAccount } from './proposal-words.js';

export function outsideNames(db: DataDatabase, directory?: (platform: 'slack' | 'discord', workspace: string, user: string) => string | undefined): CardNames {
  const people = new Map<string, HeldName | null>();
  return {
    person(platform, workspace, user): HeldName | null {
      if (platform !== 'slack' && platform !== 'discord') return null;
      const account = outsidePersonKey(platform, workspace, user);
      const cached = people.get(account);
      if (cached !== undefined) return cached;
      const link = db.select({ member: bridgePeople.member }).from(bridgePeople)
        .where(and(eq(bridgePeople.platform, platform), eq(bridgePeople.workspace, workspace), eq(bridgePeople.user, user))).get();
      const name = link?.member ?? directory?.(platform, workspace, user);
      const held = name ? { name, source: link ? 'Household person link for this account' : 'People directory record for this account' } : null;
      people.set(account, held);
      return held;
    },
    channel(platform, workspace, channel): HeldName | null {
      if (platform === 'slack') {
        // The third place component is the thread. Restrict the indexed place range to this exact room.
        const prefix = JSON.stringify([workspace, channel]).slice(0, -1);
        const row = db.select({label: conversations.label}).from(conversations)
          .where(and(inArray(conversations.agent, db.select({id: agents.id}).from(agents)),
            eq(conversations.venue, 'slack'), isNull(conversations.member), eq(conversations.direct, false),
            sql`${conversations.place} >= ${prefix + ','} and ${conversations.place} < ${prefix + '-'}`,
            sql`case when json_valid(${conversations.place}) then json_array_length(${conversations.place}) = 3 else 0 end`,
            sql`substr(${conversations.label}, 1, ${slackRoomLabel.length}) = ${slackRoomLabel}`))
          .orderBy(desc(conversations.lastAt), conversations.id).limit(1).get();
        return row ? {name: '#' + row.label.slice(slackRoomLabel.length), source: 'The channel name from Slack'} : null;
      }
      if (platform !== 'discord') return null;
      const row = db.select({ label: conversations.label }).from(conversations).where(and(eq(conversations.venue, 'discord'), isNull(conversations.member), eq(conversations.direct, false),
        inArray(conversations.agent, db.select({ id: agents.id }).from(agents)),
        eq(conversations.place, JSON.stringify([workspace, channel, null])),
        sql`${conversations.label} like 'Discord channel #%'`, sql`${conversations.label} <> ${'Discord channel #' + channel}`)).orderBy(desc(conversations.lastAt), conversations.id).get();
      const directName = row?.label.slice('Discord channel '.length);
      if (directName) return { name: directName, source: 'The name Discord gave with a message from there' };
      const threads = db.selectDistinct({ label: conversations.label, lastAt: conversations.lastAt, id: conversations.id })
        .from(bridgeIncoming)
        .innerJoin(conversations, eq(conversations.id, bridgeIncoming.conversation))
        .where(and(eq(bridgeIncoming.parent, channel), eq(bridgeIncoming.isDm, false),
          sql`${conversations.place} = json_array(${workspace}, ${bridgeIncoming.channel}, ${bridgeIncoming.thread})`,
          eq(conversations.venue, 'discord'), isNull(conversations.member), eq(conversations.direct, false),
          inArray(conversations.agent, db.select({ id: agents.id }).from(agents)),
          sql`${conversations.label} like 'Discord thread #% under #%'`,
          sql`substr(${conversations.label}, -length(${' under #' + channel})) <> ${' under #' + channel}`))
        .orderBy(desc(conversations.lastAt), conversations.id).get();
      const held = threads?.label.slice(threads.label.lastIndexOf(' under #') + ' under '.length);
      return held ? { name: held, source: 'The parent channel name Discord gave with a thread message' } : null;
    },
    workspace(platform, workspace): HeldName | null {
      if (platform !== 'discord' && platform !== 'slack') return null;
      const connection = db.select({ id: bridgeConnections.id }).from(bridgeConnections)
        .where(and(eq(bridgeConnections.platform, platform), eq(bridgeConnections.workspace, workspace), isNull(bridgeConnections.removedAt)))
        .orderBy(bridgeConnections.id).get();
      return connection ? { name: connection.id, source: 'reached by the connection' } : null;
    },
  };
}

/** Match exact workspace/user pairs through the bridge's existing account link before consulting the directory. */
export function slackGrantNames(db:DataDatabase,accounts:SlackAccount[],directory:(missing:SlackAccount[])=>Map<string,{name:string;alias:boolean}>){
  const distinct=new Map(accounts.map(account=>[JSON.stringify([account.workspace,account.user]),account]));
  const result=new Map<string,SlackInboxName>();
  const links=db.select({workspace:bridgePeople.workspace,user:bridgePeople.user,member:bridgePeople.member}).from(bridgePeople)
    .where(and(eq(bridgePeople.platform,'slack'),sql`(${bridgePeople.workspace}, ${bridgePeople.user}) IN
      (SELECT json_extract(value,'$.workspace'), json_extract(value,'$.user') FROM json_each(${JSON.stringify([...distinct.values()])}))`)).all();
  for(const link of links){
    const key=JSON.stringify([link.workspace,link.user]);
    result.set(key,{name:link.member,via:'link',source:'Household person link for this account'});
    distinct.delete(key);
  }
  if(distinct.size){
    let records:ReturnType<typeof directory>;
    try{records=directory([...distinct.values()]);}
    catch{return result;} // A missing directory cannot take away a known bridge link.
    for(const [key,entry] of records){
      result.set(key,{name:entry.name,via:entry.alias?'alias':'directory',source:entry.alias?'People directory match used for Last seen':'People directory record for this account'});
    }
  }
  return result;
}
