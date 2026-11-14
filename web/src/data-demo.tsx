/** Unlinked reference screen. The example piece is installed only in fixture homes. */
import { useState, useSyncExternalStore } from 'react';
import { AppFrame, List, Row, Empty, Loading, Error } from './kit/app';
import { call, newId, useRecords, type Call, type LiveRecord } from './data';
interface Example extends LiveRecord { title: string }
function Answer({ call: request }: { call: Call }) {
  const state = useSyncExternalStore(request.subscribe, request.getSnapshot);
  return state.pending ? <Loading label={state.status === 'offline' ? 'Waiting for connection…' : 'Saving…'} />
    : state.result?.ok === false ? <Error title="Couldn’t save" text={`${state.result.code}: ${state.result.message}`} /> : null;
}
export default function DataDemo() {
  const { records, status } = useRecords<Example>('example.record');
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState<Call>();
  return <AppFrame title="Live example" where="Live example" go={href => { location.href = href; }}>
    <p role="status">{status}</p>
    <form onSubmit={event => { event.preventDefault(); setRequest(call('example.put', { id: newId(), title })); }}>
      <label>Title <input value={title} onChange={event => setTitle(event.target.value)} /></label>
      <button type="submit" disabled={status !== 'live'}>Add record</button>
    </form>
    {request && <Answer call={request} />}
    {status === 'loading' ? <Loading /> : status !== 'live' ? <Error text={status === 'denied' ? 'Sign in again to continue.' : 'Waiting for connection.'} />
      : records.length ? <List label="Example records">{[...records].sort((a, b) => a.title.localeCompare(b.title)).map(record => <Row key={record.id} title={record.title} />)}</List>
        : <Empty title="No records yet" />}
  </AppFrame>;
}
