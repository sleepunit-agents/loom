export const machineHostingFields = 'owner revokedAt hostsAny reportOnly boxAgentsByBox { agent lent }';

export type MachineHosting = {
  owner: string;
  revokedAt: string | null;
  hostsAny: boolean;
  reportOnly: boolean;
  boxAgentsByBox: { agent: string; lent: boolean }[];
};

export function MachineHostingDetails({box}: {box: MachineHosting}) {
  const listed = box.boxAgentsByBox.map(({agent, lent}) => lent ? `${agent} (lent)` : agent);
  const hosting = box.revokedAt ? 'Enrollment revoked' : box.reportOnly ? 'Reporting only'
    : box.hostsAny ? 'Listed agents and agents of the owner' : 'Listed agents only';
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
    <dt>Owner</dt><dd>{box.owner}</dd>
    <dt>Hosting</dt><dd>{hosting}</dd>
    <dt>Listed agents</dt><dd className="break-words">{listed.join(', ') || 'None listed'}</dd>
  </dl>;
}
