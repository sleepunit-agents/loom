/** A household proposal card in plain words: one sentence saying what would change and for whom, and a short list
 * of plain facts. Never raw JSON, never an internal key.
 *
 * Pure: it reads nothing. The program, the `approvals` tool and the web all say a card through this one function,
 * so a card reads the same wherever it is met. It is given the change asked for (which is on the card, for
 * everyone who may read the card) and, for a household owner only, two things that are not on the card: what the
 * change would replace (`before`), and the names loom holds for the outside accounts, channels and workspaces it
 * mentions (`names`). Without them it says only what the card itself says: an id stays an id, and nothing about
 * what is there now is said (shared-household-proposals.ts, the file header: proposing must not be a way to read).
 *
 * It never guesses a name. Where an owner is reading and loom holds none, it says so in words. */
import { outsideTierMayReceiveDirect } from './policy.js';
import { parseOutsidePersonKey } from './pieces/bridges/keys.js';
import { TRACE_KEEP_DAYS } from './core/conversations/trace-keep-days.js';

export interface CardFact { label: string; value: string; /** A raw id kept for certainty: drawn small, and last. */ small?: boolean }
/** A name loom already holds, and where it came from. */
export interface HeldName { name: string; source: string }
export interface SlackAccount {workspace:string;user:string}
export interface SlackInboxName extends HeldName {
  via: 'link' | 'directory' | 'alias';
}
export interface InboxCardNames extends CardNames {
  slackGrantNames(accounts:SlackAccount[]):Map<string,SlackInboxName>;
}
export interface CardNames {
  /** The name held for an outside account, or null when loom holds none. */
  person(platform: string, workspace: string, user: string): HeldName | null;
  /** Display-only fallback for the recipient of an owner-visible Slack access request. */
  slackRecipient?(workspace: string, user: string): string | undefined;
  channel(platform: string, workspace: string, channel: string): HeldName | null;
  workspace(platform: string, workspace: string): HeldName | null;
}
export interface CardContext {
  /** Present only for a household owner. */
  names?: CardNames;
  /** `known` says an owner's reading of what is there now was made; `value` is it (null: nothing there yet). */
  before?: { value: unknown };
  /** A member's or an agent's display name. Without it, the id with a capital. */
  name?(id: string): string;
  projectName?(id: string): string | undefined;
  machineName?(id: string): string | undefined;
  allAgents?: readonly string[];
}
export interface ProposalCard {
  /** One sentence, with no full stop: the card's title, and its question with a question mark. */
  title: string;
  facts: CardFact[];
  /** What allowing and denying do, where this kind has words of its own for them. */
  ifYes?: string; ifNo?: string;
  /** True when an owner's reading shows the change is already so. */
  nothing: boolean;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => arr(value).map(str).filter(Boolean);
const cap = (id: string) => id ? id[0]!.toUpperCase() + id.slice(1) : '';
const owns = (name: string) => name + (name.endsWith('s') ? '’' : '’s');
const platformWord = (platform: string) => platform === 'slack' ? 'Slack' : platform === 'discord' ? 'Discord' : cap(platform);
const count = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const yes = (value: unknown) => value ? 'Yes' : 'No';

interface Told { title: string; facts: CardFact[]; ifYes?: string; ifNo?: string; nothing?: boolean }
type Outside = { platform: string; workspace: string; user: string };
export function outsideCardName(change:string, who:Outside, names?:CardNames):HeldName|null {
  const linked = names?.person(who.platform, who.workspace, who.user);
  if (linked) return linked;
  if (who.platform !== 'slack' || !['kitGrant', 'colleague', 'projectOutsidePerson'].includes(change)) return null;
  const recipient = names?.slackRecipient?.(who.workspace, who.user);
  return recipient ? { name: recipient, source: 'People directory match used for Last seen' } : null;
}
export function outsideShort(who:Outside,held:HeldName|null,names?:CardNames){
  const platform=platformWord(who.platform);
  return held ? held.name + ' (' + platform + ')'
      : names && who.platform === 'slack' ? 'an unnamed Slack account'
      : names ? 'a ' + platform + ' account loom has no name for (' + who.user + ' in workspace ' + who.workspace + ')'
      : 'the ' + platform + ' account ' + who.user + ' (workspace ' + who.workspace + ')';
}
export function bridgeDisconnectTitle(id:string, agent:string, platform:string) {
  return clipProposalText('Disconnect '+owns(agent)+' '+platform+' connection ('+id+')',240);
}
export function bridgePersonTitle(whom:string, remove:boolean, member?:string) {
  if (remove) return 'Stop treating ' + whom + ' as ' + (member ? 'the household member ' + member : 'a household member');
  return 'Treat ' + whom + ' as the household member ' + member;
}
export function colleagueTitle(whom:string,tier:string,agent:string,project?:string,on?:boolean){
  const rosterAction=on===undefined?' and include them on ':on?' and keep them on ':' and add them to ';
  return 'Set '+whom+' to tier '+tier+' with '+agent+(project?rosterAction+'the '+project+' kit roster':'');
}
export function outsideProjectTitle(whom:string,project:string,on:boolean){
  return on?'Add '+whom+' to the project '+project:'Remove '+whom+' from the project '+project;
}
function kitGrantTitle(grant:boolean,whom:string,whose:string){
  return grant ? 'Let ' + whom + ' use ' + whose : 'Stop letting ' + whom + ' use ' + whose;
}
export function outsideKitGrantTitle(grant:boolean,agent:string,kit:string,who:Outside,held:HeldName|null,names:CardNames){
  return clipProposalText(kitGrantTitle(grant,outsideShort(who,held,names),owns(agent)+' '+kit+' kit'),240);
}
type ChangeRow = [label: string, was: string | undefined, asked: string, equal?: boolean];
const sameValue = (before: unknown, after: unknown) => JSON.stringify(before) === JSON.stringify(after);

export const clipProposalText = (text: string, limit: number): string =>
  text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';

const workspaceWords = (names: CardNames | undefined, platform: string, workspace: string): string => {
  if (!names) return str(workspace);
  const connection = names.workspace(platform, workspace);
  if (platform === 'slack') return connection ? 'Slack connection ' + connection.name : 'Unnamed Slack workspace';
  return 'A workspace loom has no name for (' + workspace + ')' +
    (connection ? ', ' + connection.source + ' ' + connection.name : '');
};

const FACT_LIMIT = 1500;
const ITEM_LIMIT = 10;
export function clipWithCount(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let prefix = value.slice(0, limit - 32).replace(/[\uD800-\uDBFF]$/, '');
  const suffix = () => '…(+' + (value.length - prefix.length) + ' more characters)';
  prefix = value.slice(0, limit - suffix().length).replace(/[\uD800-\uDBFF]$/, '');
  return prefix + suffix();
}
function displayList(values: string[], none: string, separator: string, limit = FACT_LIMIT, total = values.length): string {
  const shown: string[] = [];
  let length = 0;
  for (const value of values) {
    const item = clipWithCount(value, limit - 40);
    if (length + item.length + separator.length > limit - 32) break;
    shown.push(item);
    length += item.length + separator.length;
  }
  if (shown.length < total) shown.push('and ' + (total - shown.length) + ' more');
  return shown.length ? shown.join(separator) : none;
}
const list = (values: string[], none = 'None') => displayList(values, none, ', ');
const numbered = (values: string[], none = 'None') => displayList(values.map((value, index) => (index + 1) + '. ' + value), none, '\n');

function shownItems<T>(items: T[], label: string, describe: (item: T, index: number) => CardFact[]): CardFact[] {
  const shown = items.slice(0, ITEM_LIMIT).flatMap(describe);
  if (items.length > ITEM_LIMIT) shown.push({ label, value: 'and ' + (items.length - ITEM_LIMIT) + ' more' });
  return shown;
}
const NOTHING = 'Nothing would change: it is already like this.';

/** Field by field: with an owner's reading of what is there, only what differs, as before and after. */
function changes(before: { value: unknown } | undefined, rows: ChangeRow[]): { facts: CardFact[]; nothing: boolean } {
  if (!before || before.value === null) return { facts: rows.map(([label, , asked]) => ({ label, value: asked })), nothing: false };
  // A value of several lines is said twice, as it is now and as it would be: an arrow between two lists reads badly.
  const facts = rows.filter(([, was, asked, equal]) => !(equal ?? was === asked)).flatMap(([label, was, asked]): CardFact[] => (was ?? '').includes('\n') || asked.includes('\n') || (was?.length ?? 0) + asked.length + 3 > FACT_LIMIT
    ? [{ label: label + ', now', value: was ?? 'Not set' }, { label: label + ', if allowed', value: asked }] : [{ label, value: (was ?? 'Not set') + ' → ' + asked }]);
  return facts.length ? { facts, nothing: false } : { facts: [{ label: 'What changes', value: NOTHING }], nothing: true };
}

export function proposalCard(change: string, rawInput: unknown, context: CardContext = {}): ProposalCard | undefined {
  try {
    const told = tell(change, rec(rawInput), context);
    if (!told) return undefined;
    return { title: clipProposalText(told.title, 240), facts: told.facts.filter(fact => fact.value !== '').map(fact => ({ ...fact, value: clipProposalText(fact.value, FACT_LIMIT) })), nothing: !!told.nothing,
      ...(told.ifYes ? { ifYes: clipProposalText(told.ifYes, FACT_LIMIT) } : {}), ...(told.ifNo ? { ifNo: clipProposalText(told.ifNo, FACT_LIMIT) } : {}) };
  } catch { return undefined; }
}

function tell(change: string, input: Rec, context: CardContext): Told | undefined {
  const { names, before } = context;
  const name = (id: unknown) => context.name?.(str(id)) ?? (before ? cap(str(id)) : str(id));
  const projectName = (id: unknown) => context.projectName?.(str(id)) ?? str(id);
  const machineName = (id: unknown) => context.machineName?.(str(id)) ?? str(id);
  const was = before && before.value !== null ? rec(before.value) : undefined;
  const isNew = !!before && before.value === null;
  const field = (label: string, key: string, format: (value: unknown) => string): ChangeRow =>
    [label, was && format(was[key]), format(input[key]), sameValue(was?.[key], input[key])];

  /** An outside account: the name loom holds, or, for an owner, that it holds none; otherwise just the id. */
  const outside = (who: Outside) => {
    const platform = platformWord(who.platform);
    const held = outsideCardName(change, who, names);
    const short = outsideShort(who,held,names);
    const facts: CardFact[] = [
      { label: 'Who', value: held ? held.name + ', on ' + platform : names ? cap(short) : 'A ' + platform + ' account' },
      ...(held ? [{ label: 'Name from', value: held.source }] : []),
      { label: 'Workspace', value: workspaceWords(names, who.platform, who.workspace) },
      ...(names && who.platform === 'slack' ? [{label: 'Workspace id', value: who.workspace, small: true}] : []),
    ];
    return { short, facts, id: { label: 'Account id', value: str(who.user), small: true } as CardFact };
  };
  const channel = (platform: string, workspace: string, id: string) => {
    const held = names?.channel(platform, workspace, id) ?? null;
    if (platform === 'slack' && names && !held) return {short:'an unnamed Slack channel', held};
    return { short: (held ? held.name : names ? 'a channel loom has no name for (' + id + ')' : 'the channel ' + id) + ' on ' + platformWord(platform), held };
  };
  const tools = (value: unknown, label: string) => shownItems(arr(value).map(rec), label,
    tool => [{ label, value: clipWithCount(str(tool.name) + ': ' + str(tool.description), FACT_LIMIT) }]);

  switch (change) {
    case 'placeSchedule': {
      const setting = input.action === 'set', requested = rec(setting ? input.trigger : input.change);
      const asker = rec(input.asker), address = parseOutsidePersonKey(str(asker.id));
      const account = asker.kind === 'outside' && address ? outside(address) : undefined;
      const askedBy = asker.kind === 'member' ? name(asker.id) : account?.short ?? 'An outside account';
      const fields: [string, string, (value: unknown) => string][] = [
        ['Times', 'times', str], ['Days', 'days', value => str(value) || 'Every day'],
        ['Lifespan', 'lifespan', value => value === 'today' ? 'Today only' : 'Until stopped'],
        ['Note from the asker', 'note', str], ['Instructions for each firing', 'instructions', str],
        ['Requested model', 'wantsModel', value => str(value) || 'Default'],
        ['Machine needs', 'needs', value => list(strings(value))],
        ['Machine preferences', 'prefers', value => value === null ? 'Inherit from the agent' : list(strings(value))],
      ];
      const facts = fields.flatMap(([label, key, format]) => {
        const value = requested[key] === undefined ? was?.[key] : requested[key];
        if (value === undefined) return [];
        const previous = was?.[key];
        return [{ label, value: previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)
          ? format(previous) + ' → ' + format(value) : format(value) }];
      });
      return { title: (setting ? 'Set a repeating schedule for ' + name(input.agent)
        : 'Change the repeating schedule ' + str(input.id) + ' for ' + name(input.agent)) + (names && address?.platform === 'slack' && account ? ', requested by ' + askedBy : ' in conversation ' + str(input.conversation)),
        facts: [{ label: 'Asked by', value: askedBy }, ...(names && address?.platform === 'slack' && account ? [{label:'Conversation id',value:str(input.conversation),small:true}] : []), { label: 'Place', value: str(input.place) }, ...facts, ...(account ? [...account.facts.filter(fact => fact.label !== 'Who'), account.id] : [])],
        ifYes: setting ? 'Each firing starts a job in that conversation on the asker’s word, with loom’s tools only.'
          : 'The schedule changes as shown and continues on the asker’s word.',
        ifNo: setting ? 'No schedule is set.' : 'The schedule stays as it is.' };

    }
    case 'kit': {
      const agent = name(input.agent), kit = str(input.kit), next = input.tools === null ? null : arr(input.tools).map(rec);
      const had = was ? was.tools : undefined;
      const facts: CardFact[] = [{ label: 'Agent', value: agent }, { label: 'Kit', value: kit }];
      const commands = (value: unknown, now: boolean) => {
        const label = now ? 'Tool now' : 'Tool';
        return shownItems(arr(value).map(rec), label, tool => {
          const args = arr(tool.args);
          const secrets = Object.entries(rec(tool.secrets));
          return [
            { label, value: clipWithCount(str(tool.name) + ': ' + str(tool.description), FACT_LIMIT) },
            { label: now ? 'Runs now' : 'Runs', value: clipWithCount(JSON.stringify(str(tool.program)), FACT_LIMIT) },
            ...(args.length ? shownItems(args, 'Arguments', (arg, index) => [{
              label: 'Argument ' + (index + 1),
              value: typeof arg === 'string' ? JSON.stringify(clipWithCount(arg, 240)) : 'Parameter ' + JSON.stringify(str(rec(arg).parameter)),
            }]) : [{ label: 'Arguments', value: 'None' }]),
            { label: 'Code it runs', value: clipWithCount(str(tool.repository) + ' at commit ' + str(tool.commit).slice(0, 12) + ', image ' + str(tool.image).replace(/^sha256:/, '').slice(0, 12), FACT_LIMIT) },
            ...(secrets.length ? shownItems(secrets, 'Secrets handed to it', ([alias, secret]) =>
              [{ label: 'Secret handed to it', value: clipWithCount(str(secret) + ' as ' + alias, FACT_LIMIT) }])
              : [{ label: 'Secrets handed to it', value: 'None' }]),
          ];
        });
      };
      if (next) facts.push(...commands(next, false));
      if (was) {
        if (had) facts.push(...commands(had, true));
        facts.push({ label: 'Now', value: had ? 'The kit has ' + count(arr(had).length, 'tool') + '.' : 'There is no such kit yet.' });
        const granted = [count(arr(was.projects).length, 'project'), count(arr(was.members).length, 'member'), count(arr(was.outside).length, 'outside account')];
        if (had) facts.push({ label: 'Granted to now', value: granted.join(', ') });
      }
      const same = !!was && JSON.stringify(had ?? null) === JSON.stringify(input.tools);
      if (same) facts.push({ label: 'What changes', value: NOTHING });
      const title = next === null ? 'Remove ' + owns(agent) + ' ' + kit + ' kit' : was && had ? 'Change the tools in ' + owns(agent) + ' ' + kit + ' kit'
        : 'Give ' + agent + ' a kit called ' + kit + ', with ' + count(next.length, 'tool');
      return { title, facts, nothing: same, ifYes: next === null ? 'The kit is removed, and nobody can use it.' : 'The kit’s grants stay in place and point to this tool list.', ifNo: 'The kit stays as it is.' };
    }
    case 'kitGrant': {
      const agent = name(input.agent), kit = str(input.kit), to = rec(input.to), grant = !!input.grant;
      const whose = owns(agent) + ' ' + kit + ' kit';
      const facts: CardFact[] = [];
      let whom: string, applies: string, last: CardFact | undefined;
      if ('member' in to) {
        whom = name(to.member) + ' (a household member)';
        facts.push({ label: 'Who', value: name(to.member) + ', a member of this household' });
        applies = 'When ' + agent + ' works for ' + name(to.member) + '.';
      } else if ('project' in to) {
        whom = 'everyone on the project ' + projectName(to.project);
        facts.push({ label: 'Who', value: 'Everyone on the project ' + projectName(to.project) + (was ? ': ' + count(arr(was.members).length, 'member') + ' and ' + count(arr(was.outside).length, 'outside account') + ' now' : '') });
        applies = 'When ' + agent + ' works for somebody on that project, including people added to it later.';
      } else {
        const who = outside(to as Outside);
        whom = who.short; facts.push(...who.facts); last = who.id;
        applies = 'When ' + agent + ' works on that account’s word in an eligible conversation.';
      }
      facts.push({ label: 'Kit', value: kit + ', of ' + agent });
      if (was) facts.push(...(was.tools ? tools(was.tools, 'What the kit does') : [{ label: 'What the kit does', value: 'There is no kit by that name.' }]));
      facts.push({ label: 'Applies', value: applies });
      const same = !!was && was.on === grant;
      if (was) facts.push({ label: same ? 'What changes' : 'Now', value: same ? NOTHING : was.on ? 'This grant is in place.' : 'This grant is absent.' });
      if (last) facts.push(last);
      return { title: kitGrantTitle(grant,whom,whose), facts, nothing: same,
        ifYes: grant ? 'This grant makes the kit available for eligible work by ' + agent + '.' : 'This grant ends. Access through other grants stays in place.', ifNo: 'Who can use the kit stays as it is.' };
    }
    case 'colleague': {
      const who=outside(input as unknown as Outside),agent=name(input.agent),tier=str(input.tier);
      const project=input.project?projectName(input.project):undefined;
      const facts:CardFact[]=[...who.facts,{label:'Agent',value:agent},{label:'Interaction tier',value:was && was.tier!==input.tier?(was.tier===null?'New contact':'Tier '+str(was.tier))+' → Tier '+tier:'Tier '+tier}];
      facts.push({label:'Messages',value:'This account can start eligible conversations with '+agent+'. Its requests run with outside-contact permissions.'},
        {label:'Direct messages',value:outsideTierMayReceiveDirect(Number(input.tier))
          ? agent+' can initiate a Slack DM from eligible work when the account has a matching directory entry and connection.'
          : agent+' can reply in an eligible conversation. This tier does not permit initiating a Slack DM.'});
      if(project){
        facts.push({label:'Project kit roster',value:project});
        if(was){
          const grants=arr(was.grants).map(rec).map(grant=>owns(name(grant.agent))+' '+str(grant.kit)+' kit');
          facts.push({label:'Kits granted through this project',value:list(grants,'The project currently grants no kits.')});
        }
      }
      if(was?.returning){
        const returning=rec(was.returning);
        const earlier=[...arr(returning.direct).map(rec).map(grant=>str(grant.kit)+' (direct grant)'),
          ...arr(returning.inherited).map(rec).map(grant=>str(grant.kit)+' (via '+projectName(grant.project)+')')];
        if(earlier.length)facts.push({label:'Existing kit grants that become available',value:list(earlier)});
      }
      const roster=project?'the '+project+' kit roster':'';
      const rosterEffect=was?(was.on?' The account remains on ':' The account joins '):' The account will be on ';
      return {title:colleagueTitle(who.short,tier,agent,project,was?!!was.on:undefined),
        facts:[...facts,who.id],nothing:!!was && was.tier===input.tier && (!project || was.on===true),
        ifYes:'This Slack account can interact with '+agent+' at tier '+tier+'.'+(roster?rosterEffect+roster+'.':''),ifNo:'Keep the current access.'};
    }
    case 'projectOutsidePerson': {
      const who = outside(input as unknown as Outside), project = projectName(input.project), on = !!input.on;
      const facts: CardFact[] = [...who.facts, { label: 'Project', value: project }];
      const same = !!was && was.on === on;
      if (was) {
        const grants = arr(was.grants).map(rec).map(grant => owns(name(grant.agent)) + ' ' + str(grant.kit) + ' kit');
        facts.push({ label: 'Kits granted through this project', value: list(grants, 'None: the project grants no kits now.') });
        facts.push({ label: same ? 'What changes' : 'Now', value: same ? NOTHING : was.on ? 'They are on the project.' : 'They are not on the project.' });
      }
      facts.push(who.id);
      return { title: outsideProjectTitle(who.short,project,on), facts, nothing: same,
        ifYes: on ? 'Their account is added to the project roster used for kit access.' : 'Their account is removed from this project’s kit grants. Other grants still apply.', ifNo: 'Who is on the project stays as it is.' };
    }
    case 'project': {
      const names_ = (value: unknown) => list(strings(value).map(name));
      const told = changes(before, [['Name', was && str(was.name), str(input.name)], field('Members', 'members', names_),
        field('Agents', 'agents', names_), field('Repositories', 'repositories', value => list(strings(value)))]);
      return { title: (isNew ? 'Create the project ' : was ? 'Change the project ' : 'Set up the project ') + str(input.name) + (str(input.name).toLowerCase() === str(input.id) ? '' : ' (' + str(input.id) + ')'), ...told };
    }
    case 'projectMerge': {
      const stands = (value: unknown) => {
        const project = rec(value);
        return !value ? 'There is no such project.' : str(project.name) + (project.removed ? ' (removed)' : project.retired ? ' (retired)' : '')
          + '. Members: ' + displayList(strings(project.members).map(name), 'none', ', ', 500) + '. Agents: ' + displayList(strings(project.agents).map(name), 'none', ', ', 500)
          + '. ' + count(arr(project.repositories).length, 'repository', 'repositories') + '.';
      };
      return { title: 'Merge the project ' + projectName(input.from) + ' into the project ' + projectName(input.into),
        facts: [{ label: 'Source project', value: projectName(input.from) + (was ? '. Now: ' + stands(was.from) : '') },
          { label: 'Destination project', value: projectName(input.into) + (was ? '. Now: ' + stands(was.into) : '') },
          { label: 'Afterwards', value: 'This cannot be undone.' }],
        ifYes: 'Project records move to ' + projectName(input.into) + ' and use its project access rules. Member-scoped approvals keep their member scope. The source project is removed. Its members and agents are added to the destination. Outside accounts and kit grants stay with the source.',
        ifNo: 'Both projects stay as they are.' };
    }
    case 'projectRetire': return { title: 'Retire the project ' + projectName(input.project), facts: [{ label: 'Project', value: projectName(input.project) },
      { label: 'What happens', value: 'Its records stay under the project with their existing access rules. Its unfinished tasks are shelved until it is revived.' }] };
    case 'projectRevive': return { title: 'Revive the project ' + projectName(input.project), facts: [{ label: 'Project', value: projectName(input.project) },
      { label: 'What happens', value: 'Its shelved tasks are work again, as they were.' }] };
    case 'projectJoin': {
      const same = !!was && was.on === true;
      return { title: 'Let ' + name(input.agent) + ' work on the project ' + projectName(input.project), nothing: same,
        ifYes: name(input.agent) + ' is added to the project’s agents and can read records the project shares with agents.',
        facts: [{ label: 'Agent', value: name(input.agent) }, { label: 'Project', value: projectName(input.project) },
        ...(same ? [{ label: 'What changes', value: NOTHING }] : [])] };
    }
    case 'member': {
      const role = (row: Rec) => row.fullOwner ? 'Owner of the household and of every agent' : row.role === 'owner' ? 'Owner of the household' : 'Member';
      const rosterOf = (row: Rec) => row === input && row.fullOwner ? context.allAgents ?? [] : strings(row.agents);
      const agentsOf = (row: Rec) => {
        const roster = rosterOf(row).map(name);
        if (!row.fullOwner) return list(roster);
        return 'As a full owner they have every agent' + (roster.length ? ': ' + displayList(roster, 'None', ', ', FACT_LIMIT - 48) : '.');
      };
      const sameRoster = was && !!was.fullOwner === !!input.fullOwner && sameValue(rosterOf(was), rosterOf(input));
      const told = changes(before, [['Role', was && role(was), role(input)], ['Their agents', was && agentsOf(was), agentsOf(input), sameRoster]]);
      if (input.fullOwner && !told.facts.some(fact => fact.label.startsWith('Their agents'))) {
        told.facts.push({ label: 'Their agents', value: agentsOf(input) });
      }
      return { title: isNew ? 'Add ' + name(input.id) + ' to the household as ' + (input.role === 'owner' ? 'an owner' : 'a member') : was ? 'Change what ' + name(input.id) + ' is in the household'
        : 'Set ' + name(input.id) + ' as ' + (input.role === 'owner' ? 'an owner' : 'a member') + ' of the household', ...told };
    }
    case 'agent': {
      const face = (row: Rec) => str(row.faceShape) + ' with ' + str(row.faceEyes) + ' eyes', colours = (row: Rec) => str(row.markBg) + ' behind ' + str(row.markFg);
      const told = changes(before, [field('About', 'about', value => str(value) || 'Nothing written'), ['Face', was && face(was), face(input)], ['Colours', was && colours(was), colours(input)]]);
      return { title: isNew ? 'Add an agent called ' + name(input.id) + ' to the household' : 'Change how ' + name(input.id) + ' is described and drawn', ...told,
        ...(isNew ? { ifYes: 'Full owners will have the new agent.' } : {}) };
    }
    case 'settings': {
      const words: Record<string, string> = { defaultAgent: 'Default agent', timezone: 'Time zone', commsDays: 'Days Comms keeps a message’s words', githubOwner: 'GitHub owner',
        backupTarget: 'Backups go to', backupAt: 'Backup time', backupKeep: 'Backups kept', backupRecipients: 'Keys backups are locked to' };
      const said = (key: string, value: unknown) => value === null || value === undefined || value === '' ? 'Not set' : key === 'defaultAgent' ? name(value) : Array.isArray(value) ? numbered(strings(value)) : str(value);
      const keys = Object.keys(input);
      const told = changes(before, keys.map(key => field(words[key] ?? key, key, value => said(key, value))));
      const only = keys.length === 1 ? keys[0]! : '', value = input[only], set = said(only, value);
      const one: Record<string, string> = { defaultAgent: value ? 'Make ' + set + ' the household’s default agent' : 'Leave the household with no default agent', timezone: 'Set the household’s time zone to ' + set,
        commsDays: 'Have Comms keep a message’s words for ' + count(Number(value), 'day'), githubOwner: value ? 'Set the household’s GitHub owner to ' + set : 'Clear the household’s GitHub owner',
        backupTarget: value ? 'Send the household’s backups to ' + set : 'Stop sending the household’s backups anywhere', backupAt: 'Take the household’s backup at ' + set,
        backupKeep: 'Keep ' + count(Number(value), 'backup') + ' of the household', backupRecipients: 'Change the keys the household’s backups are locked to' };
      // The keep time is a message's. What it does not cover is said on the card, so nobody reads it as "everything".
      const notAll = keys.includes('commsDays') ? { ifYes: 'This is how long a message’s words are kept. The work steps of a session handed off from a thread are not covered: they are kept ' + count(TRACE_KEEP_DAYS, 'day') + ' whatever this is set to, and go at once when the thread is deleted.' } : {};
      return { title: one[only] ?? 'Change ' + count(keys.length, 'household setting'), ...told, ...notAll };
    }
    case 'rule': {
      const kinds: Record<string, string> = { merge: 'merging a pull request', command: 'running a command on a machine', setting: 'changing a setting', dangerous: 'a dangerous action' };
      const tiers: Record<string, string> = { ask: 'Ask me', tell: 'Tell me after', do: 'Just do it' };
      // A merge rule's repository pattern is matched, and stored, in lower case.
      const asked = str(input.scope), scope = input.kind === 'merge' && !asked.startsWith('project:') ? asked.toLowerCase() : asked, where = scope === '*' ? 'everything' : scope.startsWith('project:') ? 'the project ' + projectName(scope.slice(8)) : scope;
      const about = (kinds[str(input.kind)] ?? str(input.kind)) + ' (' + where + ')' + (str(input.person) ? ', when asked for ' + name(input.person) : '');
      const tier = input.tier === null ? null : tiers[str(input.tier)] ?? str(input.tier);
      const had = was ? tiers[str(was.tier)] ?? str(was.tier) : undefined;
      const same = !!was && tier !== null && had === tier;
      return { title: tier === null ? 'Remove the standing rule for ' + about : 'Set a standing rule for ' + about + ': ' + tier, nothing: same,
        facts: [{ label: 'When asked about', value: cap(kinds[str(input.kind)] ?? str(input.kind)) }, { label: 'Covers', value: cap(where) },
          { label: 'For', value: str(input.person) ? 'Requests made for ' + name(input.person) : 'Requests made for a household owner' },
          { label: 'Answer', value: tier === null ? 'This rule is removed. Other matching rules can still answer.' : tier },
          ...(before ? [{ label: same ? 'What changes' : 'Now', value: same ? NOTHING : had ? 'The standing answer is: ' + had : 'There is no such rule.' }] : [])] };
    }
    case 'bodyPolicy': {
      const people = (value: unknown) => displayList(arr(value).map(rec).map(person => {
        const account = outside(person as unknown as Outside);
        return account.short + (names && person.platform !== 'slack' ? ' [' + str(person.user) + ' in ' + str(person.workspace) + ']' : '') + ': tier ' + str(person.tier) + (names ? '\n' + workspaceWords(names, str(person.platform), str(person.workspace)) : '');
      }), 'Nobody', '\n');
      const denied = (value: unknown) => displayList(arr(value).map(rec).map(tool => str(tool.pattern) + (tool.guestsOnly ? ' (only when working for a guest)' : '')), 'None', '\n');
      const contacts = field('Outside contacts', 'people', people);
      const details: CardFact[] = [];
      if (names && !contacts[3]) {
        const slackIds = (value: unknown) => arr(value).map(rec).flatMap((person, index) => person.platform === 'slack'
          ? [(index + 1) + '. ' + str(person.user) + ' in ' + str(person.workspace) + ' (tier ' + str(person.tier) + ')'] : []);
        const prior = slackIds(was?.people), next = slackIds(input.people);
        if (prior.length) details.push({ label: 'Slack accounts, now', value: displayList(prior, 'None', '\n'), small: true });
        if (next.length) details.push({ label: 'Slack accounts, if allowed', value: displayList(next, 'None', '\n'), small: true });
        if (details.length && contacts[1] === contacts[2]) contacts[2] += '\nThe contact list changes. See the account details.';
      }
      const told = changes(before, [contacts, field('Tools its body is not given', 'deniedTools', denied)]);
      return { title: 'Change ' + owns(name(input.agent)) + ' outside contacts and tool restrictions', ...told, facts: [...told.facts, ...details] };
    }
    case 'secretRule': {
      const answers: Record<string, string> = { ask: 'Ask each time', auto: 'Allow automatically', never: 'Never allow' };
      const when = (label: string, at: string): ChangeRow => {
        const scope = (row: Rec) => arr(row.agents).map(rec).filter(entry => entry.when === at).map(entry => str(entry.agent));
        const prior = was && scope(was), next = scope(input);
        return [label, prior && list(prior.map(name), 'No agent'), list(next.map(name), 'No agent'), sameValue(prior, next)];
      };
      const told = changes(before, [['Answer', was && (answers[str(was.answer)] ?? str(was.answer)), answers[str(input.answer)] ?? str(input.answer)],
        ['Automatic grant lasts', was && count(Number(was.minutes), 'minute'), count(Number(input.minutes), 'minute')],
        when('When asked', 'on_request'), when('At startup', 'at_start')]);
      return { title: (isNew ? 'Set' : 'Change') + ' who may use the secret ' + str(input.secret), ...told };
    }
    case 'secretDefault': {
      const answers: Record<string, string> = { ask: 'ask each time', auto: 'allow automatically', never: 'never allow' };
      const told = changes(before, [['For a secret with no rule', was && cap(answers[str(was.answer)] ?? str(was.answer)), cap(answers[str(input.answer)] ?? str(input.answer))]]);
      return { title: 'For a secret with no rule of its own: ' + (answers[str(input.answer)] ?? str(input.answer)), ...told };
    }
    case 'houseSecrets': {
      const handed = (value: unknown) => displayList(arr(value).map(rec).map(entry => str(entry.secret) + ' (as ' + str(entry.alias) + ')'), 'None', '\n');
      const told = changes(before, [['Secret for its house repository', was && (str(was.repository) || 'None'), str(input.repository) || 'None'], field('Secrets handed over at start', 'secrets', handed)]);
      return { title: 'Change which secrets ' + owns(name(input.agent)) + ' house is handed when it starts', ...told };
    }
    case 'bridge': return bridge(input, context, name, channel, outside);
    case 'tempoTimings': {
      const who = rec(input.who), told = changes(before, ([['settleSeconds', 'Inbox settle time', 'second'], ['dimDays', 'Dim ends after', 'day'], ['muteDays', 'Mute ends after', 'day']] as const)
        .filter(([key]) => input[key] !== undefined).map(([key, label, unit]) => [label, was && count(Number(was[key]), unit), count(Number(input[key]), unit)]));
      return { title: 'Change Tempo’s timings for ' + (who.kind === 'agent' ? 'the agent ' : '') + name(who.id), ...told };
    }
    case 'measuring': {
      const keeps = (row: Rec) => Number(row.keep_days) === 0 ? 'No local history' : count(Number(row.keep_days), 'day');
      const sends = (row: Rec) => row.on ? yes(row.send_outside) : row.send_outside ? 'Off while measuring is off' : 'No';
      const told = changes(before, [['loom measures itself', was && yes(was.on), yes(input.on)], ['Sends measurements outside', was && sends(was), sends(input)],
        ['Outside address', was && (str(was.outside_address) || 'None'), str(input.outside_address) || 'None'], ['Keeps history for', was && keeps(was), keeps(input)]]);
      return { title: input.on ? 'Have loom measure itself' + (input.send_outside ? ', and send the measurements outside' : '') : 'Stop loom measuring itself', ...told };
    }
    case 'boxSettings': {
      const runs = (row: Rec) => {
        const assigned = arr(row.agents).map(rec).map(entry => name(entry.agent) + (entry.lent ? ' (lent to it)' : ''));
        return row.reportOnly && assigned.length ? 'None while report-only. Configured: ' + displayList(assigned, 'None', ', ', FACT_LIMIT - 40) : list(assigned);
      };
      const rows: ChangeRow[] = [['Name', was && str(was.name), str(input.name)], ['Can host any agent of its owner when hosting is on', was && yes(was.hostsAny), yes(input.hostsAny)],
        ['Only reports, runs nothing', was && yes(was.reportOnly), yes(input.reportOnly)], ['Always on', was && yes(was.alwaysOn), yes(input.alwaysOn)], ['Agents it runs', was && runs(was), runs(input), sameValue(was?.agents, input.agents) && (was?.reportOnly === input.reportOnly || arr(input.agents).length === 0)],
        field('What its owner says it has', 'facts', value => list(strings(value))),
        ...(input.readers === undefined ? [] : [field('Agents that may read it', 'readers', value => list(strings(value).map(name)))])];
      const told = changes(before, rows), machine = 'the machine ' + str(input.name);
      const only = was && !told.nothing && told.facts.length === 1 ? told.facts[0]!.label : '';
      const title = only === 'Always on' ? (input.alwaysOn ? 'Keep ' + machine + ' always on' : 'Stop keeping ' + machine + ' always on')
        : only === 'Name' ? 'Rename the machine ' + str(was!.name) + ' to ' + str(input.name)
        : only === 'Only reports, runs nothing' ? (input.reportOnly ? 'Have ' + machine + ' only report, and run nothing' : 'Let ' + machine + ' run agents again')
        : only === 'Agents it runs' ? 'Change which agents ' + machine + ' runs' : only === 'Agents that may read it' ? 'Change which agents may read ' + machine
        : 'Change the settings of ' + machine;
      return { title, ...told,
        ifYes: input.readers === undefined ? 'The machine uses the settings shown here.' : 'The machine uses the settings shown here and replaces its explicit reader grants with those listed.',
        ifNo: 'The current machine settings stay in effect.' };
    }
    case 'machineReader': return { title: (input.allow ? 'Grant' : 'Remove') + ' explicit read access for ' + name(input.agent) + ' on the machine ' + machineName(input.box),
      facts: [{ label: 'Agent', value: name(input.agent) }, { label: 'Machine', value: machineName(input.box) }] };
    case 'runSettings': {
      const ports = (value: unknown) => list(arr(value).map(rec).map(port => str(port.address) + ' port ' + str(port.port)));
      const told = changes(before, [['House repository', was && (str(was.houseRepository) || 'None'), str(input.houseRepository) || 'None'],
        ['Housefile', was && (str(was.houseFile) || 'None: the core house'), str(input.houseFile) || 'None: the core house'], ['Branch', was && str(was.houseBranch), str(input.houseBranch)],
        ['May run containers inside its house', was && yes(was.nestedContainers), yes(input.nestedContainers)], ['Needs a graphics card', was && yes(was.gpu), yes(input.gpu)],
        ...(input.prefers === undefined ? [] : [field('Prefers a machine with', 'prefers', value => list(strings(value)))]),
        field('Machines, in order', 'boxes', value => numbered(strings(value).map(machineName))), field('Ports its house may open', 'ports', ports)]);
      return { title: (isNew ? 'Set how ' : 'Change how ') + name(input.agent) + ' runs' + (input.houseFile === '' ? ', in the core house with no Housefile of its own' : ''), ...told };
    }
    case 'models': {
      const told = changes(before, [field('Models, in order', 'models', value => numbered(strings(value)))]);
      return { title: 'Change the models ' + name(input.agent) + ' may use', ...told };
    }
    case 'agentAccounts': {
      const told = changes(before, [field('GitHub accounts', 'github', value => list(strings(value)))]);
      return { title: 'Set ' + owns(name(input.agent)) + ' GitHub accounts', ...told,
        ifYes: 'loom uses these logins to attribute GitHub changes.' };
    }
    case 'order': {
      const told = changes(before, [field('Order', 'ids', value => numbered(strings(value).map(name)))]);
      return { title: 'Change the order ' + (input.of === 'members' ? 'people' : 'agents') + ' are listed in', ...told };
    }
    case 'remove': case 'restore': {
      const of = str(input.of), removing = change === 'remove';
      const thing = of === 'member' ? name(input.id) : of === 'agent' ? 'the agent ' + name(input.id) : of === 'project' ? 'the project ' + projectName(input.id) : 'the Discord or Slack connection ' + str(input.id);
      const after = of === 'member' ? 'They can no longer sign in.' : of === 'agent' ? 'It no longer runs, and its bridge connections are switched off.' : of === 'project' ? 'It is out of use.' : 'It is switched off and taken out of use.';
      const same = !!was && !!was.removed === removing;
      const connectionState = of === 'agent' ? ' Its bridge connections stay off until switched on.' : of === 'bridge' ? ' It stays switched off until enabled.' : '';
      return { title: removing ? 'Remove ' + thing + (of === 'project' || of === 'bridge' ? '' : ' from the household') : 'Restore ' + thing + (of === 'project' || of === 'bridge' ? '' : ' to the household'), nothing: same,
        facts: [{ label: 'What happens', value: removing ? after + ' Nothing is erased, and it can be restored later.' : 'It is restored with its history.' + connectionState },
          ...(before ? [{ label: same ? 'What changes' : 'Now', value: same ? NOTHING : isNew ? 'loom has nothing by that name.' : was?.removed ? 'It is removed.' : 'It is in use.' }] : [])] };
    }
    case 'secretDescription': {
      const told = changes(before, [field('What it is for', 'description', value => str(value) || 'Nothing written')]);
      return { title: 'Change what the secret ' + str(input.secret) + ' is said to be for', facts: [...told.facts, { label: 'Its value', value: 'Not shown, and not changed.' }], nothing: told.nothing };
    }
    case 'tokenRevoke': return { title: 'Revoke the token ' + str(input.label), facts: [{ label: 'Token', value: str(input.label) },
      ...(was ? [{ label: 'Belongs to', value: name(was.for) + ' (' + str(was.kind) + ' token)' }] : isNew ? [{ label: 'Now', value: 'No live token has that label.' }] : []),
      { label: 'Afterwards', value: 'It stops working at once. This cannot be undone.' }] };
    case 'boxRevoke': return { title: 'Revoke the machine ' + str(input.name), facts: [{ label: 'Machine', value: str(input.name) },
      ...(was ? [{ label: 'Owned by', value: name(was.owner) }] : isNew ? [{ label: 'Now', value: 'No live machine has that name.' }] : []),
      { label: 'Afterwards', value: 'It can no longer run agents or report. This cannot be undone.' }] };
    case 'browserSignOut': return { title: 'Sign out ' + owns(name(input.member)) + ' browser ' + str(input.device), facts: [{ label: 'Whose', value: name(input.member) }, { label: 'Browser', value: str(input.device) },
      ...(was ? [{ label: 'Signed in now', value: count(Number(was.browsers), 'browser') }] : isNew ? [{ label: 'Now', value: 'No such signed-in browser.' }] : []),
      { label: 'Afterwards', value: 'It is signed out at once and its notifications stop. This cannot be undone.' }] };
    default: return undefined;
  }
}

