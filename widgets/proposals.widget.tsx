/**
 * loom "Proposals" widget — the capture-propose review queue (Preact + App SDK).
 * The interactive read+write case: lists pending memory drafts, and ratifies
 * (commit to memory) or rejects each via callServerTool. The UI capture-propose
 * was missing. INLINE = pending count + newest; FULLSCREEN = the full queue.
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { App } from '@modelcontextprotocol/ext-apps';

interface Proposal {
  id: number;
  category: string;
  title: string;
  content: string;
  source?: string | null;
  created?: string;
}

const app = new App({ name: 'loom-proposals', version: '1.0.0' });

function snippet(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function Widget() {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [mode, setMode] = useState('inline');
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState('');

  function ingest(sc: unknown) {
    const p = (sc as { proposals?: Proposal[] })?.proposals;
    if (Array.isArray(p)) setItems(p);
  }

  useEffect(() => {
    app.ontoolresult = (r: { structuredContent?: unknown }) => ingest(r.structuredContent);
    app.onhostcontextchanged = () => setMode((app.getHostContext() as { displayMode?: string }).displayMode ?? 'inline');
    app.connect().then(() => setMode((app.getHostContext() as { displayMode?: string }).displayMode ?? 'inline'));
  }, []);

  async function refresh() {
    const r = (await app.callServerTool({ name: 'loom_proposals', arguments: {} })) as { structuredContent?: unknown };
    ingest(r.structuredContent);
  }
  async function act(p: Proposal, tool: 'memory_ratify' | 'memory_reject') {
    setBusy(p.id);
    setNote('');
    try {
      await app.callServerTool({ name: tool, arguments: { id: p.id } });
      setNote(tool === 'memory_ratify' ? `✓ ratified "${snippet(p.title, 40)}" into memory` : `✗ rejected "${snippet(p.title, 40)}"`);
      await refresh();
    } catch (e) {
      setNote(`failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }
  const setDisplay = (m: 'inline' | 'fullscreen') => app.requestDisplayMode({ mode: m }).catch(() => {});

  if (!items) return <div class="card"><h1>🧵 Proposals</h1><p class="status">loading the queue…</p></div>;

  const full = mode === 'fullscreen';
  const Btn = ({ p }: { p: Proposal }) => (
    <span>
      <button onClick={() => act(p, 'memory_ratify')} disabled={busy === p.id}
        style={{ borderColor: '#16a34a' }}>{busy === p.id ? '…' : 'ratify'}</button>
      <button onClick={() => act(p, 'memory_reject')} disabled={busy === p.id}
        style={{ borderColor: '#f87171' }}>reject</button>
    </span>
  );

  return (
    <div class="card" style={full ? { maxWidth: 'none' } : {}}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
        <h1>🧵 Proposals</h1>
        <span class="row">{items.length} pending</span>
      </div>

      {items.length === 0 ? (
        <p class="sub">Queue is empty — nothing staged for review.</p>
      ) : !full ? (
        <div>
          <p class="sub">Drafts awaiting your ratification — review the full queue to act.</p>
          {items.slice(0, 3).map((p) => (
            <p key={p.id} class="row" style={{ margin: '4px 0' }}>
              <b>{p.title}</b> <span style={{ opacity: 0.7 }}>· {p.category}</span>
            </p>
          ))}
          <div style={{ marginTop: '12px' }}>
            <button onClick={() => setDisplay('fullscreen')}>review queue →</button>
          </div>
        </div>
      ) : (
        <div>
          <p class="sub">Ratify commits a draft to memory (through the validated write); reject discards it.</p>
          {items.map((p) => (
            <div key={p.id} style={{ borderLeft: '3px solid #38bdf8', padding: '4px 0 6px 10px', margin: '0 0 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' }}>
                <div><b>{p.title}</b> <span class="row" style={{ opacity: 0.7 }}>· {p.category}{p.source ? ` · ${p.source}` : ''}</span></div>
                <Btn p={p} />
              </div>
              <div class="row" style={{ fontSize: '13px', marginTop: '2px' }}>{snippet(p.content, 240)}</div>
            </div>
          ))}
          <div style={{ position: 'sticky', bottom: 0, paddingTop: '8px' }}>
            <button onClick={() => setDisplay('inline')}>← collapse</button>
            <button onClick={refresh}>refresh</button>
          </div>
        </div>
      )}
      {note ? <p class="status">{note}</p> : null}
    </div>
  );
}

render(<Widget />, document.getElementById('root')!);
