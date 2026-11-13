import { conversationKind, type Message, type Route, type Venue } from './model.js';
/** No trust decisions here: this selects recipients; runtime gates them. */
export function addressed(venue: Venue, message: Message, route: Route | undefined, bots: Venue[]): boolean {
  const channel = message.parent ?? message.channel;
  if (!venue.enabled || venue.ignore.includes(channel) || (venue.only.length > 0 && !venue.only.includes(channel))) return false;
  if (message.user === venue.bot) return false;
  const {dm,group}=conversationKind(venue,message);
  if (dm || (venue.platform === 'slack' && group)) return !message.bot && !message.webhook;
  const peers = bots.filter(b => b.platform === venue.platform && b.workspace === venue.workspace);
  if (message.bot || message.webhook) return !!route?.peer && peers.some(p => p.bot === message.user) && message.mentions.includes(venue.bot);
  if (message.mentions.includes(venue.bot)) return true;
  if (peers.some(p => message.mentions.includes(p.bot))) return false;
  return route?.primary === venue.agent;
}
export const isStop = (text: string) => /^(stop|cancel)[!.]*$/i.test(text.replace(/<@[!&]?[A-Za-z0-9]+>/g, '').trim());
