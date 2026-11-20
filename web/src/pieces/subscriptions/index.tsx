import {AddSubscription} from './create';
import { AppFrame } from '../../kit';
import { RuntimeAccounts } from '../runtime/model-accounts';

export default function Subscriptions({ go = () => {}, active = true }: { go?: (path: string) => void; active?: boolean }) {
  return <AppFrame title="Subscriptions" where="System" go={go}>
    <div className="grid content-start gap-4 overflow-auto p-5">{active&&<AddSubscription/>}<RuntimeAccounts active={active} /></div>
  </AppFrame>;
}
