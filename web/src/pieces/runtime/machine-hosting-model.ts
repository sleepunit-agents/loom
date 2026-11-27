/** What a machine hosts, as words: the fields read and the lines said. No component; the desktop's
 * `MachineHostingDetails` (./machine-hosting.tsx) and the boards page's `machines` brick both say these. */
export const machineHostingFields = 'owner revokedAt hostsAny reportOnly boxAgentsByBox { agent lent }';

export type MachineHosting = {
  owner: string;
  revokedAt: string | null;
  hostsAny: boolean;
  reportOnly: boolean;
  boxAgentsByBox: { agent: string; lent: boolean }[];
};
export const listedAgents = (box: MachineHosting) => box.boxAgentsByBox.map(({agent, lent}) => lent ? `${agent} (lent)` : agent);
export const hostingWord = (box: MachineHosting) => box.revokedAt ? 'Enrollment revoked' : box.reportOnly ? 'Reporting only'
  : box.hostsAny ? 'Listed agents and agents of the owner' : 'Listed agents only';
