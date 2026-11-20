import { AppFrame } from '../../kit';
import { RuntimeAccounts } from '../runtime/model-accounts';

export default function Subscriptions({ go = () => {}, active = true }: { go?: (path: string) => void; active?: boolean }) {
  return <AppFrame title="Subscriptions" where="System" go={go}>
    <div className="overflow-auto p-5"><RuntimeAccounts active={active} /></div>
  </AppFrame>;
}
