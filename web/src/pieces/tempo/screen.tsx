import { tempoActions } from './commands';
import { TempoApp } from './feed';
/** The live selection supplies the household timezone. UTC is only the empty
 * loading fallback; a browser's local zone never changes a household schedule. */
export default function TempoScreen() { return <TempoApp timezone="UTC" actions={tempoActions()} />; }
