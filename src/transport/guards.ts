/**
 * Transport guards (c-loom-transport §boundary) — the security boundary as
 * pure, testable behavior, independent of the HTTP wiring that calls them.
 *
 *   assertSafeBind   — refuse a public / 0.0.0.0 bind (bind-safety)
 *   checkBearer      — refuse an unauthenticated call when a token is set (auth gate)
 *   checkPayloadSize — refuse an oversized request before the handler runs
 *
 * The HTTP serve path applies these at startup (bind) and per request (auth,
 * size); keeping them pure means the contract is verified without a live socket.
 */

export interface GuardResult {
  ok: boolean;
  error?: string;
}

/** Default request-body cap (1 MiB) — overridable via LOOM_HTTP_MAX_BYTES. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function v4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1, 5).map((n) => Number(n));
  if (o.some((n) => n > 255)) return null;
  return o;
}

/**
 * A host is mesh-or-local-safe if it is loopback, an RFC1918 private address,
 * the Tailscale CGNAT range (100.64.0.0/10), or an IPv6 ULA / link-local /
 * loopback. Everything else — and explicitly the 0.0.0.0 / :: bind-all wildcard
 * and any globally routable address — is refused.
 */
export function isSafeBindHost(hostRaw: string): boolean {
  const host = hostRaw.trim().toLowerCase();
  if (host === '' || host === '*') return false;
  // bind-all wildcards: the exact thing bind-safety exists to refuse
  if (host === '0.0.0.0' || host === '::' || host === '[::]' || host === '0:0:0:0:0:0:0:0') {
    return false;
  }
  // named loopback
  if (host === 'localhost') return true;

  const v4 = v4Octets(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 192 && b === 168) return true; // private 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
    if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    return false; // any other v4 is treated as public
  }

  // IPv6 (possibly bracketed)
  const v6 = host.replace(/^\[|\]$/g, '');
  if (v6 === '::1') return true; // loopback
  if (v6.startsWith('fe80:') || v6.startsWith('fe80::')) return true; // link-local
  if (/^f[cd][0-9a-f]{0,2}:/.test(v6)) return true; // ULA fc00::/7
  return false; // any other v6 (incl. global unicast) is public
}

/** Bind-safety: throws at startup if asked to listen on a public/wildcard host. */
export function assertSafeBind(host: string): void {
  if (!isSafeBindHost(host)) {
    throw new Error(
      `unsafe-bind: refusing to bind loom to "${host}" — only loopback or a mesh ` +
        `(Tailscale/RFC1918) interface is allowed. Tailscale is the access control; ` +
        `loom must never listen on a public or 0.0.0.0 interface.`,
    );
  }
}

/** Constant-time string compare (avoids leaking the token via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Auth gate: when a bearer token is configured, a call must present the matching
 * token. When no token is configured, the call is allowed (the network boundary
 * — loopback/mesh per bind-safety — is the access control). `presented` is the
 * raw Authorization header value (e.g. "Bearer abc"); the scheme is tolerated.
 */
export function checkBearer(
  configured: string | undefined,
  presented: string | undefined,
): GuardResult {
  if (!configured) return { ok: true };
  const token = (presented ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token === '') return { ok: false, error: 'unauthorized: missing bearer token' };
  if (!timingSafeEqual(token, configured)) {
    return { ok: false, error: 'unauthorized: bearer token mismatch' };
  }
  return { ok: true };
}

/**
 * Multi-token auth gate (t-677): each configured token maps to one identity,
 * so a single scoped endpoint (the knowledge-only service) can serve several
 * identities while still deriving WHICH one made a given call — the bearer
 * itself is the identity claim, there is no separate login step. Same
 * refusal shape as checkBearer; `identity` is only set on success.
 *
 * Every candidate token is compared with the same timing-safe routine as
 * checkBearer, so this doesn't reintroduce a timing side-channel by doing a
 * plain map lookup instead.
 */
export function checkBearerMulti(
  configured: Record<string, string> | undefined,
  presented: string | undefined,
): GuardResult & { identity?: string } {
  const entries = configured ? Object.entries(configured) : [];
  if (entries.length === 0) {
    return { ok: false, error: 'unauthorized: no identities configured for this endpoint' };
  }
  const token = (presented ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token === '') return { ok: false, error: 'unauthorized: missing bearer token' };
  for (const [identity, candidate] of entries) {
    if (timingSafeEqual(token, candidate)) {
      return { ok: true, identity };
    }
  }
  return { ok: false, error: 'unauthorized: bearer token mismatch' };
}

/** Oversized guard: refuse a body beyond the cap before the handler runs. */
export function checkPayloadSize(bytes: number, cap: number = DEFAULT_MAX_BODY_BYTES): GuardResult {
  if (bytes > cap) {
    return { ok: false, error: `oversized: request body ${bytes} bytes exceeds cap ${cap}` };
  }
  return { ok: true };
}
