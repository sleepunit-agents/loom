/** Gallery fixtures for the parts of the page that are no brick: the conversation's header (its Stop, the panel
 * of conversations, the bridge receipt) and a placement whose brick did not load. */
import type { Scene } from '../scenes';
import type { Attention } from '../../board-head';
import type { TokenNotice } from '../../token-notices';
import { open, thread, threadsData } from './attention';
import { ago } from './time';

/** The board's header row as a scene draws it (../../board-head.tsx): how many chips, and which notices. */
export interface HeadScene { /** A list the scene opens once drawn: the chips' +N or count, or the notices. */ open?: 'more' | 'notices'; chips: number; tokens?: TokenNotice[]; stale?: boolean; lost?: number; getting?: boolean; heading?: string; closed?: boolean }
/** What a page scene draws: the conversation's header, the board's header row, or a placement that lost its body. */
export interface PageScene extends Scene { part: 'header' | 'board-head' | 'fetching' | 'lost'; /** The header's room, tall enough for what opens under it. */ height?: number; head?: HeadScene }
const id = 'th:beds';
const head = (over: object = {}) => ({ thread: thread(id, 'Watering the raised beds', 'fern', ago(2), { working: true, ...over }) });
const header = (name: string, over: object = {}, more: Partial<PageScene> = {}): PageScene => ({ name, part: 'header', params: { thread: id }, data: { ...threadsData(open), BoardsThreadHead: head(over) }, ...more });
const receipt = (acceptedAt: string | null, replied: boolean) => ({ latestBridgeReceipt: { agent: 'fern', receivedAt: ago(6), acceptedAt, replied } });

export const pageScenes: PageScene[] = [
  header('header-working'),
  header('header-stop-asking', {}, { press: ['Stop…'], height: 220 }),
  header('header-stopping', { stopRequested: true }),
  header('header-quiet', { working: false }),
  header('header-panel', {}, { press: ['Conversations'], height: 760 }),
  header('header-panel-delete', {}, { press: ['Conversations', 'Delete…'], height: 820 }),
  { ...header('header-receipt', { venue: 'slack' }), data: { ...threadsData(open), BoardsThreadHead: head({ venue: 'slack', working: false }), ConversationBridgeReceipt: receipt(ago(5), true) } },
  { ...header('header-receipt-waiting', { venue: 'discord' }), data: { ...threadsData(open), BoardsThreadHead: head({ venue: 'discord' }), ConversationBridgeReceipt: receipt(null, false) } },
  { name: 'brick-fetching', part: 'fetching', params: {}, data: {} },
  { name: 'brick-lost', part: 'lost', params: {}, data: {} },
];

/** What a board's flagged placements say in its header row, first to last. */
export const attention: Attention[] = [
  { id: 'p-1', title: 'Pull request', sub: '#2361', flag: 'Look here' },
  { id: 'p-2', title: 'Session', sub: 'cv-81', flag: 'Failed' },
  { id: 'p-3', title: 'Ticket', sub: 't-412', flag: 'Closed' },
  { id: 'p-4', title: 'Approval', sub: 'ap-4', flag: 'Look here' },
  { id: 'p-5', title: 'Lanes', sub: 'garden', flag: 'Look here' },
  { id: 'p-6', title: 'Question', sub: 'in-3', flag: 'Look here' },
  { id: 'p-7', title: 'Checks', sub: 'loom#2390', flag: 'Failing' },
  { id: 'p-8', title: 'Ticket', sub: 't-7', flag: 'Reopened' },
  { id: 'p-9', title: 'Backlog', sub: 'garden', flag: 'Look here' },
];
const token = (label: string, fate: TokenNotice['fate'], id = 1): TokenNotice => ({ id, label, kind: 'member', fate, had: 0 });
const headScene = (name: string, scene: HeadScene, more: Partial<PageScene> = {}): PageScene => ({ name, part: 'board-head', params: {}, data: {}, head: scene, height: 260, ...more });
/** The board's header row: quiet, with two and nine chips, with each notice, getting new data, everything at once, and a list opened. */
export const headScenes: PageScene[] = [
  headScene('head-quiet', { chips: 0 }),
  headScene('head-two', { chips: 2 }),
  headScene('head-nine', { chips: 9 }),
  headScene('head-nine-open', { chips: 9, open: 'more' }, { height: 400 }),
  headScene('head-token', { chips: 0, tokens: [token('pump-laptop', 'unknown')] }),
  headScene('head-token-open', { chips: 0, open: 'notices', tokens: [token('pump-laptop', 'unknown'), token('shed-pi', 'made', 2)], stale: true, lost: 2 }, { height: 400 }),
  headScene('head-update', { chips: 0, stale: true }),
  headScene('head-lost', { chips: 0, lost: 2 }),
  headScene('head-getting', { chips: 2, getting: true }),
  headScene('head-everything', { chips: 9, tokens: [token('pump-laptop', 'unknown')], stale: true, lost: 1, getting: true }),
  headScene('head-long-title', { chips: 2, heading: 'Watering the raised beds before the frost, and the pump that keeps tripping' }),
  headScene('head-closed', { chips: 0, closed: true }),
];
