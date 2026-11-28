/** Why a Refresh did not happen: `status` is the door's HTTP status, or null where no answer came. Loom's own
 * refusal (403: the member may not refresh) is told apart from a failure by it. */
export class RefreshError extends Error {
  readonly status: number | null;
  constructor(status: number | null) { super('Could not refresh Changes.'); this.status = status; }
}
/** Refresh has no durable answer intent and sends no actor or source facts. */
export async function refreshChanges(request: typeof fetch = fetch): Promise<void> {
  let status: number | null = null;
  try {
    const response = await request('/api/changes/refresh',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({input:{}})});
    status = response.status;
    const result:unknown = await response.json();
    if (response.ok && result && typeof result === 'object' && 'ok' in result && result.ok === true
      && 'value' in result && result.value && typeof result.value === 'object' && 'refreshed' in result.value && result.value.refreshed === true) return;
  } catch { /* One explicit click makes one request; no automatic retries. */ }
  throw new RefreshError(status);
}
