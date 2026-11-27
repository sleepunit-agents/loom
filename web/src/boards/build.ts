/** Whether loom now serves a newer build of this page than the one running (docs/specs/boards.md, "A restart").
 * The page's address always answers with the current build's script. If that is not the script this page is
 * running, loom was deployed while the page was open. */
export function newerBuild(html: string, running: readonly string[]): boolean {
  const served = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  return served.length > 0 && running.length > 0 && !served.some((src) => running.includes(src));
}
export async function buildChanged(): Promise<boolean> {
  try {
    const running = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => new URL(s.src).pathname);
    const reply = await fetch('/app/boards', { cache: 'no-store', credentials: 'same-origin' });
    return reply.ok && newerBuild(await reply.text(), running);
  } catch { return false; }
}