function bridge(input: Rec, context: CardContext, name: (id: unknown) => string,
  channel: (platform: string, workspace: string, id: string) => { short: string; held: HeldName | null },
  outside: (who: Outside) => { short: string; facts: CardFact[]; id: CardFact }): Told | undefined {
  const { before, names } = context;
  const was = before && before.value !== null ? rec(before.value) : undefined, isNew = !!before && before.value === null;
  const platform = platformWord(str(input.platform)), workspace = str(input.workspace);
  const place = (): CardFact => ({ label: 'Workspace', value: workspaceWords(names, str(input.platform), workspace) });
  switch (str(input.action)) {
    case 'connection': {
      const bot = (row: Rec) => {
        const user = str(row.botUser), platform = str(row.platform), workspace = str(row.workspace);
        const resolved = names?.person(platform, workspace, user);
        if (names && platform === 'slack') return resolved ? resolved.name + ' (Slack)' : 'An unnamed Slack account';
        return resolved ? resolved.name + ' (' + user + ' in ' + workspace + ')' : names
          ? 'A ' + platformWord(platform) + ' account loom has no name for (' + user + ' in ' + workspace + ')' : user;
      };
      const sameWorkspace = was?.platform === input.platform && was?.workspace === input.workspace;
      const sameBot = sameWorkspace && was?.botUser === input.botUser;
      const slackBot = names && input.platform === 'slack';
      const oldBot = was && bot(was), newBot = bot(input);
      const replacement = slackBot && !sameBot && oldBot === newBot
        ? (newBot === 'An unnamed Slack account' ? 'Another unnamed Slack account' : 'Another account with the same name') : newBot;
      const botIdentity = (row: Rec) => str(row.botUser) + ' in ' + str(row.workspace);
      const botDetails: CardFact[] = slackBot ? [{ label: 'Bot account identifiers', small: true,
        value: was && !sameBot ? botIdentity(was) + ' → ' + botIdentity(input) : botIdentity(input) }] : [];
      const channels = (row: Rec, key: string) => {
        const ids = strings(row[key]);
        return displayList(ids.slice(0, ITEM_LIMIT).map(id => {
          const result = channel(str(row.platform), str(row.workspace), id);
          return result.held && row.platform !== 'slack' ? result.short + ' (' + id + ')' : result.short;
        }), 'None', ', ', FACT_LIMIT, ids.length);
      };
      const filterDetails: CardFact[] = [];
      const filter = (label: string, key: string): ChangeRow => {
        const priorIds = strings(was?.[key]), nextIds = strings(input[key]);
        const equal = sameValue(priorIds, nextIds) && (sameWorkspace || !nextIds.length);
        if (was && equal) return [label, '', '', true];
        const prior = was && channels(was, key), next = channels(input, key);
        if (names && (was?.platform === 'slack' || input.platform === 'slack') && (priorIds.length || nextIds.length)) {
          const ids = (row: Rec, values: string[]) => displayList(values.slice(0, ITEM_LIMIT).map(id =>
            was && !sameWorkspace ? id + ' in ' + str(row.workspace) : id), 'None', ', ', FACT_LIMIT, values.length);
          filterDetails.push({ label: label + ' — channel IDs', small: true,
            value: (was ? ids(was, priorIds) + ' → ' : '') + ids(input, nextIds) });
          if (prior === next) return [label, prior, 'Different channel selection', false];
        }
        return [label, prior, next, false];
      };
      const told = changes(before, [['Agent', was && name(was.agent), name(input.agent)], ['Platform', was && platformWord(str(was.platform)), platform], ['Workspace', was && workspaceWords(names, str(was.platform), str(was.workspace)), place().value, sameWorkspace],
        ['Bot account', oldBot, replacement, sameBot], ['Secret holding its token', was && str(was.tokenSecret), str(input.tokenSecret)],
        ['Secret holding its app token', was && (str(was.appSecret) || 'None'), str(input.appSecret) || 'None'], ['Switched on', was && yes(was.enabled), yes(input.enabled)],
        filter('Listens only in', 'only'), filter('Ignores', 'ignore')]);
      const only = was && !told.nothing && told.facts.length === 1 && told.facts[0]!.label === 'Switched on';
      return { title: only ? (input.enabled ? 'Switch on ' : 'Switch off ') + owns(name(input.agent)) + ' ' + platform + ' connection (' + str(input.id) + ')'
        : isNew ? 'Connect ' + name(input.agent) + ' to ' + platform + ' (connection ' + str(input.id) + ')' : (was ? 'Change ' : 'Set up ') + owns(name(input.agent)) + ' ' + platform + ' connection (' + str(input.id) + ')', ...told, facts: [...told.facts, ...(!told.facts.some(fact => fact.label === 'Workspace') ? [place()] : []),
          ...(!told.facts.some(fact => fact.label === 'Bot account') ? [{ label: 'Bot account', value: newBot }] : []), ...botDetails, ...filterDetails] };
    }
    case 'disconnect': {
      const same = !!was && was.enabled === false;
      return { title: was ? bridgeDisconnectTitle(str(input.id),name(was.agent),platformWord(str(was.platform))) : 'Disconnect the Discord or Slack connection ' + str(input.id), nothing: same,
        ifYes: 'The connection stops delivering messages. Its settings stay, and it can be switched on again.', ifNo: 'The connection keeps its current settings.',
        facts: [{ label: 'Connection', value: str(input.id) }, ...(was ? [{ label: 'Agent', value: name(was.agent) }, { label: 'Workspace', value: workspaceWords(names, str(was.platform), str(was.workspace)) }] : []),
          ...(before ? [{ label: same ? 'What changes' : 'Now', value: same ? NOTHING : isNew ? 'loom has no connection by that name.' : 'It is switched on.' }] : [])] };
    }
    case 'channel': {
      const at = channel(str(input.platform), workspace, str(input.channel));
      const reportTuple = (value: unknown): string[] | null => !value ? null : typeof value === 'string'
        ? JSON.parse(value) as string[] : [str(rec(value).platform), str(rec(value).workspace), str(rec(value).channel)];
      const prior = reportTuple(was?.reportsTo), next = reportTuple(input.reportsTo);
      const sameReport = sameValue(prior, next);
      const address = (target: string[] | null) => target ? target[2] + ' in ' + target[1] : 'Nowhere';
      const reports = (target: string[] | null) => {
        if (!target) return 'Nowhere';
        const label = channel(target[0]!, target[1]!, target[2]!).short;
        return target[0] === 'slack' && names ? label : label + ' (' + address(target) + ')';
      };
      const oldReport = reports(prior), newReport = reports(next);
      const reportDetails: CardFact[] = names && !sameReport && (prior?.[0] === 'slack' || next?.[0] === 'slack')
        ? [{ label: 'Guest report destination IDs', small: true, value: was ? address(prior) + ' → ' + address(next) : address(next) }] : [];
      const told = changes(before, [['Answers there', was && name(was.answers), name(input.answers), was?.answers === input.answers], ['Other bots may talk to it there', was && yes(was.botsMayTalk), yes(input.botsMayTalk)],
        ['Extra brief for that channel', was && (str(was.brief) || 'None'), str(input.brief) || 'None'], ['Notes from guests’ work go to', was && oldReport, !sameReport && oldReport === newReport ? 'Another channel with the same label' : newReport, sameReport]]);
      return { title: (was && was.answers === input.answers ? 'Change how ' + name(input.answers) + ' answers in ' : 'Let ' + name(input.answers) + ' answer in ') + at.short,
        facts: [...told.facts, ...reportDetails, ...(at.held ? [{ label: 'Channel name from', value: at.held.source }] : []), place(), { label: 'Channel id', value: str(input.channel), small: true }], nothing: told.nothing };
    }
    case 'removeChannel': {
      const at = channel(str(input.platform), workspace, str(input.channel));
      return { title: 'Remove the answer rule for ' + at.short, nothing: isNew,
        facts: [{ label: 'What happens', value: 'The channel loses its default answering agent and its permission for bots to wake the agent. Addressed messages from admitted people can still be routed.' }, ...(isNew ? [{ label: 'What changes', value: 'Nothing would change. There is no explicit answer rule there.' }] : []),
          place(), { label: 'Channel id', value: str(input.channel), small: true }] };
    }
    case 'person': {
      const who = outside(input as unknown as Outside), same = !!was && was.member === input.member;
      return { title: bridgePersonTitle(who.short,false,name(input.member)), nothing: same,
        facts: [...who.facts, { label: 'Member', value: name(input.member) }, { label: 'What happens', value: 'Messages from that account are taken as ' + owns(name(input.member)) + ' own.' },
          ...(before ? [{ label: same ? 'What changes' : 'Now', value: same ? NOTHING : was ? 'It is treated as ' + name(was.member) + '.' : 'It is not treated as any member.' }] : []), who.id] };
    }
    case 'removePerson': {
      const who = outside(input as unknown as Outside);
      return { title: bridgePersonTitle(who.short,true,was ? name(was.member) : undefined), nothing: isNew,
        facts: [...who.facts, { label: 'What happens', value: 'Messages from that account are no longer taken as a member’s.' },
          ...(isNew ? [{ label: 'What changes', value: 'Nothing would change: it is not treated as any member.' }] : []), who.id] };
    }
    default: return undefined;
  }
}

/** The card's facts as lines of words, for where a card is read as text (the `approvals` tool, a stored summary). */
export const factLines = (facts: readonly CardFact[]): string => facts.map(fact => fact.value.includes('\n') ? fact.label + ':\n' + fact.value.split('\n').map(line => '  ' + line).join('\n') : fact.label + ': ' + fact.value).join('\n');

export function publicProposalTitle(card: { operation?: string | null; details: string; what: string }): string {
  const kept = storedProposal(card);
  return clipProposalText((kept && proposalCard(kept.change, kept.input)?.title) ?? card.what, 240);
}

/** The change and input a stored household card keeps (its `details`), or nothing when it is not one. */
export function storedProposal(card: { operation?: string | null; details: string }): { change: string; input: unknown } | undefined {
  if (card.operation !== 'household.change') return undefined;
  try {
    const kept = rec(JSON.parse(card.details));
    return typeof kept.change === 'string' && kept.after && typeof kept.after === 'object' ? { change: kept.change, input: kept.after } : undefined;
  } catch { return undefined; }
}
