import { TempoApp } from './feed';
/** Display instants in the browser's timezone until the household projection
 * supplies its configured timezone. The view always names the timezone. */
export default function TempoScreen() {
  return <TempoApp timezone={Intl.DateTimeFormat().resolvedOptions().timeZone} />;
}
