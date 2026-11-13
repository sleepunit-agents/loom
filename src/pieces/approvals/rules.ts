import { iso, type Rule, type State, type Caller, samePrincipal, stateOf } from './model.js';
import { invalid, repoOf, hostOf, hostVerbs, globMatch, person } from './targets.js';
export interface Project { slug: string; repos: string[] }
const strict: Record<string, number> = { ask: 0, tell: 1, do: 2 };
export function validScope(scope: string, kind = 'merge') {
  if (kind === 'host') {
    const m = /^host:([^:]+)(?::([A-Za-z0-9@._/*-]{1,200}))?$/.exec(scope);
    return !!m && hostVerbs.includes(m[1]) && !scope.split(/[/:]/).includes('..');
  }
  return scope.startsWith('project:') ? /^project:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope) : /^[a-z][a-z0-9-]{0,23}:[\x21-\x22\x24-\x3f\x41-\x7e]{1,120}$/.test(scope);
}
export function makeRule(kind: string, scope: string, tier: string, by: string, now: number, principal?: string): Rule {
  if (!['merge','host'].includes(kind)) invalid('only merge, host has standing rules');
  scope = scope.trim();
  if (kind === 'host') { if (!scope.startsWith('host:')) scope = `host:${scope}`; }
  else if (!scope.startsWith('project:') && scope.includes(':')) { const n = scope.indexOf(':'); scope = scope.slice(0,n+1) + scope.slice(n+1).toLowerCase(); }
  if (!validScope(scope,kind)) invalid('a scope is a repo pattern like github:acme/* or github:acme/app, a project like project:pond, or a host step');
  if (!['do','tell','ask','none'].includes(tier)) invalid('a tier is do (just do it), tell (tell me after) or ask (ask me)');
  if (principal !== undefined && (!person.test(principal) || principal === 'owner' || principal.length > 80 || kind === 'host')) invalid('a grant names a person; host steps are only your own work');
  return { kind, scope, tier: tier === 'none' ? 'ask' : tier, by, at: iso(now), ...(principal !== undefined ? { person: principal } : {}) };
}
export function setRule(s: State, kind: string, scope: string, tier: string, by: string, now: number, principal?: string) {
  const rule = makeRule(kind, scope, tier, by, now, principal);
  const key = principal === undefined ? 'rules' : 'grants';
  const rest = s[key].filter(r => !(r.kind === kind && r.scope === rule.scope && r.person === principal));
  if (tier !== 'none' && rest.length >= 100) invalid('100 rules or grants at most');
  s[key] = tier === 'none' ? rest : [...rest,rule]; return rule;
}
export function resolve(rules: Rule[], kind: string, target: string, projects: Project[] | undefined): { tier: string; scope?: string; note?: string } {
  if (!['merge','host'].includes(kind)) invalid('only merge, host has standing rules');
  const repo = repoOf(target), host = hostOf(target);
  if (kind === 'merge' && !repo) invalid('a merge target is <forge>:<locator>#<n>@<40-hex head>, like github:acme/app#12@…');
  if (kind === 'host' && !host) invalid('a host target is <verb>:<arg>, like restart:loom-http.service');
  const hits: { rank: number; stars: number; rule: Rule }[] = [];
  for (const rule of rules.filter(r => r.kind === kind)) {
    if (kind === 'host') {
      const [,verb,pat] = /^host:([^:]+)(?::(.+))?$/.exec(rule.scope) ?? [];
      if (verb !== host!.verb) continue;
      if (!pat) hits.push({ rank: 3, stars: 0, rule });
      else if (globMatch(pat,host!.arg)) hits.push({ rank: pat.includes('*') ? 2 : 0, stars: pat.split('*').length-1, rule });
    } else if (rule.scope.startsWith('project:')) {
      if (projects?.some(p => p.slug === rule.scope.slice(8) && p.repos.includes(repo!.repo))) hits.push({ rank: 1, stars: 0, rule });
    } else {
      const n = rule.scope.indexOf(':'), forge = rule.scope.slice(0,n), pat = rule.scope.slice(n+1).toLowerCase();
      if (forge === repo!.forge && globMatch(pat,repo!.locator)) hits.push({ rank: pat.includes('*') ? 2 : 0, stars: pat.split('*').length-1, rule });
    }
  }
  if (kind === 'merge' && projects === undefined && rules.some(r => r.kind === kind && r.scope.startsWith('project:')) && !hits.some(h => h.rank === 0)) return { tier: 'ask', note: "the project list couldn't be read, so this asks (a project rule might apply to this repo)" };
  hits.sort((a,b) => a.rank-b.rank || a.stars-b.stars || strict[a.rule.tier]-strict[b.rule.tier]);
  return hits.length ? { tier: hits[0].rule.tier, scope: hits[0].rule.scope } : { tier: kind === 'host' ? 'none' : 'ask' };
}
export function rulesFor(s: State, caller: Caller, kind: string, targets: string[], projects: Project[] | undefined, now: number) {
  if (!targets.length || targets.length > 200) invalid('rule merge TARGET [TARGET…], 200 at most');
  const rules = caller.for === 'owner' ? s.rules : s.grants.filter(g => g.person === caller.for);
  return Object.fromEntries(targets.map(target => {
    let result = resolve(rules,kind,target,projects);
    if (kind === 'host' && caller.for !== 'owner') result = { tier: 'ask', note: "a step on loom's machine is only ever the owner's own work, so this asks" };
    else if (caller.for === '?') result = { tier: 'ask', note: "this body acts for someone loom can't name (no word from the runtime, or several people), so it asks" };
    const mine = s.approvals.filter(a => a.kind === kind && a.target === target && a.who.agent === caller.who.agent && samePrincipal(a,caller)).sort((a,b) => b.at.localeCompare(a.at))[0];
    return [target,{ ...result, for: caller.for, ...(mine ? { approval: { id: mine.id, state: stateOf(mine,now) } } : {}) }];
  }));
}
