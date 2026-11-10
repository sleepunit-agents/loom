import { agentJobs } from './agent-jobs.js';
/**
 * loom's web UI on the HTTP daemon (full scope only).
 *
 *   GET  /                         Home: the tape, tiles, "Your call"
 *   GET  /mind, /people[/<slug>], /memory/<ref>, /pieces   loom's own pages
 *   GET  /p/<piece>[/<path>]       a piece's page
 *   GET  /pieces.json              the installed pieces' manifests, for scripts
 *   POST /act/<source>             an action (source = loom or a piece)
 *   GET/POST /login, POST /logout
 *   /login/passkey…, /passkeys        passkeys (docs/specs/passkeys.md)
 *   /ui/…                          the old address: redirects to the same page at the root
 *
 * The page shares the daemon with MCP, which answers on any other path. `/`
 * is the page only for a plain browser GET: a POST, a request with an MCP
 * session, or one asking for an event stream is MCP's.
 *
 * Auth follows the daemon's bearer token, and the UI needs one: a daemon with
 * no token serves no /ui (like /cli), because an open page would be readable
 * by any site that DNS-rebinds a name to the loopback address. A browser logs
 * in once by pasting the token and gets a session: a random id held in this
 * process's memory. It isn't the token and isn't derivable from it, so it
 * can't be replayed as a bearer or used to guess the token. It lasts 30 days,
 * until logout (which revokes it), until the token changes, or until the
 * daemon restarts. Scripts can send the bearer header instead.
 *
 * A GET from another site or another port is served only as a top-level
 * navigation, never to an <img> or a fetch (fetch metadata).
 *
 * Every POST from a browser carries an anti-forgery token derived from its
 * cookie, and a cross-site POST is refused outright (Sec-Fetch-Site / Origin),
 * on top of the SameSite=Strict cookie. The page runs no script and is served
 * under a CSP that forbids script and framing. Action fields go to the piece
 * on stdin and are never logged, stored, or put in a URL; the one-time result
 * message is kept in memory under a random id for a minute.
 */
import { changed, closeSession, onChanged, openStream, type Sees } from './live.js';
import { backupFyi, backupProblem, backupRow } from '../backup.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { packAsset } from './asset-encoding.js';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';
import { resolveRepoRoot } from '../config.js';
import { deviceOf, prefsOf, REF, SESSION_MAX_AGE_S, sessionEnded, sessionStore, signedInAt, signinLink, type Done, type Passkey, type SessionInfo } from './sessions.js';
import { dropUnusedPasskeyToken, originOf, PasskeyTokenLeft, passkeyPerson, passkeysMadeFrom, passkeyToken, removePasskey, STALE_FOR_PASSKEY, staleForPasskey, ThePasskeys, thePasskeys } from './passkey-tokens.js';
import { APP_JS } from './app.js';
import { askKey, needsAskText, publicKey, pushSub, pushTitle, sendTest, watch, type Announce } from './push.js';
import { MANIFEST, swJs } from './pwa.js';
import { ALGS, PASSKEY_JS, PasskeyError, relyingParty, verifyAssertion, verifyRegistration } from './passkeys.js';
import { checkBearer } from '../transport/guards.js';
import { agentName, coreAct, conversationPage, corePage, homePage, uiTimeZone } from './core.js';
import { answeredNeeds, answerNeeds, ConversationError, getConversation as conversationOf, isConversationId, openNeeds, type NeedsVerdict } from '../backends/conversations.js';
import { answersOf, yesNoText } from '../backends/needs.js';
import { deliverAsOwner } from '../delivery.js';
import { commsRoute, pageRefused } from './comms-routes.js';
import { recordAnswer, recordApprovalAnswer, verdictOf } from '../comms-asks.js';
import { pieceCheckers, pieceWithRole, resolveNeeds } from '../needs-resolve.js';
import { deliveryPiece, grantsAuthority } from '../offers-registry.js';
import { venueLabel } from '../household-store.js';
import { piecesAct, piecesAsks, piecesPage } from './pieces-page.js';
import { aliasTarget, catalogKinds, readCatalog } from '../cli/pieces-managed.js';
import { resolvePieceName } from '../cli/pieces.js';
import { householdFind, householdPersonName, householdSuggestPeople, householdThread } from './household-pages.js';
import { activityView } from './activity.js';
import { tapeRows, whereLabel, type TapeEntry } from './data.js';
import { listProposals } from '../backends/proposals.js';
import { ownerOf, projectHubPage, projectsApp } from './projects-pages.js';
import { agentBio, agentSetup, householdAct, householdHome, householdMembers, householdPeople, householdPeopleApp, householdPerson, knowledgeView, newAgentPage, newFactPage, newPersonPage } from './household-pages.js';
import { ICON_APP, iconFile, iconSetOf } from '../icon-set.js';
import { aboutAskOf, aboutOf, agentDir, faceOf, firstOwner, loadTokens, MARKS, memberOf, spriteDir, spriteOf, type Household, type Member } from '../household.js';
import { owns, threadOfAgentConversation, threadPath, threadsOf } from '../comms.js';
import { pieceAct, pieceManifests, piecePage, type ApiCaller, type PieceInfo } from './pieces.js';
import { age, type Dashboard } from './render.js';
import { agentSource, agoText, CORE, folderOf, INBOX_FOLDERS, inboxBox, inFolder, pageHref, pieceSource, type AgentCard, type HouseHome, type InboxFolder, type InboxItem, renderLogin, renderLoginLink, type AgentHead, type Chrome, type Found, type Shell, type HomeAsk, type HomeTile, type Source } from './render.js';
import { ID, LIMITS, QUERY_KEY, splitPage, validPath, type ActResult, type AgentState, type AskKind, type Page, type Section } from './vocab.js';
import { resolveFrom } from '../comms-work.js';
import { answerBatch, COLLECTIONS_MAX_BYTES, COLLECTIONS_QUERY_ROUTE } from '../collections/serve.js';
import { memberViewer, viewerId, type Viewer } from '../collections/viewer.js';
import { registerCoreSource } from '../collections/core-types.js';
import type { MemRecord } from '../collections/memory.js';
import { AGENT_STATUS_DOMAIN, ATTENTION_DOMAIN, closeStream as subsClose, openStream as subsOpen, pullAfterAction, pullSoon } from '../collections/subs.js';
import { GAP_MS, nudge } from '../collections/pull.js';
import { beginOp, finishOp, withLog } from '../collections/log.js';

const COOKIE = 'loom_ui';
/** Knowledge's Add a fact (its reader draws it over the list). */
const NEW_FACT_LINK = { page: 'loom:new-fact', label: 'Add a fact' };
const LOGIN_MAX_BYTES = 4096;
const PASSKEY_MAX_BYTES = 16 * 1024;
/** The two pages that run loom's one script (/login/passkey.js): the sign-in page and Passkeys. */
const PASSKEY_CSP = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
const ACT_MAX_BYTES = 64 * 1024;
const COOKIE_MAX_AGE_S = SESSION_MAX_AGE_S;
const FLASH_TTL_MS = 60_000;
const FLASH_MAX = 200;
/** This process's cookie key. Never written anywhere: a restart means logging in again. */
const SECURITY_HEADERS = {
  // Script only from loom itself (the app under /app/; the sign-in pages' /app.js and /login/passkey.js), never inline: a piece's page
  // is data. Stylesheets from loom itself too (the app's), and data: images (its components' small SVG backgrounds).
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  // same-origin, not no-referrer: under no-referrer, browsers send `Origin:
  // null` on the page's own form posts, which the cross-site guard has to
  // refuse. same-origin still sends nothing to links that leave the page.
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

export interface UiOptions {
  contextDir: string;
  /** Who may log in to the page. */
  auth: UiAuth;
  /** Env for piece discovery and piece processes (PATH decides which pieces exist). */
  env: NodeJS.ProcessEnv;
  /**
   * The household, read fresh (an agent added from the page shows up on the
   * next request). Absent for a plain context dir: the single-agent page.
   */
  household?: () => Household;
  /**
   * Set for an agent owner's request (docs/specs/owners.md): the agents they own. `household`
   * is then theirs alone, pieces are the ones that understand agent owners, and the
   * household's own pages and actions are refused.
   */
  ownerScope?: string[];
  /** The member signed in, for the account menu (docs/specs/owners.md). */
  viewer?: string;
  /** The member signed in, whole: Comms is theirs (docs/specs/comms.md), so the dock's Comms key and its count are too. */
  member?: Member;
  /** The env owner token's sha256 (hex), when there is one: a passkey made from it says so. */
  envOwnerDigest?: string;
}

/** An app's pixel icon (src/icon-set.ts): /pixel-icons/<app>.png, the app as ICON_APP has it. */
const PIXEL_ICON = new RegExp(`^/pixel-icons/(${ICON_APP.source.slice(1, -1)})\\.png$`);

/** Paths an agent owner's page may open: Home, the Inbox, Activity, their agents, opted-in pieces, their passkeys. */
function scopedPathOk(pathname: string): boolean {
  return pathname === '/' || pathname === '/inbox' || pathname === '/inbox/read' || pathname === '/inbox/open' || pathname === '/activity' || pathname === '/passkeys' || pathname === '/passkeys/options' || pathname === '/account' || pathname === '/events'
    // Shared collections answer for their viewer alone (docs/specs/collections.md).
    || pathname === '/collections/query'
    || pathname === '/scope' || pathname === '/places' || pathname === '/find' || pathname === '/setup' || pathname === '/appearance' || pathname === '/accessibility' || pathname === '/appearance/prefs'
    // Their agents' pixel faces (the route itself checks the agent is one they see).
    || pathname.startsWith('/faces/')
    // The household's pixel icons: an agent owner is a member, and their shell names them as anyone's does.
    || pathname.startsWith('/pixel-icons/')
    || pathname.startsWith('/a/') || pathname.startsWith('/p/') || pathname.startsWith('/act/')
    // A conversation is found among their agents only (the household they're given is theirs alone).
    || pathname.startsWith('/conversation/')
    // Comms (docs/specs/comms.md): every route checks the member owns the thread's agent itself.
    || pathname === '/comms' || pathname.startsWith('/comms/')
    // Notifications on their own device (t-1978): each route acts only on the caller's own subscription.
    || pathname === '/push/key' || pathname === '/push/subscribe' || pathname === '/push/unsubscribe';
}

/**
 * The pieces as an agent owner sees them: only those that understand agent owners (owners: 2),
 * each manifest cut to their agents' asks, notices, answered items and readings. An item that
 * names no agent is the household's, and a tile is a household figure, so both go.
 */
/**
 * What each agent has going, as this viewer may see it (t-1945). The runtime's rows for a delivered body name only its
 * venue, kind and conversation (a label can carry who or what it's about); loom puts in what the viewer may see:
 * - a Comms thread is its member's alone (docs/specs/comms.md, rule 4): for them, the thread's title and a link to it;
 *   anyone else doesn't see the row at all;
 * - any other conversation (a bridge's chat, a wake) is its agent's owners' (owners.md): for them, its label and a link
 *   to its page; anyone else keeps the runtime's plain words ("Working · Slack", "On a wake").
 * The runtime is the one record of a body at work; this only says which conversation, and to whom.
 */
export function atWorkFor(pieces: PieceInfo[], h: Household | undefined, member: Member | undefined): PieceInfo[] {
  if (!h || !pieces.some((p) => Object.values(p.manifest.agents ?? {}).some((r) => r.doing?.some((d) => d.conversation) || r.jobs?.length))) return pieces;
  const threads = new Map<string, ReturnType<typeof threadOfAgentConversation>>();
  const threadOf = (agent: string, cv: string) => {
    const key = `${agent}:${cv}`;
    if (!threads.has(key)) { try { threads.set(key, threadOfAgentConversation(h.home, agent, cv)); } catch { threads.set(key, undefined); } }
    return threads.get(key);
  };
  const labelOf = (agent: string, cv: string) => { try { return conversationOf(agentDir(h, agent), cv)?.label ?? undefined; } catch { return undefined; } };
  return pieces.map((p) => !p.manifest.agents ? p : { ...p, manifest: { ...p.manifest, agents: Object.fromEntries(Object.entries(p.manifest.agents).map(([a, r]) => [a, {
    ...r, jobs: (r.jobs ?? []).flatMap((j) => {
      if (!member || !owns(member, a) || !h.agents.includes(a)) return [];
      const t = j.conversation ? threadOf(a, j.conversation) : undefined;
      if (t && t.member !== member.person) return [];
      const label = j.conversation ? (t?.title ?? labelOf(a, j.conversation)) : undefined;
      return [{ ...j, ...(['Working in a conversation', 'Waiting to continue'].includes(j.text) && label ? { text: label } : {}), ...(j.conversation ? { href: t ? threadPath(t.id) : `/a/${a}/conversation/${j.conversation}` } : {}) }];
    }), doing: (r.doing ?? []).flatMap((d) => {
      if (!d.conversation) return [d];
      const t = threadOf(a, d.conversation);
      if (t) return member && t.member === member.person ? [{ ...d, text: t.title ?? 'New thread', where: 'Comms', href: threadPath(t.id) }] : [];
      if (!member || !owns(member, a) || !h.agents.includes(a)) { const { activity, ...generic } = d; return [generic]; }
      const label = labelOf(a, d.conversation);
      return [{ ...d, ...(label ? { text: d.kind === 'talk' ? `Talking in ${label}` : label } : {}), href: `/a/${a}/conversation/${d.conversation}` }];
    }) }])) } });
}

function forOwner(pieces: PieceInfo[], own: string[] | undefined): PieceInfo[] {
  if (!own) return pieces;
  const mine = <T extends { agent?: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => x.agent !== undefined && own.includes(x.agent));
  return pieces.filter((p) => p.manifest.owners === 2).map((p) => ({
    ...p,
    manifest: {
      ...p.manifest,
      tile: undefined,
      asks: mine(p.manifest.asks),
      notices: mine(p.manifest.notices),
      answered: mine(p.manifest.answered),
      agents: p.manifest.agents ? Object.fromEntries(Object.entries(p.manifest.agents).filter(([a]) => own.includes(a))) : undefined,
    },
  }));
}

/** Whose read state a request reads and writes: none for the first household owner (the household's own record), else the member. */
function readerFor(opts: UiOptions, who: Who): string | undefined {
  const m = who?.member;
  const h = opts.household?.();
  return !m || !h || m.person === firstOwner(h).person ? undefined : m.person;
}

/** A member's passkeys: those whose token is theirs, whether or not it still works (so a stopped one can be removed). */
function passkeysOf(opts: UiOptions, m: Member) {
  const h = opts.household?.();
  return storeFor(opts).passkeys().filter((k) => (opts.auth.member?.(Buffer.from(k.secret, 'hex'))?.person ?? (h ? passkeyPerson(h, k) : undefined)) === m.person);
}

/** Why a passkey no longer signs anyone in, in the words its row and a refused sign-in use. */
function passkeyStopped(k: Passkey): string {
  return k.tokenLabel ? 'it stopped working: its person isn\'t a member any more, or its token was revoked. Add a new one'
    : 'it stopped working: the token it was added with was revoked. Sign in again and add a new one';
}

/** The household as an agent owner sees it: their agents only (the default, theirs too). */
function narrowed(h: Household, agents: string[]): Household {
  const own = h.agents.filter((a) => agents.includes(a));
  return { ...h, agents: own, default: own.includes(h.default) ? h.default : own[0] };
}

/** The built app (web/ → dist/web): beside this module's dist/ui, or from src/ui (tests, `npm run dev`) the repo's dist/web. */
const WEB_DIR = [new URL('../web/', import.meta.url), new URL('../../dist/web/', import.meta.url)]
  .map((u) => fileURLToPath(u)).find((d) => existsSync(join(d, 'index.html'))) ?? fileURLToPath(new URL('../web/', import.meta.url));
const WEB_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
/** The service worker for the app as built (pwa.ts swJs): its files under /app/assets/, read once per start. */
let worker: string | undefined;
function workerJs(): string {
  if (worker === undefined) {
    let built: string[] = [];
    try { built = readdirSync(join(WEB_DIR, 'assets')).filter((f) => /\.(js|css|woff2)$/.test(f)).sort().map((f) => `/app/assets/${f}`); } catch { /* no build: nothing kept ahead */ }
    worker = swJs(built);
  }
  return worker;
}

/** A file of the built app, or null: never outside its folder. */
function webFile(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const p = normalize(join(WEB_DIR, rel));
  if (!p.startsWith(WEB_DIR.endsWith(sep) ? WEB_DIR : WEB_DIR + sep)) return null;
  try { return existsSync(p) && statSync(p).isFile() ? p : null; } catch { return null; }
}

/** Whose a page's data is, for the service worker (pwa.ts): a hash of the session, never the session. A copy kept under
 * another tag is another person's, and the worker drops every copy when the tag changes. */
function whoTag(who: Who): Record<string, string> {
  return who?.kind === 'session' ? { 'x-loom-who': createHash('sha256').update(`loom-who\0${who.cookie}`).digest('base64url').slice(0, 16) } : {};
}

/** Whose a live stream is, for its per-browser cap: the session, else the very credential presented (never a bucket two principals share). */
function streamOwner(req: IncomingMessage, who: NonNullable<Who>): string {
  if (who.kind === 'session') return `session:${who.cookie}`;
  return `bearer:${createHash('sha256').update(String(req.headers.authorization ?? '')).digest('base64url')}`;
}

/** The Accessibility app's intro (web/src/sheets.tsx draws its settings). */
const ACCESSIBILITY_INTRO = 'Make loom easier to see and use. Allow zoom, calm the motion, or raise the contrast. Reduce motion and Higher contrast follow your phone’s own settings unless you choose here. Yours on every device you sign in on.';

const PAGE_ROOTS = ['/collections', '/app', '/faces', '/pixel-icons', '/events', '/setup', '/appearance', '/accessibility', '/members', '/push', '/app.js', '/sw.js', '/manifest.webmanifest', '/icons', '/fonts', '/scope', '/places', '/find', '/login', '/logout', '/pieces.json', '/pieces', '/passkeys', '/account', '/inbox', '/activity', '/mind', '/people', '/memory', '/p', '/act', '/knowledge', '/projects', '/a', '/new-agent', '/new-person', '/new-fact', '/conversation', '/comms'];

/** Whether a request is for the page (see the header for how `/` is shared with MCP). */
export function isUiRequest(req: IncomingMessage, pathname: string): boolean {
  if (pathname === '/ui' || pathname.startsWith('/ui/')) return true;
  if (pathname === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.headers['mcp-session-id'] !== undefined) return false;
    return !/text\/event-stream/i.test(req.headers.accept ?? '');
  }
  return PAGE_ROOTS.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Browser sessions: on disk (src/ui/sessions.ts), so a restart signs nobody
 * out, shared by every loom-http process on the machine. The cookie is a
 * random id, not the token and not derivable from it; the file keeps only
 * its hash. Logout deletes it, so a copied cookie stops working (cookies
 * can't be kept from other ports on the same host, so revocation matters).
 */
const storeFor = (opts: UiOptions) => sessionStore(opts.household?.().home ?? opts.contextDir);

/**
 * Who may log in. `check` answers a presented token with its digest when the
 * token may use the page, `live` says whether a digest still may (so revoking
 * or rotating the token ends its sessions). `enabled` false means no token is
 * configured, and the page refuses to serve.
 */
export interface UiAuth {
  enabled: boolean;
  check(token: string): Buffer | null;
  live(digest: Buffer): boolean;
  /** The household member an owner token digest belongs to (docs/specs/owners.md); none outside a household. */
  member?(digest: Buffer): Member | undefined;
}

/** A fixed list of tokens (a single bearer, or a token map's values). */
export function legacyUiAuth(secrets: string[]): UiAuth {
  const digests = secrets.map((t) => digest(t));
  return {
    enabled: secrets.length > 0,
    check: (t) => {
      const d = digest(t);
      return digests.some((x) => timingSafeEqual(x, d)) ? d : null;
    },
    live: (d) => digests.some((x) => timingSafeEqual(x, d)),
  };
}

/** The anti-forgery token for a session: bound to its id, useless without it. */
function csrfFor(id: string, key: Buffer): string {
  return createHmac('sha256', key).update(`loom-ui-csrf|${id}`).digest('hex');
}

/** Equal-length digests, so neither the content nor the length of a guess leaks. */
function safeEq(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function validSession(id: string, opts: UiOptions, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  const auth = opts.auth;
  const store = storeFor(opts);
  const s = store.get(id);
  if (!s) return false;
  // Past its time (a month; an agent's, hours: t-1936).
  if (sessionEnded(s, nowS)) { store.delete(id); return false; }
  // A session dies with its token: rotate the token and old sessions stop.
  if (!auth.live(s.secret)) return false;
  // When it was last used, for the Account page's list (t-1871): at most every few minutes.
  store.touch(id, nowS);
  return true;
}

/**
 * The sessions this person may see and end (t-1871), as passkeys: a household owner's are every live one; an agent
 * owner's, their own. Live: unexpired, and its token still good.
 */
function sessionsOf(opts: UiOptions, m: Member | undefined, nowS = Math.floor(Date.now() / 1000)): SessionInfo[] {
  return storeFor(opts).list().filter((s) => !sessionEnded(s, nowS) && opts.auth.live(s.secret)
    && (!opts.ownerScope || (!!m && opts.auth.member?.(s.secret)?.person === m.person)));
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Who's asking: a browser session (with its cookie, for the anti-forgery token), a script with the bearer, or nobody. */
/** A signed-in request, and the member it is (docs/specs/owners.md): from its session's token, or the bearer's. */
type Who = { kind: 'session'; cookie: string; member?: Member } | { kind: 'bearer'; member?: Member; digest: Buffer } | null;

function whoIs(req: IncomingMessage, opts: UiOptions): Who {
  if (!opts.auth.enabled) return null;
  const c = readCookie(req, COOKIE);
  if (c && validSession(c, opts)) {
    const s = storeFor(opts).get(c);
    return { kind: 'session', cookie: c, member: s ? opts.auth.member?.(s.secret) : undefined };
  }
  const header = req.headers['authorization'];
  const presented = header?.replace(/^Bearer\s+/i, '').trim();
  const d = presented ? opts.auth.check(presented) : null;
  if (d) return { kind: 'bearer', member: opts.auth.member?.(d), digest: d };
  return null;
}

/** The WebAuthn user a member's passkeys are made under. */
function passkeyUser(m: Member | undefined, first: boolean, rpId: string): { id: string; name: string; displayName: string } {
  const seed = !m || first ? `loom-owner|${rpId}` : `loom-member|${m.person}|${rpId}`;
  return { id: Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16)).toString('base64url'), name: m?.person ?? 'owner', displayName: 'loom' };
}

/** The asking agent's own wakes (1 to 12, `w-` and 6 hex, ascending, each once: the approvals piece's grammar). */
const ownWakes = (t: string, agent: string): boolean => {
  const m = /^([a-z][a-z0-9-]{0,39}):((?:w-[0-9a-f]{6},){0,11}w-[0-9a-f]{6})$/.exec(t);
  if (!m || m[1] !== agent) return false;
  const ids = m[2].split(',');
  return ids.every((x, i) => i === 0 || ids[i - 1] < x);
};

/**
 * The approvals the household owner's Allow applies (t-1970 grant; t-1975 vouch-wake and principal-reset: Jonathan,
 * "It needs to have the site ask me"): each kind's piece and the action core posts it as the owner, the target it may
 * have (never a confused deputy: a vouch or a reset names only the asking agent's own wakes or conversation, each id
 * well formed; the clock and the runtime check the same on their side), and what to say when it isn't applied. The
 * piece spends the approval (allowed, for exactly that target, once) and only then applies it.
 */
const OWNER_APPLIED: Record<string, { action: string; piece: (env: NodeJS.ProcessEnv) => string | undefined; target: (t: string, agent: string) => boolean; who: string; none: string; after: string }> = {
  grant: { action: 'grant-approved', piece: (env) => grantsAuthority(env).piece, target: () => true, who: 'access to a piece is the household owner\'s to give.',
    none: 'no runtime is installed to apply it.', after: 'You can give it on Permissions.' },
  'vouch-wake': { action: 'vouch-approved', piece: (env) => pieceWithRole(env, 'clock')?.name, target: ownWakes, who: 'only the household owner says whose work a wake is.',
    none: 'no clock is installed to apply it.', after: '' },
  'principal-reset': { action: 'reset-approved', piece: (env) => deliveryPiece(env).piece, target: (t, agent) => { const m = /^([a-z][a-z0-9-]{0,39}):(cv-[0-9a-f]{12})$/.exec(t); return !!m && m[1] === agent; },
    who: 'only the household owner says whose work a conversation is.', none: 'no runtime is installed to apply it.', after: '' },
  // t-2057: `<agent>:<box>@<last heard>`: the agent's houses on a box that went silent are written off, and its
  // conversations go on elsewhere.
  'box-write-off': { action: 'writeoff-approved', piece: (env) => deliveryPiece(env).piece, target: (t, agent) => { const m = /^([a-z][a-z0-9-]{0,39}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([0-9]{1,12})$/.exec(t); return !!m && m[1] === agent; },
    who: 'only the household owner says a box\'s work is moved off it.', none: 'no runtime is installed to apply it.', after: '' },
};

/**
 * The household-owner rule is checked here, by the approvals piece and by the applying piece too: three programs, each
 * refusing on its own, so no one of them being wrong gives a piece away or makes someone's work the owner's (a
 * trade-off against one shared helper, t-1970 review).
 *
 * After the household owner's Allow on an approval: if it's one of OWNER_APPLIED (a `grant`, its target
 * `<piece>:<agent>[:<paths>]`; a `vouch-wake`, `<agent>:<w-id>,…`; a `principal-reset`, `<agent>:<cv>`), the piece that
 * owns it applies it now, as the same owner. Read from the approvals piece itself (its `state`), never from the form:
 * the id is all the page says. Only the household's owner (every agent's); a member who owns some agents can't (approvals
 * refuses their Allow too, and the applying piece refuses their call). Any other approval, or one not allowed, leaves
 * the answer as it was.
 */
export async function applyOwnerApproval(env: NodeJS.ProcessEnv, pieces: PieceInfo[], id: string, caller: ApiCaller | undefined, allowed: ActResult, hh: Household): Promise<ActResult> {
  if (!/^a-[0-9a-f]{8}$/.test(id)) return allowed;
  const a = (await pieceCheckers(env).approvals([id]).catch(() => undefined))?.[id];
  // Couldn't say what it was (the piece busy, slow, or answering for no such id): never a quiet "Allowed", which for one
  // of these would read as done while nothing was applied.
  if (!a) {
    // Only for a card that leads (the approvals piece marks those it applies), so a merge's or a relay's Allow isn't made a failure.
    const src = pieceWithRole(env, 'approvals')?.name;
    const leadCard = pieces.find((p) => p.piece === src)?.manifest.asks.some((x) => x.lead && x.actions?.some((b) => b.fields?.id === id));
    // One past the cards loom was shown can't be told apart: never a bare "Allowed" for it either.
    return leadCard ? { ok: false, message: `${allowed.message} It may not be applied: loom couldn't read that approval back. Check it on Approvals.` }
      : { ...allowed, message: `${allowed.message} (loom couldn't read it back: if it gives an agent a piece, check Permissions.)` };
  }
  const how = a.kind ? OWNER_APPLIED[a.kind] : undefined;
  if (!how || !Object.hasOwn(OWNER_APPLIED, a.kind!) || a.state !== 'allowed') return allowed;
  const owner = caller?.kind === 'owner' && (caller.agents === undefined || caller.agents === '*');
  const target = typeof a.target === 'string' ? a.target : '';
  // Every way it isn't applied says so, and what happens next (his Allow can't be pressed again).
  const unapplied = (why: string): ActResult => ({ ok: false, message: `${allowed.message} It wasn't applied: ${why}${how.after ? ` ${how.after}` : ''}` });
  if (!owner) return unapplied(how.who);
  if (!target || !a.agent) return unapplied('loom couldn\'t read what that approval allows.');
  if (!how.target(target, a.agent)) return unapplied('that approval names something that isn\'t the asking agent\'s own.');
  // A reset is for a conversation core has on record as the asking agent's own (a conversation id is that agent's:
  // its turns are in its store); one core has nowhere, or as another agent's, is never posted.
  if (a.kind === 'principal-reset') {
    const cv = target.slice(target.indexOf(':') + 1);
    let mine: unknown;
    try { mine = hh.agents.includes(a.agent) ? conversationOf(agentDir(hh, a.agent), cv) : undefined; } catch { mine = undefined; }
    if (!mine) return unapplied('that conversation is another agent\'s, or loom has no record of it.');
  }
  const name = how.piece(env);
  const info = name ? pieces.find((p) => p.piece === name) : undefined;
  if (!info) return unapplied(how.none);
  const r = await pieceAct(info, { action: how.action, path: '', fields: { id, agent: a.agent, target } }, env, caller);
  return r.ok ? { ...r, page: '' } : unapplied(r.message);
}
/** t-1970's name for it, kept for its callers. */
export const applyGrant = applyOwnerApproval;

/** The household's Permissions page: the grants authority's own (the runtime's `permissions`), when one is installed. */
function permissionsOf(env: NodeJS.ProcessEnv): { permissions?: string } {
  const piece = grantsAuthority(env).piece;
  return piece ? { permissions: `/p/${piece}/permissions` } : {};
}

/** The caller a piece's page or action is told about: the member, and what they own. */
function callerOf(who: Who): ApiCaller | undefined {
  return who?.member ? { kind: 'owner', who: who.member.person, agents: who.member.agents } : undefined;
}

/** A member's Comms threads with an unread reply (the dock key's count); 0 when the store can't say. */
function commsUnread(h: Household, m: Member): number {
  try { return threadsOf(h, m).filter((t) => t.unread).length; } catch { return 0; }
}

/** A GET for the app's page rather than its JSON or a stream (Comms' routes answer JSON; a page load gets the app). */
function wantsPage(req: IncomingMessage): boolean {
  return !/application\/json|text\/event-stream/i.test(String(req.headers.accept ?? ''));
}

/**
 * A GET from somewhere else is fine as a top-level navigation (a link in a
 * chat) and refused otherwise: an <img> or fetch from another site, or from
 * another port on this host (same-site, so the cookie rides along), must not
 * make loom run a piece.
 */
function allowedGet(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === undefined || site === 'same-origin' || site === 'none') return true;
  return req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
}

/**
 * A browser POST must come from loom's own page. Sec-Fetch-Site is set by
 * every current browser and can't be forged by a page; Origin, when sent,
 * must name this host. Either one saying "elsewhere" is a refusal.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return false;
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch { return false; }
  }
  return true;
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

/**
 * A body in the best encoding the browser takes (br, else gzip), and the headers that say so. The app's built
 * files are compressed once, at their best, and kept (Jonathan, 2026-10-29: "this site is sloooow": its script
 * went out as 786 KB); a page's data is compressed quickly, when it's big enough to be worth it.
 */
// The first visit after a deploy shouldn't pay for packing the script (a second, at brotli's best): pack them at
// start, off the event loop (zlib's thread pool), so nothing waits on it.
setTimeout(async () => {
  const dir = join(WEB_DIR, 'assets');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const file = join(dir, f);
    if (!/\.(js|css|svg|json)$/.test(f)) continue;
    const body = readFileSync(file);
    // Keep spare zlib workers for response decoding, crypto and cold requests.
    // Enqueuing the entire build here can hold fetch().json() behind Brotli11.
    await packAsset(file, body).catch(() => {});
  }
}, 1_000).unref();
function encoded(req: IncomingMessage, body: Buffer): { body: Buffer; headers: Record<string, string> } {
  const accepts = String(req.headers['accept-encoding'] ?? '');
  const br = /\bbr\b/.test(accepts), gz = /\bgzip\b/.test(accepts);
  if ((!br && !gz) || body.length < 1024) return { body, headers: { vary: 'accept-encoding' } };
  const which = br ? 'br' : 'gzip';
  const compressed = br
    ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : gzipSync(body, { level: 6 });
  return { body: compressed, headers: { 'content-encoding': which, vary: 'accept-encoding' } };
}

async function encodedAsset(req: IncomingMessage, body: Buffer, file: string) {
  const accepts = String(req.headers['accept-encoding'] ?? '');
  const br = /\bbr\b/.test(accepts), gz = /\bgzip\b/.test(accepts);
  if ((!br && !gz) || body.length < 1024) return { body, headers: { vary: 'accept-encoding' } };
  const which = br ? 'br' : 'gzip';
  const both = await packAsset(file, body);
  return { body: both[which], headers: { 'content-encoding': which, vary: 'accept-encoding' } };
}

function redirect(res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { location: to, ...SECURITY_HEADERS, ...extra });
  res.end();
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (d: Buffer) => {
      if (done) return;
      bytes += d.length;
      if (bytes > max) { finish(null); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

async function readForm(req: IncomingMessage, max: number): Promise<URLSearchParams | null> {
  const body = await readBody(req, max);
  return body === null ? null : new URLSearchParams(body);
}

/** A JSON object body (the passkey routes'), or null. */
async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, max);
  if (body === null) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}) =>
  send(res, status, 'application/json', JSON.stringify(body), extra);

