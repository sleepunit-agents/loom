import { displayName } from '../kit/words';

/** Older Slack intake used the channel id or thread timestamp as the title. */
export function conversationTitle(row: {venue:string; label?:string; place:string}): string {
  const title = row.label || 'Conversation';
  if (row.venue !== 'slack') return title;
  let place: unknown;
  try { place = JSON.parse(row.place); } catch { return title; }
  if (!Array.isArray(place) || (place.length !== 3 && place.length !== 4)) return title;
  const [workspace,channel,thread,scope] = place;
  if (typeof workspace !== 'string' || !workspace || typeof channel !== 'string' || !channel ||
      (thread !== null && (typeof thread !== 'string' || !thread))) return title;
  if (row.label !== channel && row.label !== thread) return title;
  if (place.length === 4) {
    if (!Array.isArray(scope)) return title;
    if (scope[0] === 'group' && scope.length === 1) return thread ? 'Slack group direct message thread' : 'Slack group direct message';
    if (scope[0] === 'member' && scope.length === 2 && (scope[1] === null || typeof scope[1] === 'string')) {
      const member = typeof scope[1] === 'string' ? displayName(scope[1]) : '';
      return (thread ? 'Slack direct message thread' : 'Slack direct message') + (member ? ' with ' + member : '');
    }
    return title;
  }
  return thread ? 'Slack channel thread' : 'Slack channel';
}
