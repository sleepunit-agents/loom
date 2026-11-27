/** Parameters for every brick of the catalogue, made from each brick's own schema: a made-up id for each record it
 * names, by the kind of record, and the default for everything else. A suite that draws every brick reads these,
 * so a new brick is drawn there without being listed. A new kind of record needs its made-up id here. */
import { bricks, type RecordKind } from '../../../src/core/boards/bricks';

const ids: Record<RecordKind, string> = {
  project: 'garden-proj', ticket: 't-7', change: 'github:acme/app-repo#9', repository: 'loom-repo', person: 'member:sam', agent: 'art-agent',
  'inbox item': 'in-3', approval: 'ap-4', session: 'cv-fence-0001', 'knowledge page': 'pump-page', 'knowledge topic': 'pond-topic',
};
export const samples = (): Record<string, Record<string, string | number>> => Object.fromEntries(bricks.map((b) => [
  b.name, b.params.parse(Object.fromEntries(Object.entries(b.references).map(([name, kind]) => [name, ids[kind]]))) as Record<string, string | number>,
]));
