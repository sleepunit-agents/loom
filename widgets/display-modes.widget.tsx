/**
 * loom MCP-App "display modes" trial — a Preact widget (the recommended view
 * layer) that exercises the three MCP Apps display modes: inline / fullscreen /
 * pip. It shows the host context (which modes Desktop actually supports, the
 * theme, container size) and lets you request each mode via the App SDK's
 * requestDisplayMode, reporting what the host actually set.
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { App } from '@modelcontextprotocol/ext-apps';

type DisplayMode = 'inline' | 'fullscreen' | 'pip';
const MODES: DisplayMode[] = ['inline', 'fullscreen', 'pip'];

interface HostCtx {
  displayMode?: string;
  availableDisplayModes?: string[];
  theme?: string;
  platform?: string;
  containerDimensions?: unknown;
}

const app = new App({ name: 'loom-display-modes', version: '1.0.0' });

function Widget() {
  const [ctx, setCtx] = useState<HostCtx | null>(null);
  const [status, setStatus] = useState('connecting…');
  const [last, setLast] = useState('');

  useEffect(() => {
    app.onhostcontextchanged = () => setCtx({ ...(app.getHostContext() as HostCtx) });
    app
      .connect()
      .then(() => {
        setCtx({ ...(app.getHostContext() as HostCtx) });
        setStatus('✓ connected (Preact + ext-apps App SDK)');
      })
      .catch((e: unknown) => setStatus('✗ connect failed: ' + String(e)));
  }, []);

  async function request(mode: DisplayMode) {
    setLast(`requesting ${mode}…`);
    try {
      const r = (await app.requestDisplayMode({ mode })) as { mode?: string };
      setLast(`requested "${mode}" → host set "${r.mode ?? '?'}"`);
      setCtx({ ...(app.getHostContext() as HostCtx) });
    } catch (e) {
      setLast(`request "${mode}" failed: ${String(e)}`);
    }
  }

  const available = ctx?.availableDisplayModes ?? [];
  return (
    <div class="card">
      <span class="ok">✅ RENDERED</span>
      <h1>🧵 loom — display modes (Preact)</h1>
      <p class="sub">Try each MCP Apps display mode; the host echoes what it actually set.</p>
      <p class="status">{status}</p>
      <p class="row">
        current: <b>{ctx?.displayMode ?? '?'}</b> · theme: <b>{ctx?.theme ?? '?'}</b> · platform:{' '}
        <b>{ctx?.platform ?? '?'}</b>
      </p>
      <p class="row">
        host supports: <b>{available.length ? available.join(', ') : '(none reported)'}</b>
      </p>
      <div>
        {MODES.map((m) => (
          <button
            key={m}
            onClick={() => request(m)}
            disabled={available.length > 0 && !available.includes(m)}
          >
            request {m}
          </button>
        ))}
      </div>
      {last ? <p class="row">{last}</p> : null}
      <pre>{JSON.stringify(ctx ?? {}, null, 2)}</pre>
    </div>
  );
}

render(<Widget />, document.getElementById('root')!);
