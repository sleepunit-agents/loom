/** Refresh has no durable answer intent and sends no actor or source facts. */
export async function refreshChanges(request: typeof fetch = fetch): Promise<void> {
  try {
    const response = await request('/api/changes/refresh',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({input:{}})});
    const result:unknown = await response.json();
    if (response.ok && result && typeof result === 'object' && 'ok' in result && result.ok === true
      && 'value' in result && result.value && typeof result.value === 'object' && 'refreshed' in result.value && result.value.refreshed === true) return;
  } catch { /* One explicit click makes one request; no automatic retries. */ }
  throw new Error('Could not refresh Changes.');
}
