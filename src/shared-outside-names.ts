/** The names loom already holds for outside accounts, channels and workspaces: the one place a proposal card
 * asks "who is U07V8CZUC1J?" (shared-household-proposals.ts, household.proposal).
 *
 * It answers for a household owner reading a card, and reads only what that owner may read (policy.ts): person
 * links, channel rules and connections are a household owner's (`bridgePeople`, `bridgeConnections`); a shared
 * channel's conversation label is too (rule `conversation`: no member, not direct); person cards are read
 * through the people reader as the owner, so a card the owner may not open gives no name.
 *
 * It never calls Slack or Discord, and it never guesses: an account is named by a person link, or by a person
 * card whose own `where` field for that platform holds exactly that account id. Two cards that name the same
 * account differently name nobody. What loom holds nowhere, and so what this never returns:
 *  - a Slack or Discord user's display name (the bridges do not fetch profiles; normalize.ts keeps the id);
 *  - a Slack channel's name (only Discord sends a channel's name with a message; place.ts);
 *  - a workspace's or guild's name (bridge_connections keeps the id alone). A workspace is said by the
 *    connection that reaches it, which an owner named. */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { bridgeConnections, bridgePeople, conversations } from './core/data/schema.js';
import type { CardNames, HeldName } from './proposal-words.js';

/** A person card as far as naming goes: its name, whose it is (an agent's, or the household directory's), and its fields. */
export interface NamedCard { name: string; agent?: string; fields: ReadonlyArray<{ key: string; value: string }> }

const cap = (id: string) => id ? id[0]!.toUpperCase() + id.slice(1) : '';
/** Does this card field hold exactly this account id? The field is the platform's own (`slack`, `slack_id`, …),
 * and the id is one whole word of its value: `U07V8CZUC1J`, `@U07V8CZUC1J` or `<@U07V8CZUC1J>`. */
const holdsAccount = (field: { key: string; value: string }, platform: string, user: string) =>
  (field.key === platform || field.key.startsWith(platform + '_')) && field.value.split(/[\s,;]+/).some(word => word.replace(/^<?@?|>$/g, '') === user);

export function outsideNames(db: DataDatabase, cards: () => readonly NamedCard[], name: (id: string) => string = cap): CardNames {
  // Read once for one card, and only when a card names an outside account.
  let read: readonly NamedCard[] | undefined;
  const people = () => read ??= (() => { try { return cards(); } catch { return []; } })();
  return {
    person(platform, workspace, user): HeldName | null {
      const link = db.select({ member: bridgePeople.member }).from(bridgePeople)
        .where(and(eq(bridgePeople.platform, platform), eq(bridgePeople.workspace, workspace), eq(bridgePeople.user, user))).get();
      if (link) return { name: name(link.member), source: 'A person link: this account is the household member ' + link.member };
      const found = people().filter(card => card.name.trim() && card.fields.some(field => holdsAccount(field, platform, user)));
      const distinct = [...new Set(found.map(card => card.name.trim()))];
      if (distinct.length !== 1) return null;
      const from = found[0]!;
      return { name: distinct[0]!, source: from.agent ? cap(from.agent) + '’s person card, which lists this account' : 'The household’s people directory, which lists this account' };
    },
    channel(platform, workspace, channel): HeldName | null {
      // Discord sends a channel's name with each message, and the conversation's label keeps it ("Discord channel
      // #pond"). A Slack conversation's label is the channel id, so Slack channels have no name here.
      if (platform !== 'discord') return null;
      const row = db.select({ label: conversations.label }).from(conversations).where(and(eq(conversations.venue, 'discord'), isNull(conversations.member), eq(conversations.direct, false),
        sql`json_valid(${conversations.place})`, sql`json_extract(${conversations.place}, '$[0]') = ${workspace}`, sql`json_extract(${conversations.place}, '$[1]') = ${channel}`,
        sql`json_extract(${conversations.place}, '$[2]') is null`, sql`${conversations.label} like 'Discord channel #%'`)).orderBy(desc(conversations.lastAt), conversations.id).get();
      const held = row?.label.slice('Discord channel '.length);
      return held && held !== '#' + channel ? { name: held, source: 'The name Discord gave with a message from there' } : null;
    },
    workspace(platform, workspace): HeldName | null {
      const ids = db.select({ id: bridgeConnections.id }).from(bridgeConnections)
        .where(and(eq(bridgeConnections.platform, platform as 'discord' | 'slack'), eq(bridgeConnections.workspace, workspace), isNull(bridgeConnections.removedAt))).all().map(row => row.id).sort();
      return ids.length ? { name: ids.join(', '), source: ids.length === 1 ? 'reached by the connection' : 'reached by the connections' } : null;
    },
  };
}
