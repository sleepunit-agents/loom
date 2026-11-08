/**
 * loom "Top of Mind" widget — the first REAL loom widget (Preact + ext-apps App SDK).
 *
 * Renders the salience-tiered memory digest. It changes its content by display
 * mode (the unlock): INLINE shows a compact summary — the hottest few; click
 * "expand" → FULLSCREEN shows the full Hot/Warm/Cool landscape with snippets.
 * Data comes from the loom_top_of_mind tool result (structuredContent) and can
 * be refreshed live via callServerTool.
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { App } from '@modelcontextprotocol/ext-apps';

type Tier = 'Hot' | 'Warm' | 'Cool';
interface Atom { title: string; category: string; content: string; salience: number; tier: Tier; }
interface Digest { atoms: Atom[]; total: number; }

const TIER_LABEL: Record<Tier, string> = { Hot: 'Top of mind', Warm: 'Recent', Cool: 'Background' };
const TIER_COLOR: Record<Tier, string> = { Hot: '#f87171', Warm: '#fbbf24', Cool: '#60a5fa' };
const TIER_ORDER: Tier[] = ['Hot', 'Warm', 'Cool'];

const app = new App({ name: 'loom-top-of-mind', version: '1.0.0' });

function snippet(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function Pill({ tier }: { tier: Tier }) {
  return (
    <span style={{ background: TIER_COLOR[tier], color: '#0b1220', fontWeight: 700, fontSize: '11px',
      padding: '1px 8px', borderRadius: '999px' }}>{TIER_LABEL[tier]}</span>
  );
}

function Widget() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [mode, setMode] = useState<string>('inline');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    app.ontoolresult = (r: { structuredContent?: unknown }) => {
      if (r.structuredContent) setDigest(r.structuredContent as Digest);
    };
    app.onhostcontextchanged = () => setMode((app.getHostContext() as { displayMode?: string }).displayMode ?? 'inline');
    app.connect().then(() => setMode((app.getHostContext() as { displayMode?: string }).displayMode ?? 'inline'));
  }, []);

  async function setDisplay(m: 'inline' | 'fullscreen') {
    try { await app.requestDisplayMode({ mode: m }); } catch { /* host may refuse */ }
  }
  async function refresh() {
    setBusy(true);
    try {
      const r = (await app.callServerTool({ name: 'loom_top_of_mind', arguments: {} })) as { structuredContent?: unknown };
      if (r.structuredContent) setDigest(r.structuredContent as Digest);
    } finally { setBusy(false); }
  }

  if (!digest) return <div class="card"><h1>🧵 Top of Mind</h1><p class="status">loading the digest…</p></div>;

  const full = mode === 'fullscreen';
  const atoms = digest.atoms;
  const head = atoms.slice(0, 5);

  return (
    <div class="card" style={full ? { maxWidth: 'none' } : {}}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
        <h1>🧵 Top of Mind</h1>
        <span class="row">{digest.total} memories</span>
      </div>

      {!full ? (
        <div>
          <p class="sub">The hottest {head.length} right now — expand for the full landscape.</p>
          {head.map((a, i) => (
            <p key={i} class="row" style={{ margin: '4px 0' }}>
              <Pill tier={a.tier} /> <b>{a.title}</b> <span style={{ opacity: 0.7 }}>· {a.category}</span>
            </p>
          ))}
          <div style={{ marginTop: '12px' }}>
            <button onClick={() => setDisplay('fullscreen')}>expand to fullscreen →</button>
            <button onClick={refresh} disabled={busy}>{busy ? '…' : 'refresh'}</button>
          </div>
        </div>
      ) : (
        <div>
          <p class="sub">The full salience landscape, hottest first.</p>
          {TIER_ORDER.map((tier) => {
            const group = atoms.filter((a) => a.tier === tier);
            if (!group.length) return null;
            return (
              <div key={tier} style={{ marginBottom: '14px' }}>
                <p style={{ margin: '0 0 6px' }}><Pill tier={tier} /> <span class="row">({group.length})</span></p>
                {group.map((a, i) => (
                  <div key={i} style={{ borderLeft: `3px solid ${TIER_COLOR[tier]}`, padding: '2px 0 2px 10px', margin: '0 0 8px' }}>
                    <div><b>{a.title}</b> <span class="row" style={{ opacity: 0.7 }}>· {a.category}</span></div>
                    <div class="row" style={{ fontSize: '13px' }}>{snippet(a.content, 180)}</div>
                  </div>
                ))}
              </div>
            );
          })}
          <div style={{ position: 'sticky', bottom: 0, paddingTop: '8px' }}>
            <button onClick={() => setDisplay('inline')}>← collapse</button>
            <button onClick={refresh} disabled={busy}>{busy ? '…' : 'refresh'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

render(<Widget />, document.getElementById('root')!);
