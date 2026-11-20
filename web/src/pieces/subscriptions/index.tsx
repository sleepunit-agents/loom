import { AppFrame } from '../../kit';
import { RuntimeAccounts } from '../runtime/model-accounts';

export default function Subscriptions({ go = () => {} }: { go?: (path: string) => void }) {
  return <AppFrame title="Subscriptions" where="System" go={go}>
    <div className="overflow-auto p-5"><RuntimeAccounts /></div>
  </AppFrame>;
}
