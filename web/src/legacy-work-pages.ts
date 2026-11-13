// The unmoved Changes and Projects pages still consume shared work pulses.
const CHANGES = /^\/(?:a\/[a-z][a-z0-9-]{0,39}\/)?p\/changes(?:\/[^?#]*)?(?:[?#]|$)/;
const PROJECTS = /^\/projects(?:\/[^?#]*)?(?:[?#]|$)/;
export function tasksPageKind(url: string): 'also' | null { return CHANGES.test(url) || PROJECTS.test(url) ? 'also' : null; }
export function pulseOf(url: string): string { return CHANGES.test(url) ? 'changes' : PROJECTS.test(url) ? 'tasks,changes' : ''; }
