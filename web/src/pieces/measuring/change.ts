import { readMeasuringChange } from '../../../../src/core/measuring/change';
import type { ChangeRow, ChangeWords } from '../approval-view/answering';

export interface MeasuringSettings {
  on: boolean;
  send_outside: boolean;
  outside_address: string;
  keep_days: number;
}
export const measuringRows = (value: Readonly<MeasuringSettings>): ChangeRow[] => [
  { label: 'Measuring', value: value.on ? 'On' : 'Off' },
  { label: 'Outside monitoring tool', value: value.send_outside ? 'Send measurements' : 'Do not send measurements' },
  { label: 'Monitoring address', value: value.outside_address || 'None', long: true },
  { label: 'Local history', value: value.keep_days === 0 ? 'No local history' : `${value.keep_days} days` },
];
export const measuringWords = (before: Readonly<MeasuringSettings>, after: Readonly<MeasuringSettings>): ChangeWords => ({
  label: 'Measuring settings change', heading: 'Change Measuring settings', before: measuringRows(before), after: measuringRows(after),
  note: 'Allow applies these settings. Deny keeps the current settings.',
});
/** The checked change in plain words, for any view of the approval (the desktop's card in ./settings.tsx, the
 * board's brick). Nothing when the stored card is not exactly a Measuring settings change. Parsing is never an
 * Allow decision. */
export function measuringChangeWords(approval: { kind: string; target: string; details: string; changeSummary: string | null }): ChangeWords | null {
  const change = readMeasuringChange(approval);
  return change ? measuringWords(change.before, change.after) : null;
}
