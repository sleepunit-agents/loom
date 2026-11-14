/** A routing decision, never permission to read, file or start work. Runtime owns
 * the destination witness and must recheck it at the eventual delivery boundary. */
import type { Scope } from '../../core/index.js';
import type { Wake } from './store.js';
export interface ClockDestination extends Scope {
  agent: string;
  conversation: string;
  place: string;
  current(): boolean;
}
export type ClockDestinationReader = (scope: Scope & {agent:string;place:string}) => ClockDestination | undefined;
export type ClockRoute = {kind:'fresh';place:string} | {kind:'join';destination:ClockDestination};
export function clockRoute(wake: Wake, resolve?: ClockDestinationReader): ClockRoute {
  const fresh:ClockRoute={kind:'fresh',place:`wake:${wake.id}`};
  // A caller's arbitrary explicit place is not a reusable conversation name.
  // Only Clock's lane namespace can be considered, including an exact explicit
  // lane place; archive/capacity/by/owner steering supply no destination proof.
  const name=wake.schedule ?? wake.file?.split('/').at(-1)?.replace(/\.[^.]*$/,'');
  const place=wake.place ?? (name ? `lane:${name}`.slice(0,200) : undefined);
  const original=wake.authorship;
  if(!place?.startsWith('lane:') || original?.origin!==wake.agent || !original.conversation
    || original.member!==wake.member || original.project!==wake.project) return fresh;
  const destination=resolve?.({agent:wake.agent,member:wake.member,project:wake.project,place});
  return destination && destination.agent===wake.agent && destination.member===wake.member
    && destination.project===wake.project && destination.place===place
    && destination.conversation===original.conversation && destination.current()
    ? {kind:'join',destination} : fresh;
}
