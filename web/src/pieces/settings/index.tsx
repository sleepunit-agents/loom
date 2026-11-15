import { useState, type ComponentProps } from 'react';
import { useDataQuery } from '../../data/graphql';
import { SecretsView, type SecretsFolder, type SecretsSelection } from '../secrets-view';
import { settingsQuery, settingsSnapshot, type SettingsData } from './data';

const base = '/p/settings-preview';
const folders = new Set<SecretsFolder>(['secrets', 'requests', 'grants', 'pieces']);
function selection(path: string): { folder: SecretsFolder; selected?: SecretsSelection } {
  const parts = path.split('?')[0].slice(base.length).split('/').filter(Boolean);
  const candidate = parts[0] === 'item' ? parts[1] : parts[0];
  const folder = folders.has(candidate as SecretsFolder) ? candidate as SecretsFolder : 'secrets';
  if (parts[0] !== 'item' || !parts[2] || parts.length !== 3 || !folders.has(candidate as SecretsFolder)) return { folder };
  try { return { folder, selected: { folder, id: decodeURIComponent(parts[2]) } }; }
  catch { return { folder }; }
}
function LiveSettings({ path, go }: { path?: string; go?: (path: string) => void }) {
  const [local, setLocal] = useState(base);
  const route = selection(path ?? local), navigate = go ?? setLocal;
  const snapshot = settingsSnapshot(useDataQuery<SettingsData>(settingsQuery));
  return <SecretsView key={snapshot.member} snapshot={snapshot} member={snapshot.member} {...route}
    select={selected => navigate(selected ? `${base}/item/${selected.folder}/${encodeURIComponent(selected.id)}` : `${base}/${route.folder}`)}
    changeFolder={folder => navigate(`${base}/${folder === 'add' ? 'secrets' : folder}`)} />;
}
export default function SettingsApp({ shared, ...navigation }: {
  path?: string; go?: (path: string) => void; shared?: ComponentProps<typeof SecretsView>;
} = {}) {
  return shared ? <SecretsView {...shared} /> : <LiveSettings {...navigation} />;
}
