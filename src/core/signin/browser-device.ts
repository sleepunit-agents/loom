export const isAgentBrowser = (userAgent: string) => /HeadlessChrome\//.test(userAgent);
/** What a browser is called in Setup, from its own name for itself. */
export function browserDevice(ua: string): string {
  const browser = isAgentBrowser(ua) ? 'HeadlessChrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : undefined;
  return system ? `${browser} on ${system}` : browser;
}

/** Earlier notification subscriptions sometimes saved a raw user-agent as their device label. */
export function deviceLabel(label:string):string{
  return /^(?:Mozilla|HeadlessChrome|Chrome|Firefox|Safari|Edg)\//.test(label)?browserDevice(label):label;
}
