import type { Measuring } from './index.js';
interface ResponseLifetime {
  once(event: 'finish' | 'close', listener: () => void): unknown;
  off(event: 'finish' | 'close', listener: () => void): unknown;
}
/** Classify only enabled requests; end at the actual transport boundary. */
export function measureResponse(meter: (Pick<Measuring, 'runAsync'> & { enabled(): boolean }) | undefined,
  request: { url?: string }, response: ResponseLifetime, dispatch: () => void): Promise<void> | undefined {
  if (!meter?.enabled()) { dispatch(); return; }
  const path = (request.url ?? '/').split('?')[0];
  const name = path === '/graphql' ? 'graphql' : path === '/mcp' ? 'mcp' : path.startsWith('/api/') ? 'api' : 'web';
  return meter.runAsync('request', name, () => new Promise<void>((resolve, reject) => {
    const clean = () => { response.off('finish', finished); response.off('close', finished); };
    const finished = () => { clean(); resolve(); };
    response.once('finish', finished); response.once('close', finished);
    try { dispatch(); } catch (error) { clean(); reject(error); }
  }));
}