/** The page's own query: valid keys only, loom's `_` keys and oversize values dropped. */
function pageQuery(url: URL): Record<string, string> {
  const q: Record<string, string> = Object.create(null);
  let n = 0;
  for (const [k, v] of url.searchParams) {
    if (!QUERY_KEY.test(k) || v.length > LIMITS.queryValue || Object.hasOwn(q, k)) continue;
    if (++n > LIMITS.query) break;
    q[k] = v;
  }
  return q;
}

// ─── One-time result messages ────────────────────────────────────────────────

/** undo: posted to `act` with `path` to land on: where the action came from (the app's toast offers it). */
interface Flash { ok: boolean; message: string; from?: string; keep?: boolean; undo?: { act: string; path: string; action: string; label?: string; fields?: Record<string, string> } }
const flashes = new Map<string, { at: number; flash: Flash }>();

function putFlash(flash: Flash): string {
  const now = Date.now();
  for (const [k, v] of flashes) if (now - v.at > FLASH_TTL_MS || flashes.size > FLASH_MAX) flashes.delete(k);
  const id = randomBytes(12).toString('hex');
  flashes.set(id, { at: now, flash });
  return id;
}

function takeFlash(id: string | null): Flash | undefined {
  if (!id) return undefined;
  const f = flashes.get(id);
  flashes.delete(id);
  return f && Date.now() - f.at <= FLASH_TTL_MS ? f.flash : undefined;
}

// ─── Assembling a page ───────────────────────────────────────────────────────

function clock(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: uiTimeZone(), weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date());
}

function hasPages(p: PieceInfo): boolean {
  return Boolean(p.manifest.tab || p.manifest.legacy?.length);
}

/** On the household's pages: a tab that isn't only each agent's. */
function householdTab(p: PieceInfo): boolean {
  return hasPages(p) && p.manifest.tab?.level !== 'agent';
}

/** The tab a piece puts on each agent's own pages, if any: agentTab, or a tab whose level is 'agent'. */
function agentTabOf(p: PieceInfo): { label: string } | undefined {
  if (p.manifest.agentTab) return p.manifest.agentTab;
  return p.manifest.tab?.level === 'agent' ? { label: p.manifest.tab.label } : undefined;
}

/**
 * A scoped piece's tile on an agent's Today (t-1925): the piece's word for this agent (its `agents` report: its first
 * reading's detail, then each reading as a line), not its household summary ("Art: …" on Mark's window), opening the
 * agent's own tab of it. A first reading named `Next` is a wake to come (docs/extensions.md, "agents"): under it, loom's
 * own record of the agent's last wake. No report for the agent: the piece's tile, as it gave it.
 */
export function agentTile(p: PieceInfo, agent: string, lastWake: TapeEntry | undefined, nowMs: number): HomeTile {
  const tile = p.manifest.tile!;
  const source = pieceSource(p.piece);
  const r = (p.manifest.agents?.[agent]?.readings ?? []).slice(0, 3);
  if (!r.length) return { ...tile, source };
  const [first] = r;
  const lines = r.flatMap((x, n) => (n === 0 && !first.detail ? [] : [`${x.label}: ${x.value}`]));
  if (first.label === 'Next' && lastWake) lines.push(`Last: ${lastWake.title}, ${agoText(lastWake.created, nowMs)}`);
  const tone = r.find((x) => x.tone === 'bad')?.tone ?? r.find((x) => x.tone === 'warn')?.tone;
  return { label: tile.label, value: first.detail ?? first.value, ...(lines.length ? { detail: lines.join('\n') } : {}), ...(tone ? { tone } : {}),
    page: agentTabOf(p) ? `agent:${agent}` : tile.page ?? '', source };
}

/** A piece's pages as one agent's: links and actions stay under /a/<agent>/. */
const agentPieceSource = (agent: string, piece: string): Source => ({ id: piece, base: `/a/${agent}/p/${piece}/`, act: `/a/${agent}/act/${piece}` });

/** Agent marks: an initial on a color; colors differ in lightness, not just hue (the design's rule). */
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Each agent's mark colors: household.json's `marks` when it names valid ones, else the palette in order. */
function agentMarks(h: Household): Record<string, { bg: string; fg: string; face: { shape: string; eyes: string; sprite?: { facings: string[]; v: string; base: string } } }> {
  let custom: Record<string, { bg?: unknown; fg?: unknown }> = {};
  try {
    const raw = JSON.parse(readFileSync(join(h.home, 'household.json'), 'utf-8')) as { marks?: unknown };
    if (raw.marks && typeof raw.marks === 'object') custom = raw.marks as typeof custom;
  } catch { /* none */ }
  return Object.fromEntries(h.agents.map((a, i) => {
    const c = custom[a];
    const colors = c && typeof c.bg === 'string' && HEX.test(c.bg) && typeof c.fg === 'string' && HEX.test(c.fg) ? { bg: c.bg, fg: c.fg } : { bg: MARKS[i % MARKS.length].bg, fg: MARKS[i % MARKS.length].fg };
    const sprite = spriteOf(h, a);
    return [a, { ...colors, face: { ...faceOf(h, a), ...(sprite ? { sprite: { facings: sprite.facings, v: sprite.v, base: `/faces/${a}/` } } : {}) } }];
  }));
}

/** The household's pixel icons, for the shell (src/icon-set.ts): none without a set in use. */
function iconsView(h: Household): { icons?: { v: string; apps: Record<string, { line?: true }> } } {
  const s = iconSetOf(h);
  return s ? { icons: { v: s.v, apps: s.apps } } : {};
}

/** Each agent's name and mark, for drawing marks on rows that name an agent. */
function agentsOf(h: Household | undefined): Record<string, { label: string; bg: string; fg: string; face: { shape: string; eyes: string } }> | undefined {
  if (!h) return undefined;
  const marks = agentMarks(h);
  return Object.fromEntries(h.agents.map((a) => [a, { label: agentName(agentDir(h, a)), ...marks[a] }]));
}

const HOME_THREAD = 30;
/** How many of what needs you a desktop's Home shows whole, to answer where it stands (web/src/desk.tsx). */
const HOME_STACK = 4;

function agentTabs(agent: string, current: string, pieces: PieceInfo[] = []): AgentHead['tabs'] {
  // People are the household's (the nav has them), so an agent's own pages are its day, its mind and how it runs,
  // then each piece's tab for it (its clock, its bridges), before Setup.
  const own = pieces.flatMap((p) => { const t = agentTabOf(p); return t ? [[t.label, `p/${p.piece}`]] : []; })
    .sort((a, b) => a[0].localeCompare(b[0]));
  return [['Today', ''], ['Mind', 'mind'], ...own, ['Setup', 'setup']].map(([label, tab]) => ({ label, href: tab ? `/a/${agent}/${tab}` : `/a/${agent}`, current: tab === current }));
}

/** Your call, everywhere: the household's proposals and every piece's asks (or a lone agent's). For the push watch. */
export async function yourCall(opts: UiOptions): Promise<HomeAsk[]> {
  const { pieces } = await pieceManifests(opts.env);
  const hh = opts.household?.();
  const needs = (a: HomeAsk) => a.attention !== false;
  // Push: the watch's own `hears` lets only household owners hear an ask with no agent (the backup's).
  if (hh) return absorbApprovals([...coreAsks(hh, { householdOwner: !opts.ownerScope }), ...pieceAsks(pieces, opts.env)], opts.env).filter(needs);
  return pieceAsks(pieces, opts.env).filter(needs);
}

/** Who loom's pushes are from (VAPID's subject): its public address, else a placeholder. */
const pushSubject = (opts: UiOptions) => (opts.env.LOOM_PUBLIC_URL?.startsWith('https://') ? opts.env.LOOM_PUBLIC_URL : 'mailto:loom@localhost');

/** One minute's push watch (push.ts): one of loom's listeners announces what's new in Your call. */
export async function pushWatch(opts: UiOptions, send?: Parameters<typeof watch>[3]): Promise<number> {
  const subject = pushSubject(opts);
  const hh = opts.household?.();
  // Asks an agent owner may hear of: loom's own, or a piece's that understands agent owners (owners: 2).
  const ownersOk = new Set((await pieceManifests(opts.env)).pieces.filter((p) => p.manifest.owners === 2).map((p) => pieceSource(p.piece).id));
  // A device hears only of its member's agents; a household ask, only household owners (docs/specs/owners.md).
  const hears = (member: string | undefined, a: { agent?: string; open?: boolean }) => {
    const m = hh ? (member === undefined ? firstOwner(hh) : memberOf(hh, member)) : undefined;
    if (!hh) return true;
    if (!m) return false;
    return m.agents === '*' || (a.open === true && a.agent !== undefined && m.agents.includes(a.agent));
  };
  return watch(storeFor(opts), async () => [...(await yourCall(opts)).map((a) => ({
    key: askKey(a), title: pushTitle(a.kind, a.sourceLabel ?? a.source.id), body: a.text, ...(a.agent ? { agent: a.agent } : {}),
    open: a.source.id === CORE.id || ownersOk.has(a.source.id),
  })), ...(hh ? commsAnnouncements(hh) : [])], subject, send, hears, () => (hh ? firstOwner(hh).person : undefined),
  // A device whose person left the household goes (t-1978); none is the first owner's, who always belongs.
  (member) => !hh || member === undefined || !!memberOf(hh, member));
}

/**
 * Comms replies to push (docs/specs/comms.md, "Notifications"): each thread's newest reply its member hasn't read,
 * when no app of theirs has had that thread in front in the last 2 minutes. Its words never go: the title says who
 * replied, the body is the thread's title (or "in a new thread"). Only its member's devices hear it.
 */
export function commsAnnouncements(h: Household, now = Date.now()): Announce[] {
  const out: Announce[] = [];
  for (const m of h.members) {
    let threads: ReturnType<typeof threadsOf>;
    try { threads = threadsOf(h, m); } catch { continue; }
    for (const t of threads) {
      if (!t.unread || (t.in_front !== null && now - t.in_front < COMMS_IN_FRONT_MS)) continue;
      const name = agentName(agentDir(h, t.agent));
      out.push({ key: `comms-${t.id}-${t.last_reply}`, title: t.title ? `${name} replied` : `${name} replied in a new thread`, body: t.title ?? '',
        agent: t.agent, open: true, member: m.person, url: threadPath(t.id) });
    }
  }
  return out;
}
/** A thread that's been in front this recently (its app's read calls) needs no push. */
const COMMS_IN_FRONT_MS = 2 * 60_000;

