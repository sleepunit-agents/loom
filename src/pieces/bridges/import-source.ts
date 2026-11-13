/** Offline source inventory only. Not imported by the daemon or a live operation. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

const id = z.string().min(1).max(200);
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const map = <T extends z.ZodType>(value: T) => z.record(z.string().min(1).max(200), value);
const ids = z.union([id, z.number().int().safe().positive(), z.array(z.union([id, z.number().int().safe().positive()]))]);
const list = (value: z.infer<typeof ids>): string[] => (Array.isArray(value) ? value : [value]).map(String);
const strings = z.array(id);
const channel = z.object({ name: z.string().optional(), primary: slug.nullish(), parent: id.optional(),
  peer: z.boolean().optional(), pair: id.nullish(), guest_venue: z.boolean().optional(), readers: strings.optional() });
const routes = z.object({ guild: id.optional(), bots: map(id).optional(), bot_roles: map(ids).optional(),
  channels: map(channel).optional(), threads: map(channel).optional(),
  only: z.union([strings, map(z.unknown())]).optional(), ignore: z.union([strings, map(z.unknown())]).optional(),
  webhook_peers: map(id).optional(), notify: map(id.nullable()).optional(), peer_turns_each: z.number().int().positive().nullish(),
});
const account = z.object({ discord: ids.optional(), slack: map(ids).optional() });
const people = z.object({ people: map(account).optional(), agents: map(account).optional() });
const shuttle = z.object({ agent: z.object({ slug }),
  discord: z.object({ token_file: id.optional() }).nullish(), slack: z.object({ secrets_env: id.optional() }).nullish(),
  channel_notes: map(id).optional(),
});
export type BridgeSourceKind = 'shuttle' | 'routes' | 'people' | 'discord-settings' | 'slack-settings';
export interface BridgeSourceFile {
  /** Stable snapshot-relative identity, independently resolved by the caller through snapshotPath. */
  name: string;
  path: string;
  kind: BridgeSourceKind;
}
export interface LegacyBridgeInventory {
  checksum: string;
  sources: { name: string; kind: BridgeSourceKind; sha256: string; bytes: number }[];
  instances: { source: string; agent: string; discordSecret?: string; slackBundle?: string; channelNotes: Record<string,string> }[];
  settings: { source: string; platform: 'discord' | 'slack'; bots: Record<string,string> }[];
  accounts: { source: string; owner: string; kind: 'person' | 'agent'; platform: 'discord' | 'slack'; user: string; workspace?: string }[];
  routes: { source: string; guild?: string; bots: Record<string,string>; botRoles: Record<string,string[]>;
    channels: { channel: string; thread: boolean; primary?: string; parent?: string; peer: boolean; pair?: string; guest: boolean; readers: string[] }[];
    only: string[]; ignore: string[]; webhookPeers: Record<string,string>; notify: Record<string,string|null>; peerTurnsEach?: number }[];
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const keys = (value: string[] | Record<string,unknown> | undefined) => Array.isArray(value) ? value : Object.keys(value ?? {});
/** Explicit files only: never follow an old config's paths, execute commands, or acquire credentials. */
export function readBridgeInventory(files: readonly BridgeSourceFile[]): LegacyBridgeInventory {
  try {
    if (!files.length || new Set(files.map(f=>f.name)).size !== files.length || new Set(files.map(f=>f.path)).size !== files.length) throw Error();
    const result: LegacyBridgeInventory = {checksum:'',sources:[],instances:[],settings:[],accounts:[],routes:[]};
    for (const file of [...files].sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!file.name || file.name.startsWith('/') || file.name.split('/').some(p=>!p || p==='.' || p==='..') || file.name.includes('\\')) throw Error();
      z.enum(['shuttle','routes','people','discord-settings','slack-settings']).parse(file.kind);
      const leaf = file.kind === 'shuttle' ? 'shuttle.json' : file.kind === 'routes' ? 'routes.json' : file.kind === 'people' ? 'people.json' : 'settings.json';
      if (basename(file.path) !== leaf || basename(file.name) !== leaf) throw Error();
      if (file.kind.endsWith('-settings')) {
        const platform = file.kind === 'discord-settings' ? 'discord' : 'slack';
        if (basename(dirname(file.path)) !== platform || basename(dirname(file.name)) !== platform) throw Error();
      }
      const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 8*1024*1024) throw Error();
        // Bound the descriptor read even if a source grows after fstat.
        const buffer = Buffer.alloc(8*1024*1024+1);
        let length = 0, count: number;
        do {
          count = readSync(fd,buffer,length,buffer.length-length,null);
          length += count;
        } while (count && length < buffer.length);
        if (length > 8*1024*1024 || length !== stat.size) throw Error();
        bytes = buffer.subarray(0,length);
      } finally { closeSync(fd); }
      const raw: unknown = JSON.parse(bytes.toString('utf8'));
      result.sources.push({name:file.name,kind:file.kind,sha256:hash(bytes),bytes:bytes.length});
      if (file.kind === 'shuttle') {
        const v = shuttle.parse(raw);
        result.instances.push({source:file.name,agent:v.agent.slug,
          ...(v.discord ? {discordSecret:v.discord.token_file ?? 'discord-token'} : {}),
          ...(v.slack ? {slackBundle:v.slack.secrets_env ?? 'slack.env'} : {}),channelNotes:v.channel_notes ?? {}});
      } else if (file.kind === 'people') {
        const v = people.parse(raw);
        for (const [section,kind] of [['people','person'],['agents','agent']] as const) {
          for (const [owner,a] of Object.entries(v[section] ?? {})) {
            if (owner.startsWith('_')) continue;
            slug.parse(owner);
            for (const user of a.discord === undefined ? [] : list(a.discord)) result.accounts.push({source:file.name,owner,kind,platform:'discord',user});
            for (const [workspace,users] of Object.entries(a.slack ?? {})) for (const user of list(users)) result.accounts.push({source:file.name,owner,kind,platform:'slack',workspace,user});
          }
        }
      } else if (file.kind === 'routes') {
        const v = routes.parse(raw);
        result.routes.push({source:file.name,...(v.guild ? {guild:v.guild} : {}),bots:v.bots ?? {},
          botRoles:Object.fromEntries(Object.entries(v.bot_roles ?? {}).map(([agent,roles])=>[agent,list(roles)])),
          channels:([['channels',false],['threads',true]] as const).flatMap(([section,thread])=>Object.entries(v[section] ?? {}).map(([channel,c])=>({
            channel,thread,...(c.primary ? {primary:c.primary} : {}),...(c.parent ? {parent:c.parent} : {}),
            peer:!!c.peer,...(c.pair ? {pair:c.pair} : {}),guest:!!c.guest_venue,readers:c.readers ?? [],
          }))),only:keys(v.only),ignore:keys(v.ignore),webhookPeers:v.webhook_peers ?? {},notify:v.notify ?? {},
          ...(v.peer_turns_each == null ? {} : {peerTurnsEach:v.peer_turns_each})});
      } else {
        const platform = file.kind === 'discord-settings' ? 'discord' : 'slack';
        const document = z.record(z.string(),z.unknown()).parse(raw);
        const value = document[platform === 'discord' ? 'DISCORD_BOTS' : 'SLACK_BOTS'];
        // The old piece accepts settings as text and parses the JSON map itself.
        const bots = z.record(slug,id).parse(value === undefined || value === '' ? {} : typeof value === 'string' ? JSON.parse(value) : value);
        result.settings.push({source:file.name,platform,bots});
      }
    }
    result.checksum = hash(JSON.stringify(result.sources));
    return result;
  } catch {
    // JSON, schema and filesystem exceptions can contain source words or paths.
    throw Error('Invalid offline Bridges configuration inventory');
  }
}
