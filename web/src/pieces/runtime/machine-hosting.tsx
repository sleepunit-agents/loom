import {hostingWord, listedAgents, type MachineHosting} from './machine-hosting-model';
export {machineHostingFields, type MachineHosting} from './machine-hosting-model';

export function MachineHostingDetails({box}: {box: MachineHosting}) {
  const listed = listedAgents(box);
  const hosting = hostingWord(box);
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
    <dt>Owner</dt><dd>{box.owner}</dd>
    <dt>Hosting</dt><dd>{hosting}</dd>
    <dt>Listed agents</dt><dd className="break-words">{listed.join(', ') || 'None listed'}</dd>
  </dl>;
}