/** loom's own asks: an agent's memory proposals waiting to be ratified. */
/** The longest drafted memory Home's card quotes whole, and so lets you ratify there. */
const CARD_QUOTE = 280;

function proposalAsks(h: Household, proposals: Record<string, number>): HomeAsk[] {
  return h.agents.filter((a) => proposals[a] > 0).map((a): HomeAsk => {
    const n = proposals[a];
    const name = agentName(agentDir(h, a));
    // One waiting: the board's card, what it would remember quoted whole, Ratify and Reject right there.
    // Only when all of it fits on the card: nothing is ratified that wasn't shown. Longer ones go to Mind.
    const one = n === 1 ? listProposals(agentDir(h, a)).find((p) => p.status === 'pending') : undefined;
    const said = (one?.content ?? '').replace(/\s+/g, ' ').trim();
    if (one && said && said.length <= CARD_QUOTE) {
      return { text: `${name} wants to remember something`, meta: `“${said}”`, memory: true,
        page: `loom:a/${a}/mind`, agent: a, source: agentSource(a), sourceLabel: 'Mind', ...(one.created ? { at: one.created } : {}),
        actions: [{ action: 'ratify', label: 'Ratify', tone: 'primary', fields: { id: String(one.id) } },
          { action: 'reject', label: 'Reject', fields: { id: String(one.id) } }] };
    }
    return { text: `${name} wants to remember ${n === 1 ? 'something' : `${n} things`}`, meta: 'Ratify or reject what it proposed.', memory: true,
      page: `loom:a/${a}/mind`, label: 'Review', agent: a, source: CORE, sourceLabel: 'Mind' };
  });
}

/** loom's own asks for every agent: memory proposals, then conversations that need the owner. */
export function coreAsks(h: Household, o: { householdOwner?: boolean } = {}): HomeAsk[] {
  // The backup's alert names its target and its errors: a household owner's only, never an agent owner's (ownerScope).
  return [...proposalAsks(h, Object.fromEntries(h.agents.map((a) => [a, pendingProposals(h, a)]))), ...conversationAsks(h), ...(o.householdOwner ? backupAsks(h) : [])];
}

/**
 * The nightly backup's alert (src/backup.ts; docs/specs/keeping-watch.md): its last run failed, or there's been none
 * good in 26 hours. Its text holds while it lasts (pushed once); why is its meta. The household owner's, so no agent.
 */
export function backupAsks(h: Household, nowMs = Date.now()): HomeAsk[] {
  let p: ReturnType<typeof backupProblem>;
  try { p = backupProblem(h, nowMs); } catch { return []; }
  if (!p) return [];
  return [{ kind: 'alert', text: p.text, meta: p.meta.slice(0, 300), at: p.at, page: `loom:a/${h.default}/setup`, label: 'Look', source: CORE, sourceLabel: 'Backup' }];
}

/**
 * Needs you (docs/specs/conversations.md): a conversation whose newest digest has `needs_owner`
 * is an ask from core, linking to the conversation, until a later digest in it has none.
 */
export function conversationAsks(h: Household): HomeAsk[] {
  return h.agents.flatMap((a) => {
    let open: ReturnType<typeof openNeeds>;
    try { open = openNeeds(agentDir(h, a)); } catch { return []; }
    const name = agentName(agentDir(h, a));
    // An alert you can act on (t-1778): its sheet has the whole of it, its links, a box to answer the agent in, Done
    // and Dismiss, all posted to the agent's own actions (/a/<agent>/act/loom: needsAct).
    return open.map(({ conversation: c, digest: d }): HomeAsk => {
      const fields = { conversation: c.id, digest: d.id };
      const where = `${c.label ?? c.place} · ${venueLabel(h.home, c.venue)}`;
      const n = d.needs;
      // An ask written as the object reads as itself: the ask is the headline, its why the row's second line
      // (Jonathan, 2026-11-03: "I don't know wtf that wants from me"). A plain string reads as it always did.
      const plain = n && !n.legacy;
      return {
        kind: 'alert', text: plain ? n.ask : needsAskText(name, d.needs_owner ?? '', true),
        meta: plain ? n.why ?? where : where,
        page: `loom:conversation/${c.id}`, label: 'Open the conversation', agent: a, at: d.at, source: agentSource(a), sourceLabel: 'Conversations',
        ...(d.needs_owner_href ? { href: d.needs_owner_href } : {}),
        ...(n ? { needs: { ...(plain && n.why ? { why: n.why } : {}), ...(n.if_yes ? { if_yes: n.if_yes } : {}), ...(n.if_no ? { if_no: n.if_no } : {}), answers: answersOf(n), refs: n.refs, details: where } } : {}),
        ...(n?.waits_on && 'approval' in n.waits_on ? { waitsOnApproval: n.waits_on.approval } : {}),
        // Asked on another agent's relay (t-1970): it's that agent's request, passed on, so the Inbox says "Mark asks, via Art".
        ...(c.venue === 'relay' && c.place !== a && h.agents.includes(c.place) ? { relayedFrom: c.place } : {}),
        reply: { action: 'needs-reply', label: `Reply to ${name}`, fields },
        actions: [{ action: 'needs-done', label: 'Done', tone: 'primary', fields }, { action: 'needs-dismiss', label: 'Dismiss', fields }],
      };
    });
  });
}

/** How the history says an answered Needs you was answered. */
const ANSWERED: Partial<Record<NeedsVerdict, string>> = { replied: 'You replied', yes: 'You said yes', no: 'You said no', done: 'Done' };

/** The Needs you the owner answered done or replied to in the last week: the Inbox's history of them. */
function answeredAsks(h: Household, nowMs = Date.now()): InboxItem[] {
  const since = new Date(nowMs - 7 * 86_400_000).toISOString();
  return h.agents.flatMap((a) => {
    let done: ReturnType<typeof answeredNeeds>;
    try { done = answeredNeeds(agentDir(h, a), since); } catch { return []; }
    const name = agentName(agentDir(h, a));
    return done.map(({ conversation: c, digest: d, answer }): InboxItem => {
      const source = agentSource(a);
      const text = d.needs && !d.needs.legacy ? d.needs.ask : `${name} needs you: ${d.needs_owner}`;
      // One that cleared itself (what it waited on was resolved) is a quiet FYI that says how.
      if (answer.verdict === 'resolved') {
        return { key: askKey({ source, text, page: `resolved:${answer.at}` }), kind: 'fyi', box: 'done', attention: false, unread: false, text,
          meta: `Cleared itself: ${answer.reason ?? 'what it waited on was resolved'}`, at: answer.at, agent: a, source, sourceLabel: 'Conversations',
          page: `loom:conversation/${c.id}`, ...(d.needs_owner_href ? { href: d.needs_owner_href } : {}) };
      }
      return { key: askKey({ source, text, page: `answered:${answer.at}` }), kind: 'answered', box: 'done', attention: false, unread: false, text,
        outcome: ANSWERED[answer.verdict] ?? 'Done', meta: `${c.label ?? c.place} · ${venueLabel(h.home, c.venue)}`,
        at: answer.at, agent: a, source, sourceLabel: 'Conversations', page: `loom:conversation/${c.id}`, ...(d.needs_owner_href ? { href: d.needs_owner_href } : {}) };
    });
  });
}

/** The longest reply the Inbox takes: the deliver contract's text cap. */
const NEEDS_REPLY_MAX = 40_000;

/**
 * The Needs you sheet's actions, on one agent (t-1778): `needs-reply` delivers the owner's words to the conversation as
 * their own message (deliverAsOwner), and then the ask is answered; `needs-answer` does the same with their Yes or No
 * (`answer`), in words made from the ask's own if_yes or if_no line; `needs-done` and `needs-dismiss` answer it.
 */
async function needsAct(opts: UiOptions, hh: Household, agent: string, action: string, fields: Record<string, string>, person: string): Promise<ActResult> {
  const dir = agentDir(hh, agent);
  const cv = fields.conversation ?? '';
  const name = agentName(dir);
  const c = isConversationId(cv) ? conversationOf(dir, cv) : undefined;
  if (!c) return { ok: false, message: 'That conversation isn\'t one of this agent\'s.' };
  const page = `loom:conversation/${c.id}`;
  const answer = (verdict: NeedsVerdict) => answerNeeds(dir, { conversation: c.id, digest: fields.digest ?? '', verdict, by: person });
  try {
    if (action === 'needs-done') { answer('done'); return { ok: true, message: `Done: ${name}'s ask is answered.` }; }
    if (action === 'needs-dismiss') { answer('dismissed'); return { ok: true, message: 'Dismissed.' }; }
    // Still open: a reply to an ask the agent has moved past goes nowhere it expects.
    const open = openNeeds(dir).find((n) => n.conversation.id === c.id && n.digest.id === fields.digest);
    const yesNo = action === 'needs-answer' ? (fields.answer === 'yes' || fields.answer === 'no' ? fields.answer : null) : undefined;
    if (yesNo === null) return { ok: false, message: 'Answer yes or no.' };
    const text = yesNo && open?.digest.needs ? yesNoText(open.digest.needs, yesNo) : (fields.text ?? '').trim();
    if (!yesNo && !text) return { ok: false, message: `Write what to tell ${name} first.` };
    if (text.length > NEEDS_REPLY_MAX) return { ok: false, message: `That's longer than ${NEEDS_REPLY_MAX.toLocaleString('en-US')} characters.` };
    if (!open || !open.digest.needs) {
      return { ok: false, message: 'That ask isn\'t open any more: the agent wrote since, or it was answered.', page };
    }
    if (yesNo && answersOf(open.digest.needs) !== 'yes-no') return { ok: false, message: `That ask isn't a yes or no: answer ${name} in words.`, page };
    // One that waits on an approval is answered with its Allow or Deny (t-1970): a Yes here would tell the agent yes while
    // nothing was allowed (a grant never applied). Words still go: a reply is not a yes.
    if (yesNo && open.digest.needs.waits_on && 'approval' in open.digest.needs.waits_on) return { ok: false, message: 'That one is answered with Allow or Deny, on the ask.', page };
    // One reply, once: the same words to the same ask are the same delivery.
    const id = `needs:${fields.digest}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
    const r = await deliverAsOwner(opts.env, hh, { id, agent, venue: c.venue, place: c.place, label: c.label, person, text });
    if (r.status !== 200 || 'error' in r.body) return { ok: false, message: `It didn't reach ${name}: ${'error' in r.body ? r.body.error : r.status}`, page };
    // Answered once it's delivered. If it was answered meanwhile (Done pressed while this was on its way: Jonathan,
    // 2026-11-04), the words still reached the agent, so it's Sent, never an error that says they didn't.
    try { answer(yesNo ?? 'replied'); } catch (e) { if (!(e instanceof ConversationError)) throw e; }
    const how = r.body.body === 'failed' ? `It's in the conversation, but ${name} couldn't start (${r.body.reason ?? 'no reason given'}): the runtime tries again.`
      : r.body.body === 'queued' ? `It waits for ${name}: ${r.body.reason ?? 'its body is busy'}.` : `${name} has it.`;
    return { ok: true, message: `Sent. ${how}` };
  } catch (e) {
    if (e instanceof ConversationError) return { ok: false, message: e.message, page };
    throw e;
  }
}

/** How many of an agent's conversations need the owner. */
function needsCount(h: Household, agent: string): number {
  try { return openNeeds(agentDir(h, agent)).length; } catch { return 0; }
}

/**
 * One item, not two (t-1778): a Needs you that waits on an approval absorbs that approval's own card (the approvals
 * piece's ask, found by its Allow's id), so its sheet holds Allow and Deny and the card isn't in the Inbox beside it.
 * Only the agent's own approval: an ask can't take another agent's card under its words. Allow and Deny still post
 * to the approvals piece, as the card's would.
 */
export function absorbApprovals(asks: HomeAsk[], env: NodeJS.ProcessEnv): HomeAsk[] {
  if (!asks.some((a) => a.waitsOnApproval)) return asks;
  const piece = pieceWithRole(env, 'approvals')?.name;
  if (!piece) return asks;
  const src = pieceSource(piece).id;
  const taken = new Set<HomeAsk>();
  const out = asks.map((a) => {
    if (!a.waitsOnApproval) return a;
    const card = asks.find((x) => x.source.id === src && x.agent === a.agent && !!x.text.trim() && x.actions?.some((b) => b.fields?.id === a.waitsOnApproval));
    if (!card) return a;
    // Several conversations can wait on the same decision. Each gets the real actions;
    // remove the standalone card once, while the piece still enforces one decision.
    taken.add(card);
    // A card that leads (a grant, t-1970; a vouch or a reset, t-1975): what Allow gives is the piece's words, never the agent's; its ask is the why.
    const lead = card.lead ? { text: card.text, meta: a.text, ...(a.needs ? { needs: { ...a.needs, why: a.text,
      ...(card.if_yes ? { if_yes: card.if_yes } : {}), ...(card.if_no ? { if_no: card.if_no } : {}) } } : {}) } : {};
    return { ...a, ...lead, approval: { text: card.text, ...(card.meta ? { meta: card.meta } : {}), actions: card.actions!, source: card.source,
      ...(card.if_yes ? { if_yes: card.if_yes } : {}), ...(card.if_no ? { if_no: card.if_no } : {}), ...(card.fine ? { fine: card.fine } : {}), ...(card.details ? { details: card.details } : {}),
      ...(card.conversation && /^cv-[0-9a-f]{12}$/.test(card.conversation) ? { conversation: card.conversation } : {}) } };
  });
  return out.filter((a) => !taken.has(a));
}

/** How many approvals cards a Needs you absorbed (of one agent's, or all): the counts that add asks up take them off once. */
function absorbedCount(h: Household, pieces: PieceInfo[], env: NodeJS.ProcessEnv, agent?: string): number {
  const all = [...conversationAsks(agent ? { ...h, agents: [agent] } : h), ...pieceAsks(pieces, env)];
  return all.length - absorbApprovals(all, env).length;
}

/** Every piece's asks, labelled with its tab, then the Pieces page's own (setup). */
function pieceAsks(pieces: PieceInfo[], env: NodeJS.ProcessEnv): HomeAsk[] {
  return [
    ...pieces.flatMap((p) => p.manifest.asks.map((a) => ({ ...a, source: pieceSource(p.piece), sourceLabel: p.manifest.tab?.label ?? p.piece,
      // An ask laid out (why, what happens either way, details): the Inbox and Home draw it as a Needs you's.
      ...(a.why || a.if_yes || a.if_no ? { needs: { ...(a.why ? { why: a.why } : {}), ...(a.if_yes ? { if_yes: a.if_yes } : {}), ...(a.if_no ? { if_no: a.if_no } : {}),
        answers: 'words' as const, refs: [], details: a.details ?? '' } } : {}) }))),
    ...piecesAsks(env).map((a) => ({ ...a, source: CORE, sourceLabel: 'Pieces', tone: 'warn' as const })),
  ];
}

/**
 * Each agent's card: the worst state any piece reports for it (and that piece's reason), every piece's readings,
 * and what loom itself knows: when it was last on the tape, and where.
 */
function agentCards(h: Household, pieces: PieceInfo[], marks: Record<string, { label: string; bg: string; fg: string }>, nowMs: number): AgentCard[] {
  return h.agents.map((a) => {
    const reports = pieces.flatMap((p) => (p.manifest.agents?.[a] ? [{ p, r: p.manifest.agents[a] }] : []));
    const worst = reports.filter((x) => x.r.state).sort((x, y) => STATE_RANK[y.r.state!] - STATE_RANK[x.r.state!])[0];
    const recentSteps = tapeRows(agentDir(h, a), 72, nowMs).slice(0, 3);
    const last = recentSteps[0];
    const lastLine = last ? `Last: ${last.title}` : 'Quiet for three days';
    const readings = reports.flatMap((x) => x.r.readings.map((r) => ({ ...r, source: pieceSource(x.p.piece) })));
    if (last) readings.push({ label: 'Last seen', value: agoText(last.created, nowMs), detail: whereLabel(last.where), source: agentSource(a), page: '' });
    // What it has going, newest first; and only what's wrong (a reading marked bad or warn): no news is good news.
    const doing = reports.flatMap((x) => (x.r.doing ?? []).map((d) => ({ ...d, source: pieceSource(x.p.piece) })))
      .sort((x, y) => (Date.parse(y.since ?? '') || 0) - (Date.parse(x.since ?? '') || 0)).slice(0, 8);
    const jobs = agentJobs(reports.flatMap(({ p, r }) => (r.jobs ?? []).map((j) => ({ ...j, source: pieceSource(p.piece),
      ...(j.page !== undefined && !j.href ? { href: pageHref(j.page, pieceSource(p.piece)) } : {}) }))));
    const problems = reports.flatMap((x) => x.r.readings.filter((r) => r.tone === 'bad' || r.tone === 'warn')
      .map((r) => ({ text: `${r.label}: ${r.value}`, tone: r.tone as 'bad' | 'warn', source: pieceSource(x.p.piece), ...(r.page !== undefined ? { page: r.page } : {}) })));
    if (worst && (worst.r.state === 'broken' || worst.r.state === 'unavailable') && worst.r.reason && !problems.some((p) => p.text.includes(worst.r.reason!))) {
      problems.unshift({ text: worst.r.reason, tone: worst.r.state === 'broken' ? 'bad' : 'warn', source: pieceSource(worst.p.piece) });
    }
    // The same as agentStateOf (the system bar's agents at work): doing is never empty when a report has some.
    const state: AgentState = worst?.r.state ?? (doing.length || jobs.some((j) => j.status === 'running') ? 'working' : 'available');
    const reason = worst?.r.reason ?? (doing.length ? doing[0].text : lastLine);
    // What's moving (Home's list): each piece that says it's working, in the pieces' order.
    const moving = reports.filter((x) => x.r.state === 'working').map((x) => ({ agent: a, text: x.r.reason ?? `${marks[a].label} is working`, meta: x.p.manifest.tab?.label ?? x.p.piece }));
    return { id: a, ...marks[a], state, reason, doing, jobs, moving, problems: problems.slice(0, 3), ...(last ? { seen: { at: last.created, where: whereLabel(last.where) } } : {}), readings: readings.slice(0, 6), steps: recentSteps.map((s) => ({ text: s.title, at: s.created, where: whereLabel(s.where) })) };
  });
}

/** The open Inbox item `match` finds, as the member answering sees it now (their Inbox's own), before an answer takes it
 * out: what its Comms thread keeps (comms-asks.ts recordAnswer). Never fails an answer: none on any trouble. */
function askBefore(hh: Household, pieces: PieceInfo[], opts: UiOptions, match: (it: InboxItem) => boolean): InboxItem | undefined {
  try { return inboxItems(hh, pieces, opts.env, [], !opts.ownerScope).find((it) => it.box !== 'done' && match(it)); } catch { return undefined; }
}

/** The approvals the household owner alone answers (the approvals piece's lead cards: a grant, a vouch, a reset). */
export function leadIds(pieces: PieceInfo[], env: NodeJS.ProcessEnv): Set<string> {
  const src = pieceWithRole(env, 'approvals')?.name;
  const p = src ? pieces.find((x) => x.piece === src) : undefined;
  return new Set((p?.manifest.asks ?? []).filter((a) => a.lead).flatMap((a) => (a.actions ?? []).map((b) => b.fields?.id).filter((x): x is string => typeof x === 'string')));
}

/** Everything the Inbox files: the asks (loom's and every piece's), the pieces' notices and what they've answered, and
 * what the owner's own actions said (their toasts, as FYI), newest first. */
function inboxItems(h: Household, pieces: PieceInfo[], env: NodeJS.ProcessEnv, done: Done[] = [], householdOwner = false): InboxItem[] {
  const asks = absorbApprovals([...coreAsks(h, { householdOwner }), ...pieceAsks(pieces, env)], env);
  const items: InboxItem[] = [
    // An ask with no kind is a decision only if it has something to choose with (its buttons); else it's an alert.
    ...asks.map((a): InboxItem => ({ key: askKey(a), kind: askKind(a), box: inboxBox({ ...a, kind: askKind(a), attention: a.attention !== false }), attention: a.attention !== false, unread: false,
      text: a.text, meta: a.meta, at: a.at, expires: a.expires, agent: a.agent, source: a.source, sourceLabel: a.sourceLabel, page: a.page, label: a.label, actions: a.actions,
      ...(a.href ? { href: a.href } : {}), ...(a.reply ? { reply: a.reply } : {}), ...(a.needs ? { needs: a.needs } : {}), ...(a.approval ? { approval: a.approval } : {}),
      ...(a.waitsOnApproval ? { waitsOnApproval: a.waitsOnApproval } : {}),
      ...(a.fine ? { fine: a.fine } : {}), ...(a.relayedFrom ? { relayedFrom: a.relayedFrom } : {}),
      ...(a.conversation && /^cv-[0-9a-f]{12}$/.test(a.conversation) ? { conversation: a.conversation } : {}) })),
    ...pieces.flatMap((p) => {
      const source = pieceSource(p.piece);
      const sourceLabel = p.manifest.tab?.label ?? p.piece;
      return [
        ...(p.manifest.notices ?? []).map((n): InboxItem => ({ key: askKey({ source, text: n.text, page: `fyi:${n.at}` }), kind: 'fyi', box: 'done', attention: false, unread: false,
          text: n.text, meta: n.meta, at: n.at, agent: n.agent, source, sourceLabel, page: n.page })),
        ...(p.manifest.answered ?? []).map((a): InboxItem => ({ key: askKey({ source, text: a.text, page: `answered:${a.at}` }), kind: 'answered', box: 'done', attention: false, unread: false,
          text: a.text, outcome: a.outcome, at: a.at, agent: a.agent, source, sourceLabel, page: a.page })),
      ];
    }),
    ...answeredAsks(h),
    // The backup back to good (src/backup.ts): an FYI, the household owner's.
    ...(() => { if (!householdOwner) return []; const f = backupFyi(h); return f ? [{ key: askKey({ source: CORE, text: f.text, page: `fyi:${f.at}` }), kind: 'fyi' as const, box: 'done' as const, attention: false, unread: false,
      text: f.text, meta: f.meta, at: f.at, source: CORE, sourceLabel: 'Backup', page: `loom:a/${h.default}/setup` } satisfies InboxItem] : []; })(),
    ...done.map((d): InboxItem => ({ key: askKey({ source: d.source, text: d.text, page: `done:${d.at}` }), kind: 'fyi', box: 'done', attention: false, unread: false,
      text: d.text, meta: d.ok ? 'You did this' : 'You tried this; it wasn’t done', at: new Date(d.at * 1000).toISOString(),
      source: d.source, sourceLabel: d.sourceLabel ?? 'loom', ...(d.page ? { page: d.page } : {}) })),
  ];
  // Newest first; an ask with no time stays where its piece put it, ahead of the dated ones.
  const t = (it: InboxItem) => (it.at ? Date.parse(it.at) : Number.POSITIVE_INFINITY);
  return items.map((it, i) => ({ it, i })).sort((x, y) => t(y.it) - t(x.it) || x.i - y.i).map((x) => x.it);
}

