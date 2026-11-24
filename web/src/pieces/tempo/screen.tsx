import { useMemo } from 'react';
import { tempoActions } from './commands';
import { LiveTempoCard, TempoApp } from './feed';
/** The live selection supplies the household timezone. UTC is only the empty
 * loading fallback; a browser's local zone never changes a household schedule. */
export default function TempoScreen({path,go}: {path?:string;go?:(path:string)=>void} = {}) {
  const actions = useMemo(() => tempoActions(), []);
  const currentPath = path ?? (typeof location === 'undefined' ? '' : location.pathname);
  const match = /^\/p\/tempo\/trigger\/([^/]+)$/.exec(currentPath);
  if (match) {
    let id = '';
    try { id = decodeURIComponent(match[1]); } catch { /* An invalid link has no visible trigger. */ }
    return <LiveTempoCard triggerId={id} timezone="UTC" actions={actions} go={go}/>;
  }
  return <TempoApp timezone="UTC" actions={actions} go={go}/>;
}
