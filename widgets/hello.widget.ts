/**
 * loom MCP-App "hello" widget — the iframe side, built on the OFFICIAL
 * @modelcontextprotocol/ext-apps `App` class (NOT a hand-rolled handshake).
 *
 * The App class performs the full ui/initialize -> initialized handshake,
 * autoResize (ui/notifications/size-changed), tool-result delivery, and the
 * callServerTool round-trip — the protocol details we got wrong by hand. esbuild
 * bundles this + the SDK into a single inline <script> (see scripts/build-widgets.mjs).
 */
import { App } from '@modelcontextprotocol/ext-apps';

const el = (id: string) => document.getElementById(id) as HTMLElement;
const status = el('status');
const out = el('out');

function show(label: string, data: unknown): void {
  status.textContent = label;
  out.textContent = data == null ? '' : JSON.stringify(data, null, 2);
}

const app = new App({ name: 'loom-hello', version: '1.0.0' });

// The tool result that opened this widget is delivered here after connect().
app.ontoolresult = (result: { content?: unknown; structuredContent?: unknown }) => {
  show('✓ tool result received from the host', result.structuredContent ?? result.content);
};

el('ping').addEventListener('click', async () => {
  status.textContent = 'calling loom_hello via callServerTool…';
  try {
    const r = (await app.callServerTool({ name: 'loom_hello', arguments: {} })) as {
      content?: unknown;
      structuredContent?: unknown;
    };
    show('✓ callServerTool round-tripped', r.structuredContent ?? r.content);
  } catch (e) {
    show('✗ callServerTool failed', String(e));
  }
});

app
  .connect()
  .then(() => {
    status.textContent = '✓ connected — handshake complete (ext-apps App SDK)';
  })
  .catch((e: unknown) => {
    status.textContent = '✗ connect failed: ' + String(e);
  });