/**
 * The attention records (core's `attention` type, src/collections/core-types.ts; t-2025): one member's Inbox items as
 * the Inbox itself builds them for them (their agents, the pieces that understand them, their read state and their own
 * outcomes), so a badge, Home, the Inbox and a thread's ask card read one set. For the core viewer: every member's,
 * once each, without anyone's own read state, and with how many members have opened each, so a read moves it.
 */
/**
 * "Something changed" (live.ts: an action, a piece's manifest moving) moves the attention records: a nudge, at most one
 * per GAP_MS a household (a burst costs one write; one inside the gap lands at its end). The stores' own file changes
 * aren't heard here: building the records reads them, and that reading writes to them, so hearing it would rebuild the
 * records forever (measured: every 1.5 s, with nothing changing). An agent's ask nudges itself (the digest tool,
 * src/server.ts); anything else of theirs waits for the 15 s pull.
 */
const nudgedAt = new Map<string, number>();
const nudgeLater = new Map<string, NodeJS.Timeout>();
/** How many times each household's attention records were built (the echo test counts them). */
const builds = new Map<string, number>();
export const attentionBuilds = (home: string): number => builds.get(home) ?? 0;

/** The same for any other domain loom's bare "something changed" moves (one timer per home and domain). */
const liveNudgedAt = new Map<string, number>();
const liveNudgeLater = new Map<string, NodeJS.Timeout>();
function nudgeLive(home: string, domain: string): void {
  const k = `${home}\0${domain}`;
  if (liveNudgeLater.has(k)) return;
  const wait = Math.max(0, (liveNudgedAt.get(k) ?? 0) + GAP_MS - Date.now());
  const go = () => { liveNudgeLater.delete(k); liveNudgedAt.set(k, Date.now()); nudge(home, domain); };
  if (!wait) { go(); return; }
  const t = setTimeout(go, wait);
  t.unref?.();
  liveNudgeLater.set(k, t);
}

function nudgeAttention(home: string): void {
  if (nudgeLater.has(home)) return;
  const wait = Math.max(0, (nudgedAt.get(home) ?? 0) + GAP_MS - Date.now());
  const go = () => { nudgeLater.delete(home); nudgedAt.set(home, Date.now()); nudge(home, ATTENTION_DOMAIN); };
  if (!wait) { go(); return; }
  const t = setTimeout(go, wait);
  t.unref?.();
  nudgeLater.set(home, t);
}

async function memberInbox(base: UiOptions, full: Household, m: Member): Promise<{ items: InboxItem[]; reader?: string }> {
  const own = m.agents === '*' ? undefined : m.agents.filter((a) => full.agents.includes(a));
  const hh = own ? narrowed(full, own) : full;
  const env = own ? { ...base.env, LOOM_OWNER_SCOPE: own.join(',') } : base.env;
  const pieces = forOwner((await pieceManifests(env)).pieces, own);
  const reader = m.person === firstOwner(full).person ? undefined : m.person;
  const store = storeFor(base);
  const items = inboxItems(hh, pieces, env, store.doneItems(reader), !own);
  const opened = store.openedAt(reader);
  for (const it of items) {
    it.unread = it.attention && !opened.has(it.key);
    const at = opened.get(it.key);
    if (at) it.seen = new Date(at * 1000).toISOString();
  }
  return { items, reader };
}

/** An Inbox item as a record: its key is its id, its time its sort (one with no time first, as the Inbox files it). */
export function attentionRecord(it: InboxItem, audience: Record<string, unknown>, perViewer: boolean): MemRecord {
  const t = it.at ? Date.parse(it.at) : NaN;
  const exp = it.expires ? Date.parse(it.expires) : NaN;
  const { key, expires: _e, unread, seen, ...rest } = it;
  return {
    ...rest, id: key, audience, sort: Number.isFinite(t) ? t : 8.64e15,
    ...(Number.isFinite(exp) ? { expires: exp } : {}),
    ...(perViewer ? { unread, ...(seen ? { seen } : {}) } : {}),
  } as MemRecord;
}

/**
 * One build per viewer at a time, and at most one queued after it: however many subscriptions a viewer holds (six
 * streams of 64), the re-asks a change sets off cost that viewer one build, or two, never one each. A re-ask never joins
 * a build already under way (it may have read before the change it was asked for): it shares the one queued after it.
 */
const slots = new Map<string, { cur: Promise<MemRecord[]>; next?: Promise<MemRecord[]> }>();

function attentionFor(base: UiOptions, viewer: Viewer): Promise<MemRecord[]> {
  const full = base.household?.();
  if (!full || viewer.kind === 'agent') return Promise.resolve([]);
  const k = `${full.home}\0${viewerId(viewer)}`;
  const run = (): Promise<MemRecord[]> => {
    // The household as it is when the build starts (a queued one may start after a member was added).
    const now = base.household?.() ?? full;
    const p: Promise<MemRecord[]> = buildAttention(base, now, viewer).finally(() => {
      builds.set(full.home, (builds.get(full.home) ?? 0) + 1);
      const s = slots.get(k);
      if (s?.cur === p && !s.next) slots.delete(k);
    });
    return p;
  };
  const s = slots.get(k);
  if (!s) { const cur = run(); slots.set(k, { cur }); return cur; }
  s.next ??= s.cur.catch(() => undefined).then(() => { const cur = run(); slots.set(k, { cur }); return cur; });
  return s.next;
}

async function buildAttention(base: UiOptions, full: Household, viewer: Viewer): Promise<MemRecord[]> {
  if (viewer.kind === 'member') {
    const m = full.members.find((x) => x.person === viewer.person);
    if (!m) return [];
    const { items } = await memberInbox(base, full, m);
    // Each item is this member's own Inbox's: theirs alone, whoever else's Inbox has the same one.
    return items.map((it) => attentionRecord(it, { members: [viewer.person] }, true));
  }
  // Each item's audience is exactly the members whose Inbox has it (a member's own outcome is theirs alone; a scoped
  // piece's answer is that owner's), never a wider term: anything that reads these as the core viewer (push, Needs
  // auto-resolve) filters for a person by it.
  const store = storeFor(base);
  const all = new Map<string, MemRecord>();
  const whose = new Map<string, string[]>();
  const reads = new Map<string, number>();
  // Each member's own copy, as a digest: two members' copies of one item can differ (their pieces, absorbed approvals),
  // so one that moves in a copy other than the first moves the record too, and its member is asked again.
  const copies = new Map<string, ReturnType<typeof createHash>>();
  for (const m of full.members) {
    const { items, reader } = await memberInbox(base, full, m);
    const opened = store.openedKeys(reader);
    for (const it of items) {
      if (opened.has(it.key)) reads.set(it.key, (reads.get(it.key) ?? 0) + 1);
      whose.set(it.key, [...(whose.get(it.key) ?? []), m.person]);
      const rec = attentionRecord(it, {}, false);
      if (!copies.has(it.key)) copies.set(it.key, createHash('sha256'));
      copies.get(it.key)!.update(`${m.person}\0${JSON.stringify(rec)}\0`);
      if (!all.has(it.key)) all.set(it.key, rec);
    }
  }
  return [...all.values()].map((r) => ({ ...r, audience: { members: whose.get(r.id)! }, reads: reads.get(r.id) ?? 0, copies: copies.get(r.id)!.digest('base64url').slice(0, 22) }));
}

/**
 * The agent-status records (core's `agent-status` type, src/collections/core-types.ts; t-2028): each agent's card as
 * Home's own code makes it for this member (agentCards over their pieces, atWorkFor: a Comms thread's job is its
 * member's alone), so the desktop's cards, the rail, the bar's agents at work and Home read one set. For the core
 * viewer: each agent once, its audience exactly the members who own it, with a digest of every member's own copy (two
 * members' copies differ by their threads' jobs), so a change to any copy moves it and that member is asked again.
 */
async function memberCards(base: UiOptions, full: Household, m: Member): Promise<AgentCard[]> {
  const own = m.agents === '*' ? undefined : m.agents.filter((a) => full.agents.includes(a));
  const hh = own ? narrowed(full, own) : full;
  const env = own ? { ...base.env, LOOM_OWNER_SCOPE: own.join(',') } : base.env;
  const pieces = atWorkFor(forOwner((await pieceManifests(env)).pieces, own), full, m);
  return agentCards(hh, pieces, agentsOf(hh)!, Date.now());
}

/** A card as a record: its agent is its id. */
const statusRecord = (c: AgentCard, audience: Record<string, unknown>): MemRecord => {
  const { id, ...rest } = c;
  return { ...rest, id, agent: id, running: (c.jobs ?? []).filter((j) => j.status === 'running').length, audience } as MemRecord;
};

const statusSlots = new Map<string, { cur: Promise<MemRecord[]>; next?: Promise<MemRecord[]> }>();
/** How many times each household's agent-status records were built (tests). */
const statusBuilds = new Map<string, number>();
export const agentStatusBuilds = (home: string): number => statusBuilds.get(home) ?? 0;

/** One build per viewer at a time, and at most one queued after it (attentionFor's rule). */
function agentStatusFor(base: UiOptions, viewer: Viewer): Promise<MemRecord[]> {
  const full = base.household?.();
  if (!full || viewer.kind === 'agent') return Promise.resolve([]);
  const k = `${full.home}\0${viewerId(viewer)}`;
  const run = (): Promise<MemRecord[]> => {
    const now = base.household?.() ?? full;
    const p: Promise<MemRecord[]> = buildAgentStatus(base, now, viewer).finally(() => {
      statusBuilds.set(full.home, (statusBuilds.get(full.home) ?? 0) + 1);
      const s = statusSlots.get(k);
      if (s?.cur === p && !s.next) statusSlots.delete(k);
    });
    return p;
  };
  const s = statusSlots.get(k);
  if (!s) { const cur = run(); statusSlots.set(k, { cur }); return cur; }
  s.next ??= s.cur.catch(() => undefined).then(() => { const cur = run(); statusSlots.set(k, { cur }); return cur; });
  return s.next;
}

async function buildAgentStatus(base: UiOptions, full: Household, viewer: Viewer): Promise<MemRecord[]> {
  if (viewer.kind === 'member') {
    const m = full.members.find((x) => x.person === viewer.person);
    if (!m) return [];
    // This member's own copy of each card (their threads' jobs): theirs alone.
    return (await memberCards(base, full, m)).map((c) => statusRecord(c, { members: [viewer.person] }));
  }
  // The snapshot holds no member's card, only that one moved: a card carries its member's own threads' jobs (their titles
  // and links), and the snapshot's audience is every owner of the agent. What anyone is shown is asked again as them.
  // A card's "Last seen 3 min ago" is left out of the digest: it moves every minute with nothing else moving, and
  // would ask every viewer again each time. The window says it again from `seen.at` (web/src/agents-live.ts freshCard).
  const whose = new Map<string, string[]>();
  const copies = new Map<string, ReturnType<typeof createHash>>();
  for (const m of full.members) {
    for (const c of await memberCards(base, full, m)) {
      const rec = statusRecord({ ...c, readings: c.readings.filter((r) => r.label !== 'Last seen') }, {});
      whose.set(c.id, [...(whose.get(c.id) ?? []), m.person]);
      if (!copies.has(c.id)) copies.set(c.id, createHash('sha256'));
      copies.get(c.id)!.update(`${m.person}\0${JSON.stringify(rec)}\0`);
    }
  }
  return [...whose].map(([agent, members]) => ({ id: agent, agent, audience: { members }, copies: copies.get(agent)!.digest('base64url').slice(0, 22) } as MemRecord));
}

/** Find's groups beyond the places: asks that match (Do), and, in a household, knowledge, people and the scope's memories. */
function findAll(q: string, req: IncomingMessage, opts: UiOptions, pieces: PieceInfo[]): Found {
  const needle = q.toLowerCase();
  const hh = opts.household?.();
  const asks = absorbApprovals([...(hh ? coreAsks(hh, { householdOwner: !opts.ownerScope }) : []), ...pieceAsks(pieces, opts.env)], opts.env);
  const found: Found = {
    do: asks.filter((a) => `${a.text} ${a.label ?? ''} ${a.sourceLabel ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 5).map((a) => ({ label: a.text, href: a.page !== undefined ? pageHref(a.page, a.source) : '/' })),
    knowledge: [], people: [], memories: [],
  };
  if (!hh) return found;
  const scope = scopeOf(req, hh);
  const f = householdFind(hh, q, scope === 'household' ? hh.agents : [scope]);
  // Knowledge and People are the household's: an agent owner's Find searches their agents' memories only.
  found.knowledge = opts.ownerScope ? [] : f.knowledge.map((k) => ({ label: k.title, href: `/knowledge/${k.slug}` }));
  found.people = opts.ownerScope ? [] : f.people.map((p) => ({ label: p.name, href: `/people/${p.slug}` }));
  found.memories = f.memories.map((m) => ({ label: m.title, href: pageHref(`memory/${m.ref}`, agentSource(m.agent)), agent: m.agent }));
  return found;
}

/** A page below the top level goes back to its parent, by name; a top-level page goes Home. */
function backFor(path: string, places: Array<{ label: string; href: string }>, h?: Household): { label: string; href: string } | undefined {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'knowledge' && seg.length > 1) return { label: 'Knowledge', href: '/knowledge' };
  if (seg[0] === 'people' && seg.length > 1) return { label: 'People', href: '/people' };
  if (seg[0] === 'projects' && seg.length > 1) return { label: 'Projects', href: '/projects' };
  if (seg[0] === 'memory') return { label: 'Mind', href: '/mind' };
  if (seg[0] === 'p' && seg.length > 2) {
    const top = places.find((x) => x.href === `/p/${seg[1]}`);
    if (top) return { label: top.label, href: top.href };
  }
  if (seg[0] === 'a' && h && seg.length > 2 && h.agents.includes(seg[1])) {
    const a = seg[1];
    if (seg[2] === 'memory') return { label: 'Mind', href: `/a/${a}/mind` };
    if (seg[2] === 'people' && seg.length > 3) return { label: 'People', href: `/a/${a}/people` };
    // Its Mind, People and Setup are tabs of its Today, which carry the way around.
    if (seg.length === 3 && ['mind', 'people', 'setup'].includes(seg[2])) return undefined;
    return { label: agentName(agentDir(h, a)), href: `/a/${a}` };
  }
  return undefined;
}

function pendingProposals(h: Household, agent: string): number {
  try { return listProposals(agentDir(h, agent)).filter((p) => p.status === 'pending').length; } catch { return 0; }
}

/** Which catalog pieces a fresh loom suggests first: talk in chat, then a work store. */
export const STARTERS = ['shuttle', 'tasks', 'box', 'secrets'].map((n) => aliasTarget(n) ?? n);

/** A loom with no pieces yet: who's listening, and two pieces to give them hands. */
function firstRun(names: string[]): NonNullable<Dashboard['firstRun']> {
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const line = names.length === 1 ? `${who} is here and listening. Add pieces to give ${who} hands.` : `${who} are here and listening. Add pieces to give them hands.`;
  const catalog = readCatalog();
  const rank = (n: string) => (STARTERS.includes(n) ? STARTERS.indexOf(n) : STARTERS.length);
  const starters = [...catalog].sort((a, b) => rank(a.name) - rank(b.name)).slice(0, 2).map((c) => ({
    name: c.name, label: c.label ?? c.name,
    // The catalog's first clause is the short "what it does".
    what: (c.description ?? '').split(/(?<=\w)[.:](\s|$)/)[0],
  }));
  return { line, starters };
}

/** "7:42 AM", in the page's time zone. */
/** "active 42m ago" from an agent's latest episode (the Scope sheet's line under each agent), or "quiet for 3 days". */
function lastActive(dir: string, nowMs = Date.now()): string {
  const last = tapeRows(dir, 72, nowMs)[0];
  if (!last) return 'quiet for 3 days';
  return `active ${agoText(last.created, nowMs)}`;
}

const SCOPE_COOKIE = 'loom_scope';

/** The scope the owner chose (a cookie), if it still names an agent in the household. */
/**
 * Whose pages these are: the household's, always, unless the address is an agent's own (/a/<id>).
 * There's no picker any more (t-1625): the loom's pages are the household's, an agent's are under /a/.
 * An old loom_scope cookie is ignored (and /scope/<id> clears it).
 */
function scopeOf(_req: IncomingMessage, _h: Household | undefined): string {
  return 'household';
}

/** An ask's kind: its own, else a decision only if it has something to choose with (its buttons), else an alert
 * (docs/extensions.md; the Inbox's folders). */
const askKind = (a: { kind?: AskKind; actions?: unknown[] }): AskKind => a.kind ?? (a.actions?.length ? 'decision' : 'alert');

/** A piece's asks that say something's wrong (an alert, counted), for the system bar (web/src/system-bar.tsx). */
function alertsOf(p: PieceInfo): { alerts?: number } {
  const n = p.manifest.asks.filter((a) => askKind(a) === 'alert' && a.attention !== false).length;
  return n ? { alerts: n } : {};
}

/** The nightly backup as the system bar says it: its last good one, or what's wrong (backupRow, Setup's row). Its
 * settings or state unreadable (a hand-edited household.json, a half-written state.json): no glyph, not a broken page. */
function backupOf(h: Household, nowMs = Date.now()): { backup?: Shell['backup'] } {
  try {
    const r = backupRow(h, nowMs, (iso) => agoText(iso, nowMs) || 'a while ago');
    return { backup: { tone: r.tone, text: r.text, href: `/a/${h.default}/setup` } };
  } catch { return {}; }
}

/** An agent's state as its Home card says it (agentCards): the worst any piece reports, else working if a piece has
 * something it's doing, else available. */
const STATE_RANK: Record<AgentState, number> = { broken: 3, unavailable: 2, working: 1, available: 0 };
function agentStateOf(pieces: PieceInfo[], agent: string): AgentState {
  const reports = pieces.flatMap((p) => (p.manifest.agents?.[agent] ? [p.manifest.agents[agent]] : []));
  const worst = reports.filter((r) => r.state).sort((x, y) => STATE_RANK[y.state!] - STATE_RANK[x.state!])[0];
  return worst?.state ?? (reports.some((r) => (r.doing?.length ?? 0) > 0 || r.jobs?.some((j) => j.status === 'running')) ? 'working' : 'available');
}

/**
 * The Profile app's head and its "Your agents" (web/src/account.tsx; t-1925): the member's name as People has it, when
 * they became a member (their oldest owner token: the household keeps no other date for a member), and each agent they
 * own with its mark and its state (agentStateOf). Nothing here is a secret: only names, a month and states.
 */
function profileOf(h: Household, m: Member, pieces: PieceInfo[], tz: string): { full?: string; since?: string; agents: Array<{ id: string; label: string; bg: string; fg: string; face: unknown; state: AgentState }> } {
  const first = firstOwner(h).person === m.person;
  let oldest: number | undefined;
  try {
    for (const t of loadTokens(h.home)) {
      if (t.role !== 'owner' || !(t.member === m.person || (first && !t.member))) continue;
      const at = Date.parse(t.created);
      if (Number.isFinite(at) && (oldest === undefined || at < oldest)) oldest = at;
    }
  } catch { /* no tokens file readable: no date */ }
  const since = oldest === undefined ? undefined : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', year: 'numeric' }).format(new Date(oldest));
  const full = householdPersonName(h, m.person);
  const marks = agentMarks(h);
  const owned = m.agents === '*' ? h.agents : h.agents.filter((a) => (m.agents as string[]).includes(a));
  const agents = owned.map((a) => ({ id: a, label: agentName(agentDir(h, a)), ...marks[a], state: agentStateOf(pieces, a) }));
  return { ...(full ? { full } : {}), ...(since ? { since } : {}), agents };
}

/** An agent at work, as its Home card would say it (agentStateOf). */
function workingOf(pieces: PieceInfo[], agent: string): { working?: true } {
  return agentStateOf(pieces, agent) === 'working' ? { working: true } : {};
}

/** The one thing an agent is on, newest first, as its card's line says it (agentCards): for its window's pill. */
function onOf(pieces: PieceInfo[], agent: string): { on?: { text: string; href?: string } } {
  const d = pieces.flatMap((p) => { const r = p.manifest.agents?.[agent]; return r?.doing?.length ? r.doing : (r?.jobs ?? []).filter((j) => j.status === 'running'); }).sort((x, y) => (Date.parse(y.since ?? '') || 0) - (Date.parse(x.since ?? '') || 0))[0];
  return d ? { on: { text: d.text, ...(d.href ? { href: d.href } : {}) } } : {};
}

/** Only fresh producer observations, after atWorkFor has applied membership. Never job/episode timestamps. */
export function tickerActivityOf(pieces: PieceInfo[], agent: string, now = Date.now()) {
  const ds = pieces.flatMap(p => p.manifest.agents?.[agent]?.doing ?? [])
    .filter(d => d.activity && Date.parse(d.activity.observedAt) <= now && Date.parse(d.activity.expiresAt) > now)
    .sort((a, b) => Date.parse(b.activity!.observedAt) - Date.parse(a.activity!.observedAt));
  const d = ds[0];
  if (!d?.activity) {
    // An idle producer cannot account for another source's work without an observation.
    if (pieces.some(p => p.manifest.agents?.[agent]?.doing?.length)) return {};
    const idle = pieces.flatMap(p => p.manifest.agents?.[agent]?.idle ? [p.manifest.agents[agent].idle!] : [])
      .find(i => Date.parse(i.observedAt) <= now && Date.parse(i.expiresAt) > now);
    return idle ? { activity: { action: 'Idle', ...idle } } : {};
  }
  // The venue is a fixed category, never a conversation label or excerpt.
  const where = d.kind === 'lane' ? 'a wake' : ['Comms', 'Discord', 'Slack', 'Signal'].includes(d.where ?? '') ? d.where : d.kind === 'talk' ? 'a conversation' : 'a session';
  return { activity: { ...d.activity, where, ...(d.href ? { href: d.href } : {}) } };
}

function chrome(req: IncomingMessage, opts: UiOptions, pieces: PieceInfo[], skipped: string[], current: string, csrf: string, flash?: Flash): Chrome {
  const tabs = pieces.filter(householdTab)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/p/${p.piece}`, current: current === `p/${p.piece}`, piece: true }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const kinds = catalogKinds();
  const places = pieces.filter(householdTab)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/p/${p.piece}`, current: current === `p/${p.piece}`, tone: p.manifest.tile?.tone, stat: p.manifest.tile?.value,
      kind: p.manifest.tab?.kind ?? kinds[p.piece] ?? 'place', ...(p.manifest.tab?.icon ? { icon: p.manifest.tab.icon } : {}),
      ...(p.manifest.tab?.accent ? { accent: p.manifest.tab.accent } : {}),
      ...(p.manifest.tab?.fit ? { fit: p.manifest.tab.fit } : {}),
      ...alertsOf(p) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // The Inbox's count: what needs the owner (an ask that says nothing waits on it is filed, not counted), the
  // same number its Needs you shows, so the badge is never a 1 for something already answered.
  const needs = pieces.reduce((n, p) => n + p.manifest.asks.filter((a) => a.attention !== false).length, 0) + piecesAsks(opts.env).length;
  const tab = current === '' ? 'home' : ['places', 'scope', 'find', 'setup', 'appearance', 'accessibility', 'account'].includes(current) ? current : '';
  const h = opts.household?.();
  const back = backFor(new URL(req.url ?? '/', 'http://loom.invalid').pathname, places, h);
  if (h) {
    const marks = agentMarks(h);
    const asks = needs + h.agents.filter((a) => pendingProposals(h, a) > 0).length + h.agents.reduce((n, a) => n + needsCount(h, a), 0) - absorbedCount(h, pieces, opts.env)
      + (opts.ownerScope ? 0 : backupAsks(h).length);
    const scope = /^a\/([^/]+)/.exec(current)?.[1] ?? scopeOf(req, h);
    return {
      agent: h.owner ? `${h.owner}'s household` : 'household',
      nav: [
        { label: 'Home', href: '/', current: current === '', piece: false },
        // Knowledge, People and Pieces are the household's: not an agent owner's (docs/specs/owners.md).
        ...(opts.ownerScope ? [] : [
          { label: 'Knowledge', href: '/knowledge', current: current === 'knowledge', piece: false },
          { label: 'People', href: '/people', current: current === 'people', piece: false },
          { label: 'Pieces', href: '/pieces', current: current === 'pieces', piece: false },
        ]),
        ...h.agents.map((a) => ({ label: agentName(agentDir(h, a)), href: `/a/${a}`, current: current === `a/${a}`, piece: true })),
        ...tabs,
      ],
      clock: clock(),
      tz: uiTimeZone(),
      csrf,
      flash,
      skipped,
      shell: {
        owner: opts.viewer ?? h.owner ?? firstOwner(h)?.person ?? 'owner', scope, household: true, asks, tab, back, admin: !opts.ownerScope,
        ...(opts.ownerScope ? {} : backupOf(h)),
        ...(opts.ownerScope ? {} : permissionsOf(opts.env)),
        ...iconsView(h),
        home: '/',
        agents: h.agents.map((a) => ({ id: a, label: agentName(agentDir(h, a)), ...marks[a], href: `/a/${a}`, current: scope === a,
          asks: pendingProposals(h, a) + needsCount(h, a) + pieces.reduce((n, p) => n + p.manifest.asks.filter((x) => x.agent === a && x.attention !== false).length, 0) - absorbedCount(h, pieces, opts.env, a),
          sub: lastActive(agentDir(h, a)), ...workingOf(pieces, a), ...tickerActivityOf(pieces, a), ...(!pieces.some(p => p.piece === 'runtime') || ['unavailable', 'broken'].includes(agentStateOf(pieces, a)) ? { activityUnavailable: true } : {}) })),
        core: [
          // Memory proposals are one ask an agent (proposalAsks), like the Inbox shows them.
          { label: 'Activity', href: '/activity', current: current === 'activity' },
          { label: 'Inbox', href: '/inbox', current: current === 'inbox', count: asks },
          ...(opts.ownerScope ? [] : [
            { label: 'Knowledge', href: '/knowledge', current: current.startsWith('knowledge') },
            { label: 'People', href: '/people', current: current.startsWith('people') },
            // The household's, like People (docs/specs/projects.md, "the Projects app").
            { label: 'Projects', href: '/projects', current: current.startsWith('projects') },
          ]),
          // Comms (docs/specs/comms.md): a member who owns an agent talks with it here; its count is their unread threads.
          ...(opts.member && h.agents.some((a) => owns(opts.member, a)) ? [{ label: 'Comms', href: '/comms', current: current.startsWith('comms'), count: commsUnread(h, opts.member) }] : []),
        ],
        pieces: places,
      },
    };
  }
  const name = agentName(opts.contextDir);
  return {
    agent: name,
    nav: [
      { label: 'Home', href: '/', current: current === '', piece: false },
      { label: 'Mind', href: '/mind', current: current === 'mind', piece: false },
      { label: 'People', href: '/people', current: current === 'people', piece: false },
      { label: 'Pieces', href: '/pieces', current: current === 'pieces', piece: false },
      ...tabs,
    ],
    clock: clock(),
    tz: uiTimeZone(),
    csrf,
    flash,
    skipped,
    shell: {
      owner: 'owner', scope: 'agent', household: false, asks: needs, tab, home: '/', back,
      agents: [{ id: 'agent', label: name, bg: MARKS[0].bg, fg: MARKS[0].fg, href: '/', current: true }],
      core: [
        { label: 'Mind', href: '/mind', current: current === 'mind' },
        { label: 'People', href: '/people', current: current.startsWith('people') },
        { label: 'Projects', href: '/projects', current: current.startsWith('projects') },
      ],
      pieces: places,
    },
  };
}

