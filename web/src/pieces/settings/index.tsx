import { ValueControl, RequestControl, RevokeControl, DefaultControl, RuleControl } from './controls';
import { useState, type ComponentProps } from 'react';
import { useDataQuery } from '../../data/graphql';
import { SecretsView, type SecretsFolder, type SecretsSelection } from '../secrets-view';
import { settingsQuery, settingsSnapshot, type SettingsData } from './data';

const base = '/p/settings-preview';
const folders = new Set<SecretsFolder>(['secrets', 'requests', 'grants', 'pieces', 'add']);
function selection(path: string): { folder: SecretsFolder; selected?: SecretsSelection } {
  const parts = path.split('?')[0].slice(base.length).split('/').filter(Boolean);
  const candidate = parts[0] === 'item' ? parts[1] : parts[0];
  const folder = folders.has(candidate as SecretsFolder) ? candidate as SecretsFolder : 'secrets';
  const id = parts[0] === 'item' && parts.length === 3 ? parts[2] : parts.length === 2 ? parts[1] : undefined;
  if (!id || !folders.has(candidate as SecretsFolder)) return { folder };
  try { return { folder, selected: { folder, id: decodeURIComponent(id) } }; }
  catch { return { folder }; }
}
function LiveSettings({ path, go }: { path?: string; go?: (path: string) => void }) {
  const [local, setLocal] = useState(base);
  const route = selection(path ?? local), navigate = go ?? setLocal;
  const snapshot = settingsSnapshot(useDataQuery<SettingsData>(settingsQuery));
  return <SecretsView key={snapshot.member} snapshot={snapshot} member={snapshot.member} {...route}
    select={selected => navigate(selected ? `${base}/item/${selected.folder}/${encodeURIComponent(selected.id)}` : `${base}/${route.folder}`)}
    changeFolder={folder => navigate(`${base}/${folder}`)}
    cards={{ add: () => <ValueControl />, secret: name => <><ValueControl key={name} name={name} description={snapshot.secrets.find(row => row.name === name)?.description} /><RuleControl key={JSON.stringify([name, snapshot.rules, snapshot.ruleAgents])} secret={name} snapshot={snapshot} /></>,
      request: id => <RequestControl key={id} id={id} />, grant: id => <RevokeControl key={id} id={id} />,
      piece: () => <DefaultControl key={snapshot.defaultAnswer} answer={snapshot.defaultAnswer ?? 'ask'} /> }}
    pieces={[{ id: 'secret-default', label: 'Secret default', description: 'Standing answer for secrets with no rule.', open: () => navigate(`${base}/item/pieces/secret-default`) }]} />;
}
export default function SettingsApp({ shared, ...navigation }: {
  path?: string; go?: (path: string) => void; shared?: ComponentProps<typeof SecretsView>;
} = {}) {
  return shared ? <SecretsView {...shared} /> : <LiveSettings {...navigation} />;
}
