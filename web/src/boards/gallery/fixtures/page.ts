/** Gallery fixtures for the parts of the page that are no brick: the conversation's header (its Stop, the panel
 * of conversations, the bridge receipt) and a placement whose brick did not load. */
import type { Scene } from '../scenes';
import { open, thread, threadsData } from './attention';
import { ago } from './time';

/** What a page scene draws: the conversation's header, or a placement that lost its body. */
export interface PageScene extends Scene { part: 'header' | 'fetching' | 'lost' | 'lost-stale'; /** The header's room, tall enough for what opens under it. */ height?: number }
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
  { name: 'brick-lost-stale', part: 'lost-stale', params: {}, data: {} },
];