/** Where to land after an action: the page the piece names, or back where the form was. */
function landing(source: Source, result: ActResult, back: string): string {
  // Answered from the Inbox: back to the Inbox, whatever page the action would show next.
  if (splitPage(back)?.core && splitPage(back)?.path === 'inbox') return pageHref(back, source);
  const link = result.page !== undefined && splitPage(result.page) ? result.page : splitPage(back) ? back : '';
  return pageHref(link, source);
}

function withFlash(to: string, id: string): string {
  return `${to}${to.includes('?') ? '&' : '?'}_flash=${id}`;
}

const notFound: Page = { title: 'Not found', sections: [] };

/** decodeURIComponent, or null for a malformed escape (a 404, never a 500). */
function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** Handle a request for the page. The caller has already matched isUiRequest. */
export async function handleUi(req: IncomingMessage, res: ServerResponse, pathname: string, opts: UiOptions): Promise<void> {
  // No token, no page: an open /ui would be readable by any site that
  // DNS-rebinds a name to the loopback address (the same rule as /cli).
  if (!opts.auth.enabled) {
    return send(res, 403, 'text/plain', 'forbidden: loom\'s page requires LOOM_BEARER_TOKEN');
  }
  // The page used to live under /ui. Old links and bookmarks land on the same page.
  if (pathname === '/ui' || pathname.startsWith('/ui/')) {
    const to = new URL(req.url ?? pathname, 'http://loom.invalid');
    // One leading slash, never two: `/ui//evil.example` must not become a
    // protocol-relative `//evil.example`.
    const rest = '/' + pathname.slice(3).replace(/^[/\\]+/, '');
    res.writeHead(308, { location: rest + to.search, ...SECURITY_HEADERS });
    return void res.end();
  }
  // A piece's old name (PIECE_ALIASES): /p/box/… and /a/<agent>/p/box/… are the runtime's pages now.
  const old = /^((?:\/a\/[^/]+)?\/p\/)([a-z][a-z0-9-]*)(\/.*)?$/.exec(pathname);
  if (old) {
    const now = resolvePieceName(opts.env, old[2]);
    if (now !== old[2]) {
      const to = new URL(req.url ?? pathname, 'http://loom.invalid');
      res.writeHead(308, { location: `${old[1]}${now}${old[3] ?? ''}${to.search}`, ...SECURITY_HEADERS });
      return void res.end();
    }
  }
  const secure = req.headers['x-forwarded-proto'] === 'https';

  // A one-time sign-in link (`loom token link`). GET only shows a button: a
  // chat's link preview fetches the URL, and mustn't spend it.
  const linkMatch = /^\/login\/([0-9a-f]{64})$/.exec(pathname);
  if (linkMatch) {
    const code = linkMatch[1];
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', renderLoginLink(code));
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const spent = storeFor(opts).spendLink(code);
    if (!spent || !opts.auth.live(spent.secret)) {
      return send(res, 401, 'text/html; charset=utf-8', renderLoginLink(code, 'That link is used up, expired, or its token was revoked.'));
    }
    return redirect(res, '/', {
      'set-cookie': `${COOKIE}=${storeFor(opts).create(spent.secret, undefined, { device: deviceOf(req.headers['user-agent']), label: spent.label, via: 'link', signedInAt: spent.signedInAt, agent: spent.agent }, (d) => opts.auth.live(d))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    });
  }

  const rp = relyingParty(opts.env);
  // Passkeys work only on the page at LOOM_PUBLIC_URL (their origin): offer one there.
  const onRp = !!rp && req.headers.host === new URL(rp.origin).host;
  const sessionCookie = (secret: Buffer) =>
    `${COOKIE}=${storeFor(opts).create(secret, undefined, { device: deviceOf(req.headers['user-agent']), via: 'passkey' }, (d) => opts.auth.live(d))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`;

  // loom's own fonts (OFL, assets/fonts): the two the page uses, nothing else.
  const font = /^\/fonts\/(instrument-sans-latin-wght-normal|jetbrains-mono-latin-wght-normal)\.woff2$/.exec(pathname);
  if (font) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
    return void res.end(readFileSync(join(resolveRepoRoot(), 'assets', 'fonts', `${font[1]}.woff2`)));
  }
  // The app: its manifest, icons and service worker (src/ui/pwa.ts). Public, like the fonts: none of it says anything about you.
  const icon = /^\/icons\/(loom-(?:32|180|192|512|maskable-512)\.png)$/.exec(pathname);
  if (icon) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return void res.end(readFileSync(join(resolveRepoRoot(), 'assets', 'icons', icon[1])));
  }
  if (pathname === '/manifest.webmanifest') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'application/manifest+json', MANIFEST, { 'cache-control': 'no-cache' });
  }
  if (pathname === '/sw.js') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'text/javascript; charset=utf-8', workerJs(), { 'cache-control': 'no-cache' });
  }
  // The app (docs/specs/ui-app.md): its built files, public like /app.js (no data in them).
  if (pathname.startsWith('/app/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
    const file = webFile(pathname.slice('/app/'.length));
    if (!file) return send(res, 404, 'text/plain', 'not found');
    const immutable = pathname.startsWith('/app/assets/');
    const type = WEB_TYPES[extname(file)] ?? 'application/octet-stream';
    // Fonts and images are compressed already; the script and the stylesheet are text, packed once (their names change with them).
    const out = /^(text|application\/(javascript|json))|svg/.test(type) ? (immutable ? await encodedAsset(req, readFileSync(file), file) : encoded(req, readFileSync(file))) : { body: readFileSync(file), headers: {} };
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ...out.headers });
    return void res.end(req.method === 'HEAD' ? undefined : out.body);
  }
  if (pathname === '/app.js') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'text/javascript; charset=utf-8', APP_JS, { 'cache-control': 'no-cache' });
  }
  if (pathname === '/login/passkey.js') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'text/javascript; charset=utf-8', PASSKEY_JS, { 'cache-control': 'no-cache' });
  }
  if (pathname === '/login/passkey/options' || pathname === '/login/passkey') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    if (!rp) return sendJson(res, 404, { error: 'passkeys aren\'t set up here (LOOM_PUBLIC_URL)' });
    const body = await readJson(req, PASSKEY_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (pathname === '/login/passkey/options') {
      return sendJson(res, 200, { challenge: storeFor(opts).createChallenge('login', null), rpId: rp.rpId, timeout: 300_000 });
    }
    const store = storeFor(opts);
    const stored = typeof body.id === 'string' ? store.passkey(body.id) : null;
    if (!stored) return sendJson(res, 401, { error: 'loom doesn\'t know that passkey (it may have been removed)' });
    try {
      const a = verifyAssertion(body, stored, rp);
      if (!store.useChallenge(a.challenge, 'login')) return sendJson(res, 401, { error: 'that sign-in expired or was already used; try again' });
      // Its own token in a household (t-1969): live while the passkey is kept and its person is a member. Checked
      // before the counter moves, so a refused passkey doesn't show as used.
      if (!opts.auth.live(Buffer.from(stored.secret, 'hex'))) return sendJson(res, 401, { error: passkeyStopped(stored) });
      const used = store.usePasskey(stored.id, a.counter);
      if (!used) return sendJson(res, 401, { error: 'that passkey\'s counter went backwards: it may have been copied, so it was refused' });
      const secret = Buffer.from(used.secret, 'hex');
      if (!opts.auth.live(secret)) return sendJson(res, 401, { error: passkeyStopped(used) });
      return sendJson(res, 200, { ok: true, to: '/' }, { 'set-cookie': sessionCookie(secret) });
    } catch (err) {
      if (err instanceof PasskeyError) return sendJson(res, 401, { error: err.message });
      throw err;
    }
  }

  if (pathname === '/login') {
    // Unauthenticated: the login page names no agent.
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', renderLogin(undefined, { rp: rp?.origin, here: onRp }), onRp ? PASSKEY_CSP : {});
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const form = await readForm(req, LOGIN_MAX_BYTES);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    const token = form.get('token')?.trim() ?? '';
    const match = token ? opts.auth.check(token) : null;
    if (!match) return send(res, 401, 'text/html; charset=utf-8', renderLogin('That token didn’t match.', { rp: rp?.origin, here: onRp }), onRp ? PASSKEY_CSP : {});
    return redirect(res, '/', {
      'set-cookie': `${COOKIE}=${storeFor(opts).create(match, undefined, { device: deviceOf(req.headers['user-agent']), via: 'token' }, (d) => opts.auth.live(d))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    });
  }

  const who = whoIs(req, opts);
  // The household as it is, whoever's asking: a live stream reads it again for as long as it's open.
  const householdNow = opts.household;
  // An agent owner (docs/specs/owners.md): from here on, the household is theirs alone and the
  // pieces are the ones that understand them. The household's own pages are refused.
  const full = opts.household?.();
  // The attention records are the Inbox's own (t-2025): registered for this household, with the options as they came
  // (never an agent owner's narrowed ones: each viewer's are made from their own membership).
  if (full) {
    const base = opts, home = full.home;
    registerCoreSource(home, 'attention', (v) => attentionFor(base, v));
    // Each agent's card (t-2028), made by Home's own code for each viewer.
    registerCoreSource(home, 'agent-status', (v) => agentStatusFor(base, v));
    onChanged(home, () => { nudgeAttention(home); nudgeLive(home, AGENT_STATUS_DOMAIN); });
  }
  // The account menu names who's signed in; the first household owner keeps the household's name for them.
  if (full && who?.member && who.member.person !== firstOwner(full).person) opts = { ...opts, viewer: who.member.person };
  if (full && who?.member) opts = { ...opts, member: who.member };
  if (full && who?.member && who.member.agents !== '*') {
    // The agents they own that are still the household's (memberViewer's rule): a departed one is in no one's scope.
    const own = who.member.agents.filter((a) => full.agents.includes(a));
    if (!scopedPathOk(pathname)) return send(res, 403, 'text/plain', 'That page is the household\'s: ask a household owner.');
    const base = opts.household!;
    opts = { ...opts, household: () => narrowed(base(), own), ownerScope: own, env: { ...opts.env, LOOM_OWNER_SCOPE: own.join(',') } };
  }
  // The agent the owner is looking at (an agent's own pages, else the chosen scope); pieces get it as LOOM_SCOPE.
  const hhScope = opts.household?.();
  // A piece's page may say where a task or change came from: drawn here, for this member only (comms.md, "From").
  const drawFrom = <T,>(p: T): T => (typeof p === 'string' || !p || typeof p !== 'object' || !('sections' in p) ? p
    : resolveFrom(p as unknown as Page, hhScope?.home, who?.member) as unknown as T);
  const scope = /^\/a\/([a-z][a-z0-9-]{0,39})(?:\/|$)/.exec(pathname)?.[1] ?? scopeOf(req, hhScope);
  const scopedEnv: NodeJS.ProcessEnv = hhScope && scope !== 'household' && hhScope.agents.includes(scope) ? { ...opts.env, LOOM_SCOPE: scope } : opts.env;
  const csrf = who?.kind === 'session' ? csrfFor(who.cookie, storeFor(opts).key) : '';

  if (pathname === '/logout') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    // Revoke it server-side, so a copy of the cookie stops working too.
    const c = readCookie(req, COOKIE);
    if (c && /^[0-9a-f]{64}$/.test(c)) { storeFor(opts).delete(c); closeSession(`session:${c}`); }
    // And the copies of pages this browser kept for offline (https only; the sign-in page's /app.js also asks the worker).
    return redirect(res, '/login', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, 'clear-site-data': '"cache", "storage"' });
  }

  if (!who) {
    if (pathname.endsWith('.json')) return send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
    if (req.method === 'GET') return redirect(res, '/login');
    return send(res, 401, 'text/plain', 'unauthorized');
  }

  const url = new URL(req.url ?? pathname, 'http://loom.invalid');

  // The app's live stream (src/ui/live.ts): "something changed", and nothing else.
  if (pathname === '/events') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    // The stream check is /act's (collections.md): a page on another port of this host can't open streams in a
    // member's name.
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const hh = opts.household?.();
    const home = hh?.home ?? opts.contextDir;
    // Whose a changed file is: under an agent's folder, that agent's; anything else, the household's.
    const place = (file: string): Sees => {
      const h = opts.household?.();
      if (!h) return '*';
      const abs = join(home, file);
      const a = h.agents.find((x) => abs.startsWith(agentDir(h, x) + sep));
      return a ? [a] : '*';
    };
    // Who this stream is, read again before every frame (collections.md, "The viewer is checked on every frame"): the
    // session (or the bearer) still live, and the member's agents as the household says now.
    const auth = opts.auth;
    const sessionOpts = opts;
    const viewerNow = (): Viewer | null => {
      const h = householdNow?.();
      if (!h) return null;
      let m: Member | undefined;
      if (who.kind === 'session') {
        if (!validSession(who.cookie, sessionOpts)) return null;
        const sess = storeFor(sessionOpts).get(who.cookie);
        m = sess ? auth.member?.(sess.secret) : undefined;
      } else {
        if (!auth.live(who.digest)) return null;
        m = auth.member?.(who.digest);
      }
      const now = m ? memberOf(h, m.person) : undefined;
      return now ? memberViewer(h, now) : null;
    };
    return openStream(res, scopedEnv, home, SECURITY_HEADERS, { sees: opts.ownerScope ?? '*', session: streamOwner(req, who), place, ...(who.member ? { member: who.member.person } : {}),
      opened: (port) => {
        const v = householdNow && full ? viewerNow() : null;
        if (!v) return undefined;
        subsOpen(() => householdNow!(), () => opts.env, { ...port, viewer: viewerNow }, v);
        // Who it's for, as an opaque tag: a window that hears a different one drops everything it held first.
        return { scope: 1, viewer: createHmac('sha256', storeFor(opts).key).update(`loom-viewer\0${viewerId(v)}`).digest('base64url').slice(0, 22), onClose: () => subsClose(home, port.id) };
      } });
  }

  // Shared collections (docs/specs/collections.md, "Asking: queries"): a batch of bounded queries, answered for this
  // member alone. A UI route like /act: same origin, and a session's anti-forgery token.
  if (pathname === `/${COLLECTIONS_QUERY_ROUTE}`) {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    if (!full || !who.member) return sendJson(res, 404, { error: 'shared collections are a household\'s' });
    const body = await readJson(req, COLLECTIONS_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (who.kind === 'session' && !safeEq(typeof body._csrf === 'string' ? body._csrf : '', csrf)) return sendJson(res, 403, { error: 'this page is stale; reload and try again' });
    const r = await answerBatch({ env: opts.env, household: full, live: () => householdNow!(), page: { session: streamOwner(req, who) } }, memberViewer(full, who.member), body);
    return sendJson(res, r.status, r.body);
  }

  // Comms (docs/specs/comms.md): JSON routes, each checking the member owns the thread's agent and opened it.
  if (full && (pathname === '/comms' || pathname.startsWith('/comms/'))) {
    // Another site may link to Comms, never fetch it (allowedGet), as every page.
    if ((req.method === 'GET' || req.method === 'HEAD') && !allowedGet(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    // A page load of a thread is the app, but only for its member: anyone else gets the same 403 as the JSON (comms.md, rule 3).
    if (req.method === 'GET' && wantsPage(req)) {
      const no = pageRefused(pathname, full, who.member);
      if (no) return send(res, no.startsWith('not-found') ? 404 : 403, 'text/plain', no);
      // An old thread link (comms/th:…) reloads at its colon-free address (t-1918): the app's paths have no colon.
      const old = /^\/comms\/th:([a-z2-7]{10})$/.exec(pathname);
      if (old) return redirect(res, `/comms/${old[1]}${new URL(req.url ?? '/', 'http://loom.invalid').search}`);
    }
  }
  if (full && (pathname === '/comms' || pathname.startsWith('/comms/')) && !(req.method === 'GET' && wantsPage(req))) {
    const guard = (r: IncomingMessage, body: Record<string, unknown>): string | null => {
      if (!sameOrigin(r)) return 'forbidden: cross-site request';
      if (who.kind === 'session' && !safeEq(typeof body._csrf === 'string' ? body._csrf : '', csrf)) return 'forbidden: this page is stale; reload and try again';
      return null;
    };
    const commsChrome = async (): Promise<Chrome & { prefs?: unknown }> => {
      const { pieces: all, skipped } = await pieceManifests(scopedEnv);
      const ch = chrome(req, opts, atWorkFor(forOwner(all, opts.ownerScope), full, who.member), skipped.map((x) => x.piece), 'comms', csrf);
      return { ...ch, prefs: storeFor(opts).prefs(readerFor(opts, who)) };
    };
    // The pieces this member may hear from, read once a request (a thread's read asks for them more than once).
    let piecesOnce: Promise<PieceInfo[]> | undefined;
    let inboxOnce: ReturnType<NonNullable<Parameters<typeof commsRoute>[3]['inbox']>> | undefined;
    const commsPieces = () => (piecesOnce ??= pieceManifests(scopedEnv).then((x) => forOwner(x.pieces, opts.ownerScope)));
    await commsRoute(req, res, pathname, { household: full, live: () => opts.household?.(), member: who.member, env: opts.env, chrome: commsChrome,
      // Only the agents this member owns: the same rule as the thread routes (comms.md, rule 1).
      agents: Object.fromEntries(Object.entries(agentsOf(full) ?? {}).filter(([a]) => owns(who.member, a))),
      // The Inbox's own filter, so a thread's asks never come from a piece this member isn't cleared for.
      pieces: commsPieces, session: streamOwner(req, who), headers: { ...SECURITY_HEADERS, ...whoTag(who) }, guard,
      // A thread's asks are the member's own Inbox items (comms.md, "Asks inline"): the same household, pieces and rule.
      inbox: () => (inboxOnce ??= (async () => {
        const seen = opts.household?.();
        const ps = await commsPieces();
        const appr = pieceWithRole(opts.env, 'approvals')?.name;
        return { items: seen ? inboxItems(seen, ps, opts.env, [], !opts.ownerScope) : [], leads: leadIds(ps, opts.env), householdOwner: !opts.ownerScope, checkers: pieceCheckers(opts.env),
          ...(appr ? { approvals: pieceSource(appr).id } : {}) };
      })()) });
    return;
  }

  // Adding a passkey: a browser session only (it signs in as that session's token), with its form token.
  // Push for Your call (push.ts): the key to subscribe with, and this browser's subscription.
  if (pathname === '/push/key' && req.method === 'GET') {
    if (who.kind !== 'session') return sendJson(res, 403, { error: 'from a signed-in browser' });
    return sendJson(res, 200, { publicKey: publicKey(storeFor(opts)) });
  }
  if ((pathname === '/push/subscribe' || pathname === '/push/unsubscribe') && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    if (who.kind !== 'session') return sendJson(res, 403, { error: 'from a signed-in browser' });
    const body = await readJson(req, PASSKEY_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (!safeEq(typeof body._csrf === 'string' ? body._csrf : '', csrf)) return sendJson(res, 403, { error: 'this page is stale; reload and try again' });
    const sub = pushSub(body.sub);
    if (!sub) return sendJson(res, 400, { error: 'not a push subscription loom sends to' });
    if (pathname === '/push/unsubscribe') { storeFor(opts).removePushSub(sub.endpoint); return sendJson(res, 200, { ok: true }); }
    // `again`: the device sending what it already holds, on each app load (t-1978): a device whose entry was lost gets
    // it back by itself; one its person removed on Profile is told so, and turns itself off.
    const got = storeFor(opts).addPushSub(who.cookie, sub, undefined, readerFor(opts, who), { again: body.again === true, device: deviceOf(req.headers['user-agent']) });
    if (got === 'agent') return sendJson(res, 403, { error: 'An agent\'s session gets no notifications.' });
    return got === 'added' ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: got === 'removed' ? 'This device was removed from notifications on Profile.' : 'Sign in again.', removed: got === 'removed' });
  }
  if ((pathname === '/passkeys/options' || pathname === '/passkeys') && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    if (who.kind !== 'session') return sendJson(res, 403, { error: 'a passkey is added from a signed-in browser' });
    if (!rp || !onRp) return sendJson(res, 404, { error: rp ? `passkeys work at ${rp.origin}` : 'passkeys aren\'t set up here (LOOM_PUBLIC_URL)' });
    const body = await readJson(req, PASSKEY_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (!safeEq(typeof body._csrf === 'string' ? body._csrf : '', csrf)) return sendJson(res, 403, { error: 'this page is stale; reload and try again' });
    const store = storeFor(opts);
    const session = store.get(who.cookie);
    if (!session) return sendJson(res, 401, { error: 'signed out' });
    // Only soon after signing in (t-1969): a browser left signed in can't quietly add a lasting way in.
    if (staleForPasskey(session)) return sendJson(res, 403, { error: STALE_FOR_PASSKEY });
    // In a household a session is always a member's; one that isn't (tokens.json unreadable) adds nothing, nor is told whose credentials exist.
    if (opts.household && !who.member) return sendJson(res, 401, { error: 'this session isn\'t a member of the household; sign in again' });
    if (pathname === '/passkeys/options') {
      return sendJson(res, 200, {
        challenge: store.createChallenge('register', session.secret),
        rp: { id: rp.rpId, name: 'loom' },
        // One user per member (docs/specs/owners.md): a stable id that says nothing. The first household
        // owner keeps the household's old id, so the passkeys made before members stay theirs.
        user: passkeyUser(who.member, !!who.member && opts.household !== undefined && firstOwner(opts.household()).person === who.member.person, rp.rpId),
        pubKeyCredParams: ALGS.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        // This member's own credentials only: another member's on a shared device mustn't block theirs, nor be shown.
        excludeCredentials: (who.member && opts.household ? passkeysOf(opts, who.member) : store.passkeys()).map((p) => ({ id: p.id })),
        timeout: 300_000,
      });
    }
    try {
      const r = verifyRegistration(body, rp);
      const c = store.useChallenge(r.challenge, 'register');
      if (!c?.secret) return sendJson(res, 401, { error: 'that expired or was already used; try again' });
      // It signs in as the token of the session that asked, and only that one.
      if (!c.secret.equals(session.secret)) return sendJson(res, 403, { error: 'that was started by another session' });
      const label = (typeof body.label === 'string' ? body.label.trim() : '').slice(0, 60) || 'A passkey';
      const added = { id: r.id, publicKey: r.publicKey, alg: r.alg, counter: r.counter, label, created: Math.floor(Date.now() / 1000) };
      const hh = opts.household?.();
      if (!hh || !who.member) {
        store.addPasskey({ ...added, secret: session.secret.toString('hex') });
        return sendJson(res, 200, { ok: true });
      }
      // In a household it signs its person in with a token of its own (t-1969, passkey-tokens.ts), not the session's:
      // revoking the sign-in links, or whatever token this browser used, doesn't stop it. The token says which one it
      // was made from. Refused before minting one it won't use.
      if (store.passkey(r.id)) return sendJson(res, 409, { error: 'that passkey is already added' });
      const from = originOf(hh, session.secret.toString('hex'), opts.envOwnerDigest);
      if (!from) return sendJson(res, 401, { error: 'signed out' });
      const minted = passkeyToken(hh, who.member.person, r.id, label, from);
      try {
        store.addPasskey({ ...added, secret: minted.secret, tokenLabel: minted.tokenLabel });
      } catch (err) {
        dropUnusedPasskeyToken(hh, store, minted);
        throw err;
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof PasskeyError) return sendJson(res, 400, { error: err.message });
      if (err instanceof Error && /passkey/.test(err.message)) return sendJson(res, 409, { error: err.message });
      throw err;
    }
  }

  // The person's Appearance (web/src/look.ts): saved from any device, and every page's chrome carries it back (`view`).
  // A preference, not browsing (docs/privacy.md): the look, light or dark, the ground, sound; kept like `seen`, per member.
  if (pathname === '/appearance/prefs') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    const body = await readJson(req, LOGIN_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (who.kind === 'session' && !safeEq(typeof body._csrf === 'string' ? body._csrf : '', csrf)) return sendJson(res, 403, { error: 'this page is stale; reload and try again' });
    const p = prefsOf(body);
    if (!p) return sendJson(res, 400, { error: 'not an Appearance choice loom keeps' });
    if (!Object.keys(p).length) return sendJson(res, 400, { error: 'no Appearance choice to save' });
    return sendJson(res, 200, { ok: true, prefs: storeFor(opts).setPrefs(p, readerFor(opts, who)) });
  }

  const hh = opts.household?.();
  // An agent's pixel face (household.ts spriteOf): its sheet and its JSON, for an agent this person sees. The page asks
  // with the face's version (?v=), so a copy is kept until the sheet changes.
  const sprite = /^\/faces\/([a-z][a-z0-9-]{0,39})\/(manifest\.json|[a-z0-9][a-z0-9-]{0,40}\.png)$/.exec(pathname);
  if (sprite) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
    const [, agent, file] = sprite;
    // Its manifest, and only the sheets that manifest names.
    const named = hh?.agents.includes(agent) ? spriteOf(hh, agent)?.sheets : undefined;
    if (!named || (file !== 'manifest.json' && !named.includes(file))) return send(res, 404, 'text/plain', 'not found');
    const body = readFileSync(join(spriteDir(hh!, agent), file));
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file.endsWith('.png') ? 'image/png' : 'application/json',
      'cache-control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache' });
    return void res.end(req.method === 'HEAD' ? undefined : body);
  }
  // An app's pixel icon (src/icon-set.ts): the household's art, so only for someone signed in (this is past the sign-in
  // check), never public like the app's own icons under /icons/. The page asks with the set's version (?v=).
  const pix = PIXEL_ICON.exec(pathname);
  if (pix) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
    const file = hh ? iconFile(hh, pix[1]) : undefined;
    if (!file) return send(res, 404, 'text/plain', 'not found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png',
      'cache-control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache' });
    return void res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  }
  // An Inbox item opened somewhere other than its sheet (its own page: a task's): read, as /inbox?i=<key> makes it,
  // for whoever opened it. The app posts it, then goes (web/src/views.tsx useOpenItem).
  if (pathname === '/inbox/read' && hh) {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const form = await readForm(req, ACT_MAX_BYTES);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    if (who.kind === 'session' && !safeEq(form.get('_csrf') ?? '', csrf)) return send(res, 403, 'text/plain', 'forbidden: this form is stale; reload and try again');
    const key = form.get('i') ?? '';
    if (!/^[0-9a-f]{16}$/.test(key)) return send(res, 400, 'text/plain', 'bad item');
    storeFor(opts).markOpened(key, Math.floor(Date.now() / 1000), readerFor(opts, who));
    // A read is a change like any other (collections.md, "Read state"): every window of this member's hears it. Pulled
    // soon (at once if it wasn't in the last GAP_MS, else when that's up), never awaited here: a loop of reads costs one
    // pull per gap, not one each.
    if (full) pullSoon(full.home, [ATTENTION_DOMAIN]);
    return sendJson(res, 200, { ok: true });
  }
  const agentAct = hh ? /^\/a\/([a-z][a-z0-9-]{0,39})\/act\/(loom|[a-z][a-z0-9-]{0,39})$/.exec(pathname) : null;
  if (pathname.startsWith('/act/') || agentAct) {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    if (agentAct && !hh!.agents.includes(agentAct[1])) return send(res, 404, 'text/plain', 'not found');
    const sourceId = agentAct ? agentAct[2] : pathname.slice('/act/'.length);
    if (sourceId !== 'loom' && !ID.test(sourceId)) return send(res, 404, 'text/plain', 'not found');
    const form = await readForm(req, ACT_MAX_BYTES);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    // A browser session must prove the form came from loom's page. A bearer
    // script has no ambient credential a forger could ride, so it needs none.
    if (who.kind === 'session' && !safeEq(form.get('_csrf') ?? '', csrf)) {
      return send(res, 403, 'text/plain', 'forbidden: this form is stale or not from loom\'s page; reload and try again');
    }
    const action = form.get('_action') ?? '';
    const back = form.get('_path') ?? '';
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(action)) return send(res, 400, 'text/plain', 'bad action');
    // An operation id (docs/specs/collections.md, "Commands"; t-2024): the window's name for this one action, so a retry
    // (a dropped connection, another listener) gets the first one's answer and never runs it twice: a single-use
    // approval is spent once. Only the page's own fetch sends one.
    const op = form.get('_op');
    // Whose an operation is, as live.db keeps it: a keyed hash of the session (or the bearer), never the cookie itself,
    // which would sign whoever read the file in (sessions.ts keeps only hashes for the same reason).
    const opSession = createHmac('sha256', storeFor(opts).key).update(`loom-op\0${streamOwner(req, who)}`).digest('base64url');
    const opHome = (opts.household?.() ?? hh)?.home;
    // Without a household there's no shared store for receipts: the action runs as one without an id.
    if (op !== null && opHome) {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(op)) return send(res, 400, 'text/plain', 'bad operation id');
      // What the id was made for: the same action, at the same place, with the same fields. Keyed, so the values (a
      // secret typed into a form) can't be guessed back from what live.db keeps.
      const what = createHmac('sha256', storeFor(opts).key).update(JSON.stringify([pathname, action, back, [...form].filter(([k]) => k !== '_op' && k !== '_csrf')])).digest('base64url');
      const b = withLog(opHome, (db) => beginOp(db, op, opSession, what));
      if ('other' in b) return sendJson(res, 409, { error: 'that operation id is another session\'s' });
      if ('answer' in b) return send(res, 200, 'application/json', b.answer);
      if ('state' in b) return sendJson(res, 202, { ok: false, message: b.state === 'accepted' ? 'Still working on it.' : 'loom didn\'t hear how that went: look before trying again.', receipt: { op, state: b.state } });
      // A way out before the action ran (a piece that isn't there, a form refused) says so in its receipt; one after it
      // ran that never answered stays accepted, and becomes unknown: never run again.
      res.once('finish', () => {
        if ([400, 403, 404, 413].includes(res.statusCode)) {
          try { withLog(opHome, (db) => finishOp(db, op, opSession, 'failed', JSON.stringify({ ok: false, message: 'That didn\'t run.', receipt: { op, state: 'failed', why: 'it didn\'t run' } }), true)); } catch { /* it stays accepted, then unknown */ }
        }
      });
    }
    const backLink = splitPage(back) ? back : '';
    // A form has up to LIMITS.fields fields plus LIMITS.hidden hidden values.
    // More than that is refused whole, never cut short: a truncated form
    // could drop the very field (a secret) the piece needs.
    const fields: Record<string, string> = Object.create(null);
    for (const [k, v] of form) {
      if (k.startsWith('_') || !/^[a-z][a-z0-9_-]{0,39}$/.test(k) || Object.hasOwn(fields, k)) continue;
      fields[k] = v;
    }
    if (Object.keys(fields).length > LIMITS.fields + LIMITS.hidden) return send(res, 400, 'text/plain', 'too many fields');
    let source: Source;
    let result: ActResult;
    // When this browser's person signed in, for a link it makes for them (signedInAt); a bearer proved a token now.
    const mintedAt = () => { const s = who.kind === 'session' ? storeFor(opts).get(who.cookie) : null; return s ? signedInAt(s) : undefined; };
    // An answered Needs you is in the Inbox's history already (answeredAsks): its toast leaves no FYI as well.
    let quiet = false;
    if (agentAct && agentAct[2] !== 'loom') {
      // A piece's action from its tab on this agent's pages: called with LOOM_SCOPE=<agent>, landing back there.
      const pieces = forOwner((await pieceManifests(scopedEnv)).pieces, opts.ownerScope);
      const info = pieces.find((p) => p.piece === agentAct[2] && agentTabOf(p));
      if (!info) return send(res, 404, 'text/plain', 'not found');
      source = agentPieceSource(agentAct[1], info.piece);
      const sp = splitPage(backLink);
      const path = sp && !sp.core ? sp.path : '';
      result = await pieceAct(info, { action, path, fields }, scopedEnv, callerOf(who));
      // The approvals piece answered from an agent's pages (should it ever have a tab there): its grant applied the same.
      if (result.ok && hh && action === 'allow' && pieceWithRole(opts.env, 'approvals')?.name === info.piece) {
        result = await applyOwnerApproval(opts.env, pieces, fields.id ?? '', callerOf(who), result, hh);
      }
    } else if (agentAct && action.startsWith('needs-')) {
      // An agent's Needs you, answered from its sheet: replied to, done or dismissed. Who answers is the signed-in member.
      source = agentSource(agentAct[1]);
      const person = who?.member?.person ?? firstOwner(hh!).person;
      // The ask as it was before it's answered: its Comms thread keeps how it was answered (comms.md, "Asks inline").
      const seen = await pieceManifests(scopedEnv).then((x) => forOwner(x.pieces, opts.ownerScope)).catch(() => [] as PieceInfo[]);
      const before = askBefore(hh!, seen, opts, (it) => it.agent === agentAct[1] && !!it.reply && it.reply.fields.digest === fields.digest && it.reply.fields.conversation === fields.conversation);
      result = ['needs-reply', 'needs-answer', 'needs-done', 'needs-dismiss'].includes(action)
        ? await needsAct(opts, hh!, agentAct[1], action, fields, person) : { ok: false, message: 'No such action.' };
      quiet = result.ok;
      const verdict = verdictOf(action, fields);
      const appr = pieceWithRole(opts.env, 'approvals')?.name;
      if (result.ok && verdict) recordAnswer(hh!, opts.env, before, { verdict, by: person }, { lead: leadIds(seen, opts.env).has(before?.approval?.actions.find((b) => b.fields?.id)?.fields?.id ?? ''), approvals: appr ? pieceSource(appr).id : undefined });
    } else if (agentAct) {
      // One agent's own actions (archive, ratify, reject), on its stack.
      source = agentSource(agentAct[1]);
      result = await coreAct(agentDir(hh!, agentAct[1]), action, fields);
    } else if (opts.ownerScope && sourceId === 'loom' && action !== 'passkey-remove' && action !== 'signin-link' && action !== 'session-revoke' && action !== 'push-test' && action !== 'push-remove') {
      // An agent owner's core actions are their agents' own (/a/<agent>/act/loom); the household's are refused.
      source = CORE;
      result = { ok: false, message: 'That\'s the household\'s to do: ask a household owner.' };
    } else if (sourceId === 'loom' && action === 'passkey-remove') {
      source = CORE;
      const own = opts.ownerScope && who?.member ? passkeysOf(opts, who.member) : undefined;
      const id = fields.id ?? '';
      const hhr = opts.household?.();
      const mine = !own || own.some((k) => k.id === id);
      // Its own token goes with it, and so do the sessions it opened (t-1969); asked to, the passkeys they made too.
      let out: { removed: boolean; made: number } = { removed: false, made: 0 };
      let failed: ActResult | undefined;
      try {
        if (mine && hhr) out = removePasskey(hhr, id, fields.made === 'with');
        else if (mine) out = { removed: storeFor(opts).removePasskey(id), made: 0 };
      } catch (e) {
        failed = e instanceof PasskeyTokenLeft
          ? { ok: false, message: `Removed, so it can't sign in again, but the token "${e.label}" couldn't be revoked (${e.message}): revoke it on Setup, or the browsers it signed in stay signed in.`, page: 'loom:passkeys' }
          : { ok: false, message: `Not removed: ${(e as Error).message}. It still signs in; try again.`, page: 'loom:passkeys' };
      }
      const also = out.made ? ` ${ThePasskeys(out.made)} added from it ${out.made === 1 ? 'is' : 'are'} removed too.` : '';
      result = failed ?? (out.removed ? { ok: true, message: `Removed. That device can't sign in with it any more.${also}`, page: 'loom:passkeys' }
        : { ok: false, message: 'No such passkey.', page: 'loom:passkeys' });
    } else if (sourceId === 'loom' && action === 'session-revoke') {
      // One session ended alone (t-1871): only one this person may see (sessionsOf), named by its ref.
      source = CORE;
      const ref = fields.ref ?? '';
      const mine = REF.test(ref) && sessionsOf(opts, who?.member).some((x) => x.ref === ref);
      result = mine && storeFor(opts).revoke(ref)
        ? { ok: true, message: 'Signed out, and its notifications stopped. That browser has to sign in again; every other one stays signed in.', page: 'loom:passkeys' }
        : { ok: false, message: 'No such session: it may have ended already.', page: 'loom:passkeys' };
    } else if (sourceId === 'loom' && action === 'push-test') {
      // Profile's "Send a test notification" (t-1978): to one of this person's own devices, pressed by them.
      source = CORE;
      const target = storeFor(opts).pushDevice(fields.ref ?? '', readerFor(opts, who));
      const r = target ? await sendTest(storeFor(opts), target, pushSubject(opts)) : 'gone';
      result = r === 'sent' ? { ok: true, message: 'Sent. It should show on that device in a few seconds.', page: 'loom:passkeys' }
        : r === 'gone' ? { ok: false, message: 'That device no longer takes notifications: turn them on there again.', page: 'loom:passkeys' }
        : { ok: false, message: `Not sent: ${r}. Try again in a minute.`, page: 'loom:passkeys' };
    } else if (sourceId === 'loom' && action === 'push-remove') {
      source = CORE;
      result = storeFor(opts).removePushDevice(fields.ref ?? '', readerFor(opts, who))
        ? { ok: true, message: 'Removed. That device gets no more notifications until it\'s turned on there again.', page: 'loom:passkeys' }
        : { ok: false, message: 'No such device: it may be gone already.', page: 'loom:passkeys' };
    } else if (sourceId === 'loom' && action === 'signin-link' && hh) {
      source = CORE;
      const base = (opts.env.LOOM_PUBLIC_URL ?? '').replace(/\/+$/, '');
      // A household session always is a member; one that isn't gets no link, rather than the first owner's. The
      // session it opens signed in when this one did (t-1969): a link can't make a stale session fresh to add a passkey.
      result = who?.member
        ? { ok: true, keep: true, page: 'loom:passkeys', message: `One sign-in, within 10 minutes: ${base}/login/${signinLink(hh, 600, who.member.person, undefined, mintedAt())}` }
        : { ok: false, message: 'This session isn\'t a member of the household; sign in again.', page: 'loom:passkeys' };
    } else if (sourceId === 'loom' && action === 'member-link' && hh) {
      // A household owner makes a sign-in link for a member (Members): it opens a session as them.
      source = CORE;
      const base = (opts.env.LOOM_PUBLIC_URL ?? '').replace(/\/+$/, '');
      const m = memberOf(hh, fields.person);
      result = m
        // It signed in when this browser did (t-1969), whoever it's for: a stale session can't make a fresh one for
        // anyone, to add a lasting passkey through.
        ? { ok: true, keep: true, page: 'loom:members', message: `For ${m.person}, one sign-in within 10 minutes: ${base}/login/${signinLink(hh, 600, m.person, undefined, mintedAt())}` }
        : { ok: false, message: 'No such member.', page: 'loom:members' };
    } else if (sourceId === 'loom' && action.startsWith('piece-')) {
      // The Pieces page's: install, update, roll back, remove, settings.
      source = CORE;
      result = await piecesAct(opts.env, action, fields);
    } else if (sourceId === 'loom' && hh) {
      // The household's: tokens and agents.
      source = CORE;
      result = await householdAct(hh, action, fields);
    } else if (sourceId === 'loom') {
      source = CORE;
      result = await coreAct(opts.contextDir, action, fields);
    } else {
      const pieces = forOwner((await pieceManifests(scopedEnv)).pieces, opts.ownerScope);
      const info = pieces.find((p) => p.piece === sourceId);
      if (!info) return send(res, 404, 'text/plain', 'not found');
      source = pieceSource(info.piece);
      const sp = splitPage(backLink);
      const path = sp && !sp.core ? sp.path : '';
      const approvalsName = pieceWithRole(opts.env, 'approvals')?.name;
      const approvals = !!hh && approvalsName === info.piece;
      // A piece's card as it was before it's answered (any piece's, by the id it names): its Comms thread keeps how it was
      // answered (comms.md, "Asks inline").
      const src = pieceSource(info.piece).id;
      const pieceVerdict = action === 'allow' ? 'allowed' : action === 'deny' ? 'denied' : undefined;
      const before = hh && pieceVerdict && fields.id
        ? askBefore(hh, pieces, opts, (it) => [...(it.source.id === src ? it.actions ?? [] : []), ...(it.approval?.source.id === src ? it.approval.actions : [])].some((b) => b.action === action && b.fields?.id === fields.id)) : undefined;
      result = await pieceAct(info, { action, path, fields }, scopedEnv, callerOf(who));
      // The piece's answer is what counts (its own record): its thread keeps it after, whatever comes of the grant below.
      const answered = result.ok && !!pieceVerdict;
      if (result.ok && hh && pieceWithRole(opts.env, 'approvals')?.name === info.piece) {
        // An Allow on a grant, a vouch or a reset applies it (t-1970, t-1975): the owner's yes does it, nothing left for him to do.
        if (action === 'allow') result = await applyOwnerApproval(opts.env, pieces, fields.id ?? '', callerOf(who), result, hh);
        // An approval answered: the Needs you that waited on it clears now, not at the next minute's pass.
        await resolveNeeds(hh, pieceCheckers(opts.env)).catch(() => undefined);
      }
      if (answered && hh) {
        const by = who?.member?.person ?? firstOwner(hh).person;
        const appr = approvalsName ? pieceSource(approvalsName).id : undefined;
        recordAnswer(hh, opts.env, before, { verdict: pieceVerdict!, by }, { lead: approvals && leadIds(pieces, opts.env).has(fields.id ?? ''), approvals: appr });
        if (approvals) recordApprovalAnswer(hh, fields.id ?? '', { verdict: pieceVerdict!, by });
      }
    }
    // What it changed is in the log before the answer (collections.md, "Commands"): its piece's domains (or core's) are
    // pulled now, and the other listeners nudged, so every window hears it through its stream, this one included.
    if (opHome && result.ok) await pullAfterAction(opHome, opts.env, source.id === 'loom' ? 'loom' : source.id);
    changed(opts.ownerScope ?? '*');   // whatever it did, the open apps that may see it look again
    // What the toast says stays in the Inbox as an FYI (Jonathan, 2026-11-03: "any meaningful toast also leaves an FYI
    // item in the Inbox"): not a line that hands over a secret or a one-time link (keep), and not an empty one.
    if (hh && result.message?.trim() && !result.keep && !quiet) {
      const label = source.id === 'loom' ? undefined : (await pieceManifests(scopedEnv).catch(() => ({ pieces: [] as PieceInfo[] }))).pieces
        .find((p) => pieceSource(p.piece).id === source.id)?.manifest.tab?.label;
      storeFor(opts).noteDone({ at: Math.floor(Date.now() / 1000), ok: result.ok, text: result.message.trim().slice(0, 300), source,
        ...(label ? { sourceLabel: label } : {}), ...(backLink ? { page: backLink } : {}) }, readerFor(opts, who));
    }
    const to = landing(source, result, backLink);
    // A piece's message is labeled with the piece, so it can't pass as loom's.
    const from = source.id === 'loom' ? undefined : source.id;
    // Undo goes back to the same source, landing where the action came from.
    const undo = result.ok && result.undo ? { ...result.undo, act: source.act ?? `/act/${source.id}`, path: backLink } : undefined;
    // The page's own script posts with fetch: it gets the one line back as
    // JSON and stays where it is, unless the action lands somewhere else.
    if (req.headers['x-loom-fetch'] === '1') {
      const stay = to === pageHref(backLink, source);
      // The receipt: done or failed, as the piece said. A grant or an approval is shown done only on this, never before.
      const receipt = op !== null ? { receipt: { op, state: result.ok ? 'done' : 'failed', ...(result.ok ? {} : { why: result.message }) } } : {};
      const answer = JSON.stringify({ ok: result.ok, message: result.message, ...(from ? { from } : {}), ...(result.keep ? { keep: true } : {}), ...(undo ? { undo } : {}),
        ...(stay ? {} : { go: withFlash(to, putFlash({ ok: result.ok, message: result.message, from, keep: result.keep, undo })) }), ...receipt });
      // A retry gets this same answer, never a second run. A one-time message (a secret, a link: `keep`) is never written
      // down: a retry hears it was done, and that it was shown once.
      const kept = result.keep ? JSON.stringify({ ok: result.ok, message: result.ok ? 'Done. What it showed was shown once.' : 'That didn\'t go through.', ...(from ? { from } : {}), receipt: { op, state: result.ok ? 'done' : 'failed' } }) : answer;
      if (op !== null && opHome) withLog(opHome, (db) => finishOp(db, op, opSession, result.ok ? 'done' : 'failed', kept));
      return send(res, 200, 'application/json', answer);
    }
    if (op !== null && opHome) withLog(opHome, (db) => finishOp(db, op, opSession, result.ok ? 'done' : 'failed', JSON.stringify({ ok: result.ok, message: result.keep ? (result.ok ? 'Done. What it showed was shown once.' : 'That didn\'t go through.') : result.message, ...(from ? { from } : {}), receipt: { op, state: result.ok ? 'done' : 'failed' } })));
    return redirect(res, withFlash(to, putFlash({ ok: result.ok, message: result.message, from, keep: result.keep, undo })));
  }

  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
  if (!allowedGet(req)) return send(res, 403, 'text/plain', 'forbidden: loom\'s page can only be opened, not embedded or fetched from another site');
  if (pathname === '/pieces.json') {
    const m0 = await pieceManifests(scopedEnv);
    const m = { ...m0, pieces: atWorkFor(forOwner(m0.pieces, opts.ownerScope), opts.household?.(), who?.member) };
    return send(res, 200, 'application/json', JSON.stringify({
      agent: agentName(opts.contextDir),
      pieces: m.pieces.map((p) => ({ piece: p.piece, manifest: p.manifest })),
      skipped: m.skipped,
    }));
  }
  const pick = /^\/scope\/([a-z][a-z0-9-]{0,39}|household)$/.exec(pathname);
  if (pick) {
    const hh2 = opts.household?.();
    const id = pick[1] === 'household' || !hh2?.agents.includes(pick[1]) ? 'household' : pick[1];
    // No scope to choose any more: an old link goes to the agent's own pages, and the old cookie goes.
    res.writeHead(303, { location: id === 'household' ? '/' : `/a/${id}`, 'set-cookie': `${SCOPE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`, ...SECURITY_HEADERS });
    return void res.end();
  }
  const query = pageQuery(url);
  const asJson = /^application\/json\b/.test(String(req.headers.accept ?? ''));
  // Every page is the app (web/, docs/specs/ui-app.md; the old HTML renderer went 2026-10-29, Jonathan: "let's just
  // remove classic entirely"). A browser loads the app's one page at any path, and the app asks the same path for the
  // page's data as JSON: the same auth, scoping and CSRF answer both. Only the sign-in pages are still loom's HTML.
  // The page load returns before anything is read or spent: a one-time message (?_flash=) is the JSON's to take.
  const app = (status = 200) => {
    const shell = webFile('index.html');
    if (!shell) return send(res, 503, 'text/plain; charset=utf-8', 'loom\'s app isn\'t built here (npm run build:web).');
    return send(res, status, 'text/html; charset=utf-8', readFileSync(shell, 'utf-8'), { 'cache-control': 'no-cache' });
  };
  if (req.method === 'GET' && !asJson) return app();
  const flash = takeFlash(url.searchParams.get('_flash'));
  const { pieces: allPieces, skipped } = await pieceManifests(scopedEnv);
  // Each agent's card and window, and the bar's agents at work, as this viewer may see them (atWorkFor).
  const pieces = atWorkFor(forOwner(allPieces, opts.ownerScope), full, who?.member);
  const skippedNames = skipped.map((s) => s.piece);
  const view = (kind: string, data: Record<string, unknown>, status = 200) => {
    if (!asJson) return app(status);
    // Every page carries the signed-in person's Appearance, so a device they've just signed in on wears it.
    if (data.chrome && typeof data.chrome === 'object') data = { ...data, chrome: { ...data.chrome, prefs: storeFor(opts).prefs(readerFor(opts, who)) } };
    const text = JSON.stringify({ view: kind, ...data });
    // The data's fingerprint (without the clock it was drawn at): an app that already has this answer gets a 304.
    const etag = `W/"${createHash('sha256').update(JSON.stringify({ view: kind, ...data, now: undefined })).digest('base64url').slice(0, 22)}"`;
    if (status === 200 && String(req.headers['if-none-match'] ?? '') === etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, etag, vary: 'accept-encoding' });
      return void res.end();
    }
    const out = encoded(req, Buffer.from(text));
    res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS, etag, ...whoTag(who), ...out.headers });
    res.end(out.body);
  };

  // The shell's sheets (Scope, Places, Find, Setup, and Appearance and Accessibility, apps in Setup's grid: the person's look, kept by loom; Jonathan,
  // 2026-11-03: a page of icons with loose controls under them is wrong): the app draws them as pages.
  if (pathname === '/scope' || pathname === '/places' || pathname === '/find' || pathname === '/setup' || pathname === '/appearance' || pathname === '/accessibility') {
    const tab = pathname.slice(1);
    const ch = chrome(req, opts, pieces, skippedNames, tab, csrf, flash);
    const q = (url.searchParams.get('q') ?? '').slice(0, 100);
    { const which = tab as 'scope' | 'places' | 'find' | 'setup' | 'appearance' | 'accessibility'; const found = tab === 'find' && q.trim() ? findAll(q.trim(), req, opts, pieces) : undefined;
      // Find with nothing typed: who's in the household, for its suggestions (Knowledge and People are the household's).
      const hhNow = opts.household?.();
      const suggest = tab === 'find' && !q.trim() && hhNow && !opts.ownerScope
        ? { people: householdSuggestPeople(hhNow).map((p) => ({ label: p.name, href: `/people/${p.slug}` })) } : undefined;
      // Accessibility's intro (the phone bar's name opens it, as a page's): what it's for, said once.
      const intro = tab === 'accessibility' ? ACCESSIBILITY_INTRO : undefined;
      return view('sheet', { which, chrome: ch, q, found, suggest, intro }); }
  }

  // The account (Jonathan, 2026-11-03): who's signed in, their passkeys, push on this device, signing out. The avatar
  // on a phone's dock and the side's account menu open it; /passkeys is the same page under its old name.
  if (pathname === '/passkeys' || pathname === '/account') {
    const tz = uiTimeZone();
    const when = (s?: number) => (s ? new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s * 1000)) : 'never');
    // An agent owner sees their own passkeys; a household owner, every one.
    const keys = opts.ownerScope && who?.member ? passkeysOf(opts, who.member) : storeFor(opts).passkeys();
    // Each passkey's own token (what it was made from), and how many passkeys its sessions added (passkey-tokens.ts).
    const tokenByDigest = new Map(hh ? loadTokens(hh.home).map((t) => [t.sha256, t] as const) : []);
    const made = hh ? passkeysMadeFrom(hh) : new Map<string, number>();
    // Where you're signed in (t-1871): each browser on its own row, this one first, each ended alone. A household owner
    // sees every session (an agent's screenshot session too); an agent owner, their own.
    const sessionsSection = (): Page['sections'][number] => {
      const here = who?.kind === 'session' ? storeFor(opts).refOf(who.cookie) : undefined;
      const all = sessionsOf(opts, who?.member);
      const list = [...all.filter((x) => x.ref === here), ...all.filter((x) => x.ref !== here)];
      const tokens = hh ? loadTokens(hh.home) : [];
      const tokenOf = (x: SessionInfo) => tokens.find((t) => t.sha256 === x.secret.toString('hex'))?.label;
      return { id: 'sessions', title: 'Signed in', blocks: list.length ? [
        { type: 'list', items: list.slice(0, 200).map((x) => {
          const isHere = x.ref === here;
          const name = [x.device ?? 'A browser', x.label ? `“${x.label}”` : ''].filter(Boolean).join(' ');
          const token = tokenOf(x);
          const how = [x.via === 'passkey' ? 'with a passkey' : x.via === 'link' ? 'with a sign-in link' : x.via === 'token' ? 'with a token' : '', token ? `as ${token}` : ''].filter(Boolean).join(' ');
          return { text: isHere ? `${name} (this device)` : name,
            meta: [`signed in ${when(x.issuedAt)}`, x.seenAt ? `last used ${when(x.seenAt)}` : '', how].filter(Boolean).join(' · '),
            // This device signs out with the page's own Sign out, which also clears what it kept for offline (/logout).
            ...(isHere ? {} : { act: { action: 'session-revoke', label: 'Sign out', tone: 'danger' as const,
              confirm: 'That browser is signed out at once, and gets no more notifications. Every other session, yours here too, stays signed in.', fields: { ref: x.ref } } }) };
        }) },
        { type: 'text', text: 'Each browser signed in to this page. Signing one out ends only that one.', tone: 'muted' },
      ] : [{ type: 'text', text: 'Only a script with a token is signed in.', tone: 'muted' }] };
    };
    // Which of this person's devices get notifications (t-1978), each with "Send a test notification", and a way to
    // remove one (a lost phone): it's theirs and the device's, whatever happens to sessions.
    const notificationsSection = (): Page['sections'][number] => {
      const here = who?.kind === 'session' ? storeFor(opts).refOf(who.cookie) : undefined;
      const devices = storeFor(opts).pushDevices(readerFor(opts, who));
      const name = (d: (typeof devices)[number]) => `${d.device ?? 'A device'}${d.session === here ? ' (this device)' : ''}`;
      return { id: 'notifications', title: 'Devices that get notifications', blocks: devices.length ? [
        { type: 'list', items: devices.slice(0, 20).map((d) => ({ text: name(d),
          meta: [`on since ${when(d.at)}`, d.seenAt ? `last checked in ${when(d.seenAt)}` : ''].filter(Boolean).join(' · '),
          act: { action: 'push-test', label: 'Send a test notification', fields: { ref: d.ref } } })) },
        { type: 'details', summary: 'Remove a device', blocks: [{ type: 'list', items: devices.slice(0, 20).map((d) => ({ text: name(d), meta: `on since ${when(d.at)}`,
          act: { action: 'push-remove', label: 'Remove', tone: 'danger' as const, confirm: 'That device gets no more notifications until they\'re turned on there again.', fields: { ref: d.ref } } })) }] },
      ] : [{ type: 'text', text: 'None yet: turn them on above, on each device you want them on.', tone: 'muted' }] };
    };
    const page: Page = {
      // "Profile" wherever it's seen (t-1925); its address stays /account (and /passkeys, its old name).
      title: 'Profile',
      sections: [
        // The board's order: your passkeys, then adding one (loom's control, put in after this), then another device.
        { id: 'passkeys', title: 'Passkeys', blocks: keys.length
          ? [{ type: 'list', items: keys.slice(0, 200).map((k) => {
              const works = opts.auth.live(Buffer.from(k.secret, 'hex'));
              const from = tokenByDigest.get(k.secret)?.from;
              return { text: k.label, meta: works ? `used ${k.lastUsed ? when(k.lastUsed) : 'never'} · added ${when(k.created)}${from ? ` from "${from}"` : ''}` : passkeyStopped(k),
                ...(works ? {} : { tone: 'warn' as const }),
                act: { action: 'passkey-remove', label: 'Remove', tone: 'danger' as const, confirm: 'That device can\'t sign in with it any more. A token or another passkey still can.', fields: { id: k.id } } };
            }) },
            // A passkey whose sessions added others (t-1969): Remove leaves those working; this takes them too.
            // Only a passkey with its own token: Remove takes what was added from that token (passkey-tokens.ts removePasskey).
            ...(keys.some((k) => k.tokenLabel && made.get(k.secret)) ? [{ type: 'details' as const, summary: 'Remove a passkey with the ones added from it', blocks: [{ type: 'list' as const, items: keys.filter((k) => k.tokenLabel && made.get(k.secret)).slice(0, 50).map((k) => {
              const n = made.get(k.secret)!;
              return { text: k.label, meta: `${n} passkey${n === 1 ? '' : 's'} added from a browser it signed in`,
                act: { action: 'passkey-remove', label: 'Remove with them', tone: 'danger' as const, confirm: `That device can't sign in with it any more, and ${thePasskeys(n)} added from it ${n === 1 ? 'is' : 'are'} removed too.`, fields: { id: k.id, made: 'with' } } };
            }) }] }] : [])]
          : [{ type: 'text', text: 'None yet: add one from the device you want to sign in with.', tone: 'muted' }] },
        sessionsSection(),
        notificationsSection(),
        ...(hh ? [{ id: 'another', title: 'Another device', blocks: [
          { type: 'buttons' as const, items: [{ action: 'signin-link', label: 'Make a one-time sign-in link' }] },
          { type: 'text' as const, text: 'One sign-in, within 10 minutes, as the household\'s page sign-in links token. Open it on the other device.', tone: 'muted' as const },
        ] }] : []),
      ],
    };
    const ch = chrome(req, opts, pieces, skippedNames, 'account', csrf, flash);
    // Who this is, as the account's head says it: their name, and what they are in the household.
    const member = who?.member;
    const named = hh && member ? (member.agents === '*' ? 'Owner of the household' : `Owns ${member.agents.map((a) => agentName(agentDir(hh, a))).join(', ')}`) : hh ? 'Owner of the household' : 'Signed in';
    const me = { name: ch.shell?.owner ?? 'owner', role: named, ...(hh ? profileOf(hh, member ?? firstOwner(hh), pieces, tz) : {}) };
    const add = !rp ? { note: 'Passkeys need loom\'s public https address: set LOOM_PUBLIC_URL for loom-http.' }
      : !onRp ? { note: `Passkeys work at ${rp.origin}: open this page there to add one.` }
      : who.kind !== 'session' ? { note: 'A passkey is added from a signed-in browser.' }
      : staleForPasskey(storeFor(opts).get(who.cookie)) ? { note: STALE_FOR_PASSKEY }
      : { csrf };
    // The app draws the list, and adds loom's own "add a passkey" control (WebAuthn) and the push switch beside it.
    return view('passkeys', { page, ctx: { source: CORE, path: 'passkeys', query, csrf }, chrome: ch, add, me });
  }

  if (hh) {
    const hhAgents = agentsOf(hh);
    const ctxOf = (path: string, source: Source = CORE) => ({ source, path, query, csrf, agents: hhAgents });
    const send200 = (page: import('./vocab.js').Page, current: string, ctx: ReturnType<typeof ctxOf>, head?: AgentHead, extra?: Record<string, unknown>) =>
      { const ch = chrome(req, opts, pieces, skippedNames, current, csrf, flash);
        return view('page', { page, ctx, chrome: ch, head, ...extra }, page.title === 'Not found' && page.sections.length === 0 ? 404 : 200); }
    const contacts = (slug?: string) => {
      const data = householdPeopleApp(hh, query, slug, { projects: !opts.ownerScope });
      const m = who?.member;
      const conversations = m && data.selected ? threadsOf(hh, m).filter((t) => t.agent === data.selected || t.member === data.selected).slice(0, 5)
        .map((t) => ({ title: t.title ?? 'New thread', href: threadPath(t.id) })) : [];
      const permissions = opts.ownerScope ? undefined : permissionsOf(opts.env).permissions;
      return { ...data, conversations, ...(permissions ? { permissions: permissions + (data.selected && hh.agents.includes(data.selected) ? `/${data.selected}` : '') } : {}) };
    };
    if (pathname === '/') {
      const nowMs = Date.now();
      const agents = agentsOf(hh)!;
      const waiting = inboxItems(hh, pieces, opts.env, [], !opts.ownerScope).filter((it) => it.attention);
      // Unread as the Inbox says it: Home's banner is the first one's row there.
      { const opened = storeFor(opts).openedKeys(readerFor(opts, who)); for (const w of waiting.slice(0, HOME_STACK)) w.unread = !opened.has(w.key); }
      const cards = agentCards(hh, pieces, agents, nowMs);
      const down = (st: AgentState) => cards.filter((c) => c.state === st).map((c) => c.label);
      const say = (names: string[], what: string) => `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} ${what}`;
      const broken = down('broken');
      const out = down('unavailable');
      const headline = broken.length ? say(broken, 'broken') : out.length ? say(out, 'unavailable') : 'Everyone\u2019s fine';
      // Each card's own (agent-status carries it, so a window keeps Home's list live from the cards: web/src/agents-live.ts).
      const moving = cards.flatMap((c) => c.moving);
      const d: HouseHome = {
        headline, needs: waiting.length, need: waiting[0], cards, moving,
        // A desktop's Home answers the first few in place (web/src/desk.tsx); a phone's shows the first as its row.
        stack: waiting.slice(0, HOME_STACK),
        // Home is the agents and what's moving (Jonathan, 2026-10-27): the pieces' tiles live on their own pages.
        firstRun: pieces.length ? undefined : firstRun(hh.agents.map((a) => agents[a].label)),
      };
      { const ctx = { ...ctxOf(''), agents }; const ch = chrome(req, opts, pieces, skippedNames, '', csrf, flash);
        return view('house-home', { home: d, ctx, chrome: ch }); }
    }
    // Activity (t-1972): what happened, a few days at a time, as entries to read: filters (who, where, what), the
    // timeline with its day strip, and the open entry's whole story (src/ui/activity.ts; web/src/activity.tsx).
    if (pathname === '/activity') {
      const at = 'activity';
      const person = who?.member?.person ?? firstOwner(hh).person;
      const named = householdPersonName(hh, person) ?? (person === firstOwner(hh).person && hh.owner ? hh.owner : person);
      const ownerLabel = named.split(/[\s-]+/)[0].replace(/^./, (x) => x.toUpperCase());
      const activity = await activityView(hh, query, { member: who?.member, ownerPerson: person, ownerLabel, tz: uiTimeZone(), env: scopedEnv, github: hh.github });
      { const ctx = { ...ctxOf(at), agents: agentsOf(hh)! }; const ch = chrome(req, opts, pieces, skippedNames, at, csrf, flash);
        return view('activity', { activity, ctx, chrome: ch }); }
    }
    // Is this ask still open (t-1925)? The Inbox asks it, fresh, before it shows an ask's buttons as live and again
    // before it sends one: a copy kept on the device (page.ts, the service worker) may be of an ask answered since.
    // Never a cached answer: no-store, and the app treats one stamped x-loom-saved-at as "can't tell".
    if (pathname === '/inbox/open') {
      // By its Inbox key (k), or, for an approval asked from a Comms thread, by the approval's id (a): an approval a
      // need waits on is drawn on that need (absorbApprovals), so its own card, and that card's key, aren't in the Inbox.
      const key = query.k ?? '', approval = query.a ?? '';
      if (!/^[0-9a-f]{16}$/.test(key) && !/^a-[0-9a-f]{4,32}$/.test(approval)) return sendJson(res, 400, { error: 'bad item' });
      const names = (it: InboxItem) => [...(it.actions ?? []), ...(it.approval?.actions ?? [])].some((b) => b.fields?.id === approval);
      const it = inboxItems(hh, pieces, opts.env, [], !opts.ownerScope).find((x) => (key ? x.key === key : names(x)) && x.box !== 'done');
      // Open: still there and not history, whether it's counted in Needs you or only filed (attention: false).
      return sendJson(res, 200, { open: !!it }, { 'cache-control': 'no-store' });
    }
    if (pathname === '/inbox') {
      const nowMs = Date.now();
      const store = storeFor(opts);
      const reader = readerFor(opts, who);
      const items = inboxItems(hh, pieces, opts.env, store.doneItems(reader), !opts.ownerScope);
      const folder: InboxFolder = folderOf(query.f);
      const open = query.i && /^[0-9a-f]{16}$/.test(query.i) ? items.find((it) => it.key === query.i) : undefined;
      // Opening an attention item reads it, but a GET never writes (collections.md, "Read state"): the app posts
      // /inbox/read for the item it opens (web/src/inbox.tsx), as it does for every pick.
      const opened = store.openedAt(reader);
      for (const it of items) {
        it.unread = it.attention && !opened.has(it.key);
        const at = opened.get(it.key);
        if (at) it.seen = new Date(at * 1000).toISOString();
      }
      // The open item's own page (a task's, for a task), drawn in the Inbox: only a piece's ask that links to
      // one of its pages (not its main page) and has no buttons of its own.
      // The open item as the page draws it: the one asked for when it's in this folder, else the folder's first.
      const here = items.filter((it) => inFolder(folder, it));
      const shown = here.find((it) => it.key === open?.key) ?? here[0];
      let inline: { key: string; sections: Section[] } | undefined;
      const info = shown && !shown.actions?.length && shown.kind !== 'answered' && shown.page ? pieces.find((p) => pieceSource(p.piece).id === shown.source.id && hasPages(p)) : undefined;
      const sp = info ? splitPage(shown!.page!) : null;
      if (info && sp && !sp.core && sp.path !== '') {
        const pg = drawFrom(await piecePage(info, sp.path, sp.query, scopedEnv, callerOf(who)));
        if (typeof pg !== 'string') inline = { key: shown!.key, sections: pg.sections };
      }
      const ch = chrome(req, opts, pieces, skippedNames, 'inbox', csrf, flash);
      // An item open: on a phone it's its own screen, and the bar's back goes to its folder.
      if (open && shown?.key === open.key && ch.shell) {
        ch.shell.back = { label: INBOX_FOLDERS.find((f) => f.id === folder)!.label, href: folder === 'needs' ? '/inbox' : `/inbox?f=${folder}` };
      }
      { const ctx = { ...ctxOf('inbox'), agents: agentsOf(hh)! };
        // A From folder (?f=from:<agent>) is the app's own (its items are all here); its address is kept, so a reload keeps it.
        const from = typeof query.f === 'string' && /^from:[a-z][a-z0-9-]{0,39}$/.test(query.f) && hh.agents.includes(query.f.slice(5)) ? query.f : undefined;
        return view('inbox', { items, folder: from ?? folder, folders: INBOX_FOLDERS, open: open?.key, ctx, chrome: ch, now: nowMs, inline, ...(hh.github ? { github: hh.github } : {}) }); }
    }
    // Knowledge, a reader (t-1925): topics, every page's line with its freshness, and the one asked for whole
    // (/knowledge?p=<slug>, or its own address /knowledge/<slug>). The app filters and searches the lines itself.
    if (pathname === '/knowledge' || pathname.startsWith('/knowledge/')) {
      const own = pathname.startsWith('/knowledge/') ? decode(pathname.slice('/knowledge/'.length)) : undefined;
      const slug = own ?? (query.p || undefined);
      if (slug !== undefined && !(slug && validPath(`knowledge/${slug}`) && !slug.includes('/'))) return send200(notFound, 'knowledge', ctxOf('knowledge'));
      const k = knowledgeView(hh, slug);
      if (own !== undefined && !k.open) return send200(notFound, 'knowledge', ctxOf('knowledge'));
      const ch = chrome(req, opts, pieces, skippedNames, 'knowledge', csrf, flash);
      // `t` is the desktop's (its tiles, docs/specs/desk-tiling.md): a topic is `?topic=`.
      const title = k.open?.title ?? 'Knowledge';
      const intro = k.open ? (k.open.verified_at ? `Verified ${k.open.verified_at.slice(0, 10)}` : 'Not verified yet') + (k.open.by ? ` · written by ${k.open.by}` : '')
        : 'Facts about the world, shared by every agent in the household.';
      return view('knowledge', { knowledge: k, title, intro, add: NEW_FACT_LINK, topic: query.topic ?? '', q: query.q ?? '', ctx: ctxOf('knowledge'), chrome: ch });
    }
    if (pathname === '/people') return send200(householdPeople(hh, query), 'people', ctxOf('people'), undefined, { people: contacts() });
    // The Projects app (docs/specs/projects.md): the household's, not an agent owner's. An agent owner gets the
    // not-found page here, never the single-agent route below.
    if (opts.ownerScope && (pathname === '/projects' || pathname.startsWith('/projects/'))) return send200(notFound, '', ctxOf(''));
    if (pathname === '/projects' || pathname.startsWith('/projects/')) {
      const owners = hh.agents.filter((x) => existsSync(agentDir(hh, x))).map((x) => ({ agent: x, dir: agentDir(hh, x) }));
      // The index's cards ride beside its page (web/src/projects.tsx draws them; docs/specs/projects.md, "The index").
      if (pathname === '/projects') { const ix = await projectsApp(owners, { env: opts.env }); return send200(ix.page, 'projects', ctxOf('projects'), undefined, ix.cards ? { projects: ix.cards } : undefined); }
      const seg = (decode(pathname.slice('/projects/'.length)) ?? '').split('/');
      const ok = seg.every((x) => /^[a-z0-9][a-z0-9-]*$/.test(x)) && seg.length <= 2;
      const o = ok ? ownerOf(owners, seg[seg.length - 1], seg.length === 2 ? seg[0] : undefined) : null;
      const page = o ? await projectHubPage(o, seg[seg.length - 1], { env: opts.env }) : null;
      return send200(page ?? notFound, 'projects', ctxOf(pathname.slice(1)));
    }
    if (pathname === '/pieces') return send200(piecesPage(opts.env, query), 'pieces', ctxOf('pieces'));
    if (pathname.startsWith('/people/')) {
      const slug = decode(pathname.slice('/people/'.length));
      return send200(slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? householdPerson(hh, slug, { projects: !opts.ownerScope }) : notFound, 'people', ctxOf(`people/${slug}`), undefined, { people: contacts(slug ?? undefined) });
    }
    if (pathname === '/members') return send200(householdMembers(hh), 'members', ctxOf('members'));
    // A conversation (docs/specs/conversations.md, loom:conversation/<id>): whichever of this viewer's agents has it.
    const cv = /^\/conversation\/(cv-[0-9a-f]{12})$/.exec(pathname);
    if (cv) {
      const owner = hh.agents.find((x) => existsSync(agentDir(hh, x)) && conversationOf(agentDir(hh, x), cv[1]));
      const page = owner ? await conversationPage(agentDir(hh, owner), owner, cv[1], { env: opts.env, home: hh.home, days: hh.commsDays, before: /^\d{1,12}$/.test(query.before ?? '') ? Number(query.before) : undefined, page: pathname.slice(1) }) : null;
      return send200(page ?? notFound, owner ? `a/${owner}` : '', ctxOf(`conversation/${cv[1]}`), owner ? { ...agentsOf(hh)![owner], tabs: agentTabs(owner, 'conversation', pieces) } : undefined);
    }
    if (pathname === '/new-agent') return send200(newAgentPage(hh), '', ctxOf('new-agent'));
    if (pathname === '/new-person') return send200(newPersonPage(), 'people', ctxOf('new-person'));
    if (pathname === '/new-fact') return send200(newFactPage(), 'knowledge', ctxOf('new-fact'));
    const a = /^\/a\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(pathname);
    if (a) {
      const agent = a[1];
      if (!hh.agents.includes(agent)) return send200(notFound, '', ctxOf(''));
      const rest = decode(a[2] ?? '') ?? '\0';
      const dir = agentDir(hh, agent);
      const src = agentSource(agent);
      // Its window's header (t-1925 D): its description as the household wrote it (never its creed), whether this viewer
      // may change it (a household owner), whether it's been asked to write one, and whether it's working now.
      const windowFacts = () => {
        const about = aboutOf(hh, agent);
        const perms = opts.ownerScope ? undefined : permissionsOf(opts.env).permissions;
        return { ...(about ? { about } : {}), ...(!opts.ownerScope ? { edit: true } : {}), ...(perms ? { permissions: `${perms}/${agent}` } : {}), ...(aboutAskOf(hh, agent) ? { asked: true } : {}),
          ...(workingOf(pieces, agent).working ? { working: true, ...onOf(pieces, agent) } : {}), active: lastActive(agentDir(hh, agent)) };
      };
      if (rest === '' ) {
        // The agent's Today: its asks, Memories and its pieces' tiles (scope-aware ones), its own thread.
        const nowMs = Date.now();
        const t = householdThread({ ...hh, agents: [agent] }, 24, nowMs);
        const agents = agentsOf(hh)!;
        const scoped = pieces.filter((p) => p.manifest.scope);
        const d: Dashboard = {
          label: agents[agent].label,
          agent: { ...agents[agent], sub: `${t.items.length} today · ${t.memories[agent].toLocaleString('en-US')} memories`, tabs: agentTabs(agent, '', pieces),
            id: agent, today: t.items.length,
            waiting: pendingProposals(hh, agent) + needsCount(hh, agent) + pieces.reduce((n, p) => n + p.manifest.asks.filter((x) => x.agent === agent && x.attention !== false).length, 0) - absorbedCount(hh, pieces, opts.env, agent),
            ...(() => { const bio = agentBio(hh, agent); return bio ? { bio } : {}; })(), ...windowFacts() },
          asks: absorbApprovals([...proposalAsks({ ...hh, agents: [agent] }, t.proposals), ...conversationAsks({ ...hh, agents: [agent] }), ...pieceAsks(pieces, opts.env).filter((a) => a.agent === agent || (!a.agent && scoped.some((p) => p.piece === a.source.id)))], opts.env),
          tiles: [{ label: 'Memories', value: t.memories[agent].toLocaleString('en-US'), page: 'mind', source: src },
            ...(() => { const lastWake = tapeRows(agentDir(hh, agent), 24 * 7, nowMs).find((r) => r.where.split(':')[0] === 'wake');
              return scoped.filter((p) => p.manifest.tile).map((p) => agentTile(p, agent, lastWake, nowMs)); })()],
          thread: t.items.slice(0, HOME_THREAD).map((r) => ({ agent, text: r.text, meta: [whereLabel(r.where), age(r.created, nowMs)].filter(Boolean).join(' · '), where: whereLabel(r.where), at: r.created, page: r.page })),
        };
        { const ctx = { ...ctxOf('', src), agents }; const ch = chrome(req, opts, pieces, skippedNames, `a/${agent}`, csrf, flash);
          return view('dashboard', { dashboard: d, ctx, chrome: ch, now: nowMs }); }
      }
      // Its Mind, People and Setup wear its head and tabs, like Today; a page under them keeps its own title.
      const head = (tab: string): AgentHead => ({ ...agentsOf(hh)![agent], tabs: agentTabs(agent, tab, pieces), id: agent, ...windowFacts() });
      // A piece's tab for this agent: its pages, called with LOOM_SCOPE=<agent>, links and actions kept here.
      const pp = /^p\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(rest);
      if (pp) {
        const info = pieces.find((p) => p.piece === pp[1] && agentTabOf(p));
        const path = pp[2] ?? '';
        const asrc = agentPieceSource(agent, pp[1]);
        if (!info || !validPath(path)) return send200(notFound, `a/${agent}`, ctxOf('', asrc), head(`p/${pp[1]}`));
        const pg = drawFrom(await piecePage(info, path, query, scopedEnv, callerOf(who)));
        if (typeof pg === 'string') {
          return send200({ title: agentTabOf(info)!.label, sections: [{ id: 'error', blocks: [{ type: 'callout', tone: 'bad', text: `${pp[1]} couldn't show this page (${pg}).` }] }] },
            `a/${agent}`, ctxOf(path, asrc), head(`p/${pp[1]}`));
        }
        return send200(pg, `a/${agent}`, ctxOf(path, asrc), head(`p/${pp[1]}`));
      }
      if (rest === 'setup') return send200(agentSetup(hh, agent, { ownerTokens: !opts.ownerScope }), `a/${agent}`, ctxOf(`a/${agent}/setup`, CORE), head('setup'));
      const acv = /^conversation\/(cv-[0-9a-f]{12})$/.exec(rest);
      if (acv) return send200((await conversationPage(dir, agent, acv[1], { env: opts.env, home: hh.home, days: hh.commsDays, before: /^\d{1,12}$/.test(query.before ?? '') ? Number(query.before) : undefined, page: pathname.slice(1) })) ?? notFound, `a/${agent}`, ctxOf(rest, src), head('conversation'));
      const page = validPath(rest) ? corePage(dir, rest, query) : null;
      return send200(page ?? notFound, `a/${agent}`, ctxOf(validPath(rest) ? rest : '', src), page && (rest === 'mind' || rest === 'people') ? head(rest) : undefined);
    }
    // loom's own single-agent addresses land on the default agent's view.
    if (pathname === '/mind' || pathname.startsWith('/memory/')) {
      res.writeHead(302, { location: `/a/${hh.default}${pathname}${url.search}`, ...SECURITY_HEADERS });
      return void res.end();
    }
  }

  if (pathname === '/') {
    const home = homePage(opts.contextDir, query);
    const tiles: HomeTile[] = [
      { ...home.tile, source: CORE },
      ...pieces.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) })),
    ];
    const asks: HomeAsk[] = [
      ...piecesAsks(opts.env).map((a) => ({ ...a, source: CORE })),
      ...pieces.flatMap((p) => p.manifest.asks.map((a) => ({ ...a, source: pieceSource(p.piece) }))),
    ];
    { const ctx = { source: CORE, path: '', query, csrf }; const ch = chrome(req, opts, pieces, skippedNames, '', csrf, flash);
      return view('home', { page: home.page, ctx, chrome: ch, tiles, asks }); }
  }

  if (pathname.startsWith('/p/')) {
    const rest = pathname.slice('/p/'.length);
    const slash = rest.indexOf('/');
    const piece = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? '' : decode(rest.slice(slash + 1));
    const info = pieces.find((p) => p.piece === piece && hasPages(p));
    const ch = chrome(req, opts, pieces, skippedNames, `p/${piece}`, csrf, flash);
    if (!info || path === null || !validPath(path)) { const ctx = { source: pieceSource(piece), path: '', query: {}, csrf }; return view('page', { page: notFound, ctx, chrome: ch }, 404); }
    const page = drawFrom(await piecePage(info, path, query, scopedEnv, callerOf(who)));
    const ctx = { source: pieceSource(piece), path, query, csrf, agents: agentsOf(hhScope) };
    if (typeof page === 'string') {
      { const err = { title: info.manifest.tab?.label ?? piece, sections: [{ id: 'error', blocks: [{ type: 'callout' as const, tone: 'bad' as const, text: `${piece} couldn't show this page (${page}).` }] }] };
        return view('page', { page: err, ctx, chrome: ch }, 502); }
    }
    // A piece that can't narrow to the selected agent says so, once, at the top.
    const unscoped = scopedEnv.LOOM_SCOPE && !info.manifest.scope ? agentName(agentDir(hhScope!, scopedEnv.LOOM_SCOPE)) : undefined;
    return view('page', { page, ctx, chrome: ch, unscoped }, page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
  }

  if (pathname === '/pieces') {
    const page = piecesPage(opts.env, query);
    { const ctx = { source: CORE, path: 'pieces', query, csrf }; const ch = chrome(req, opts, pieces, skippedNames, 'pieces', csrf, flash);
      return view('page', { page, ctx, chrome: ch }); }
  }

  if (pathname === '/projects' || /^\/projects\/[a-z0-9][a-z0-9-]*$/.test(pathname)) {
    const owner = { dir: opts.contextDir };
    const ix = pathname === '/projects' ? await projectsApp([owner], { env: opts.env }) : undefined;
    const page = ix ? ix.page : await projectHubPage(owner, pathname.slice('/projects/'.length), { env: opts.env });
    const ctx = { source: CORE, path: pathname.slice(1), query, csrf };
    const ch = chrome(req, opts, pieces, skippedNames, 'projects', csrf, flash);
    return view('page', { page: page ?? notFound, ctx, chrome: ch, ...(ix?.cards ? { projects: ix.cards } : {}) }, page ? 200 : 404);
  }

  const path = decode(pathname.slice(1)) ?? '\0';
  const top = path.split('/')[0];
  const ch = chrome(req, opts, pieces, skippedNames, top, csrf, flash);
  const page = validPath(path) ? corePage(opts.contextDir, path, query) : null;
  const ctx = { source: CORE, path: validPath(path) ? path : '', query, csrf };
  if (!page) return view('page', { page: notFound, ctx, chrome: ch }, 404);
  return view('page', { page, ctx, chrome: ch }, page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
}
