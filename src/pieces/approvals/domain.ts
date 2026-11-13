import { randomBytes } from 'node:crypto';
import { OperationError } from '../../core/index.js';
import { type State, type Approval, type Caller, type Standing, iso, stateOf, maySpend, samePrincipal, forOf, pieceKinds, pieceSpent, serviceOf } from './model.js';
import { invalid, denied, exactTarget, repoOf, hostOf, vouchOf, resetOf, writeoffOf, covered, standingTarget } from './targets.js';
import { plain, checkPlain, principalWords } from './words.js';
import { rulesFor, setRule, type Project } from './rules.js';
export interface DomainContext { caller: Caller; now: number; piece?: boolean; localAgent: string; projects?: Project[]; id?: () => string; canRead?: (approval:Approval)=>boolean }
export function find(s: State, id: string): Approval { const a = s.approvals.find(a => a.id === id); if (!a) throw new OperationError('not-found', `no approval ${id}`); return a; }
export function log(s: State, event: string, a: { id: string; kind: string; target: string; who: unknown }, now: number, extra = {}) { s.audit.push({ at: iso(now), event, id: a.id, kind: a.kind, target: a.target, who: a.who, ...extra }); }
const newest = (s: State, a: Approval) => s.approvals.filter(b => b.kind === a.kind && b.target === a.target && b.who.agent === a.who.agent && b.decided).sort((a,b) => b.decided!.localeCompare(a.decided!))[0];
function denySiblings(s: State, a: Approval, now: number, by: string) {
  for (const b of s.approvals) if (b.member === a.member && b.id !== a.id && b.kind === a.kind && b.target === a.target && b.who.agent === a.who.agent && (stateOf(b,now) === 'allowed' || stateOf(b,now) === 'pending' && !b.conversation)) {
    Object.assign(b,{ state: 'denied', decided: iso(now), superseded_by: a.id, by }); delete b.expires; log(s,'deny-superseded',b,now,{ by_deny: a.id });
  }
}
export function request(s: State, input: Record<string,unknown>, c: DomainContext) {
  const str = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';
  const kind = str('kind'), target = exactTarget(str('target')), { caller, now } = c;
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(kind)) invalid('--kind is the wall it hit, like github-write or relay');
  if (pieceKinds.has(kind) && !c.piece) denied(`a ${kind} approval is filed by the piece for its body, not by a body`);
  if (kind === 'merge' && !repoOf(target)) invalid('a merge target is literal: <forge>:<owner>/<repo>#<n>@<40-hex head>, letters, digits, . _ - only');
  if (kind === 'host' && !hostOf(target)) invalid('a host target is <verb>:<arg>, like restart:loom-http.service');
  if (kind === 'host' && caller.for !== 'owner') denied("a step on loom's machine is only ever the owner's own work");
  if (kind === 'merge' || kind === 'host') {
    const tier = rulesFor(s,caller,kind,[target],c.projects,now)[target].tier;
    if (tier === 'do' || tier === 'tell') denied(`the standing rule for this merge is ${tier}: merge it at this exact head${tier === 'tell' ? ', then approvals tell' : ''}; no card was filed`);
  }
  if (kind === 'grant') invalid('no longer applies: agent access follows record scope');
  const own = kind === 'vouch-wake' ? vouchOf(target) : kind === 'principal-reset' ? resetOf(target) : kind === 'box-write-off' ? writeoffOf(target) : undefined;
  if (['vouch-wake','principal-reset','box-write-off'].includes(kind)) {
    if (!own) invalid(`invalid ${kind} target`);
    if (own!.agent !== caller.who.agent) denied(`a ${kind} approval names the agent it's filed for (${caller.who.agent})`);
    if (caller.for !== 'owner') invalid(`a ${kind} approval is filed on behalf of owner`);
    if (!str('details').trim() || !str('ask')) invalid(`a ${kind} card lists what it covers (--details, with --ask)`);
    if (kind === 'vouch-wake' && !vouchOf(target)!.ids.every(id => str('details').split('\n').some(line => line.includes(id) && line.includes('fires')))) invalid("a vouch-wake card's --details lists every wake on it: a line each, with its id and when it fires");
    if (kind === 'principal-reset' && !str('details').includes(resetOf(target)!.conversation)) invalid("a principal-reset card's --details names the conversation: its label and its id");
    if (kind === 'box-write-off' && !str('details').includes(writeoffOf(target)!.box)) invalid("a box-write-off card's --details names the box: its id and when it was last heard");
  }
  const digest = str('digest');
  if (digest && (kind !== 'local-wake' || !c.piece || !/^[0-9a-f]{64}$/.test(digest) || target.split(':')[1] !== digest.slice(0,16))) invalid("--digest is the clock's: a local wake's whole sha256, of which its target is the first 16 hex");
  let what = plain(str('what')), why = plain(str('why'));
  if (what.length > 300 || why.length > 300) invalid('--what and --why are 300 characters at most as shown on the card; say it shorter');
  const words: Record<string,string> = {};
  if (str('ask')) {
    for (const key of ['ask','why','if_yes','if_no']) words[key] = str(key).normalize('NFKC').trim();
    checkPlain(words);
    for (const key of Object.keys(words)) words[key] = plain(words[key]);
    if (Object.values(words).some(v => !v)) invalid('with --ask, say --why, --if-yes and --if-no too, in words: the owner reads what happens either way beside Allow and Deny');
    what ||= words.ask; why = words.why;
    if (str('details')) {
      const d = str('details').normalize('NFKC').replace(/\r/g,'');
      if (d.length > 1000) invalid('--details is 1000 characters at most');
      words.details = d.replace(/[^\P{C}\n]/gu,'').trim();
    }
  }
  if (!what || !why) invalid('say exactly what (--target), the plain question (--ask, with --why, --if-yes and --if-no) and why: the owner reads them to decide');
  const conv = str('conversation');
  if (conv && !/^cv-[0-9a-f]{12}$/.test(conv)) invalid('--conversation is a conversation id, cv- and 12 hex');
  const conversation = conv === caller.conversation || c.piece ? conv || undefined : undefined;
  if (kind === 'vouch-wake' || kind === 'principal-reset') {
    for (const a of s.approvals) {
      if (a.kind !== kind || a.who.agent !== caller.who.agent || a.target === target && ['pending','allowed'].includes(stateOf(a,now))) continue;
      const both = covered(a).filter(id => covered({kind,target}).includes(id));
      if (!both.length) continue;
      if (c.canRead && !c.canRead(a)) denied('An existing decision prevents this request');
      if (a.state === 'denied') denied(`the owner said no for ${both.join(' ')} already (${a.id}): not asked again`);
      if (['pending','allowed'].includes(stateOf(a,now))) denied(`${a.id} already covers ${both.join(' ')}: withdraw or apply it first`);
    }
  }
  // A typed wake decision cannot be reused after its target moves scope.
  if (kind === 'vouch-wake' && s.approvals.some(a => a.kind === kind && a.target === target
    && a.who.agent === caller.who.agent && ['pending','allowed'].includes(stateOf(a,now))
    && (a.project !== caller.project || a.member !== undefined)))
    denied('An existing decision prevents this request');
  for (const a of s.approvals) if ((!c.canRead || c.canRead(a)) && a.kind === kind && a.target === target && maySpend(a.who,caller.who) && samePrincipal(a,caller) && ['pending','allowed'].includes(stateOf(a,now))) {
    const last = newest(s,a);
    if (stateOf(a,now) === 'allowed' && last?.state === 'denied' && last.decided! > (a.decided ?? '')) continue;
    // Clock's exact local words cannot be attached to a different old card,
    // including a legacy card that request() would otherwise enrich in place.
    if (kind === 'local-wake' && digest && (a.digest !== digest || a.details !== words.details || a.project !== caller.project))
      denied('An existing local decision covers different words or scope');
    if (stateOf(a,now) === 'pending') {
      if (words.ask && !a.ask && JSON.stringify(a.who) === JSON.stringify(caller.who)) Object.assign(a,words,{ why });
      if (conversation && !a.conversation) a.conversation = conversation;
    }
    return a;
  }
  const granted = s.approvals.filter(a => (!c.canRead || c.canRead(a)) && a.granted && a.kind === kind && a.target === target && a.who.agent === caller.who.agent && samePrincipal(a,caller) && ['allowed','denied'].includes(stateOf(a,now))).sort((a,b) => b.at.localeCompare(a.at))[0];
  if (granted) return { ...granted,state: stateOf(granted,now) };
  const a: Approval = { id: `a-${c.id?.() ?? randomBytes(4).toString('hex')}`, kind,target,what,why,who: caller.who, for: caller.for, ...(caller.people?.length ? { people: caller.people } : {}), ...(conversation ? { conversation } : {}), ...(digest ? { digest } : {}), ...words, minutes: Math.max(1,Math.min(Number(input.minutes) || 60,480)), at: iso(now),state: 'pending',agent: caller.who.agent, ...(caller.project ? { project: caller.project } : {}) };
  s.approvals.push(a); log(s,'request',a,now,{what,why}); return a;
}
export function use(s: State, id: string, kind: string, target: string, c: DomainContext) {
  if (kind === 'grant') denied('no longer applies: agent access follows record scope');
  if (pieceSpent.has(kind) && !c.piece) denied(`a ${kind} approval is spent by the piece that runs it, not by a body`);
  exactTarget(target);
  const a = find(s,id), { caller, now } = c;
  if (!maySpend(a.who,caller.who)) denied(`${id} isn't ${caller.who.agent}'s to spend from here`);
  const state = stateOf(a,now);
  if (state !== 'allowed') denied(`${id} is ${state}${state === 'pending' ? ', waiting on the owner' : ''}`);
  if (a.kind !== kind || a.target !== target) denied(`${id} allows ${a.kind} for ${a.target}, not ${kind} for ${target}`);
  if (!(c.piece && kind === 'grant') && !samePrincipal(a,caller)) denied(`${id} was asked for ${principalWords(a)}; this body acts for ${principalWords(caller,'you')}`);
  const last = newest(s,a);
  if (last?.id !== id && last?.state === 'denied' && last.decided! > (a.decided ?? '')) { if(c.canRead && !c.canRead(last)) denied('A later decision prevents this spend'); denied(`${id} was overruled: the owner said no to ${target} after (${last.id})`); }
  const no = s.approvals.find(b => b.id !== id && b.kind === kind && b.state === 'denied' && b.who.agent === a.who.agent && (b.decided ?? '') > (a.decided ?? '') && covered(b).some(id => covered(a).includes(id)));
  if (no) { if(c.canRead && !c.canRead(no)) denied('A later decision prevents this spend'); denied(`${id} was overruled: the owner said no to some of it after (${no.id})`); }
  a.state = 'used'; a.used = iso(now); log(s,'use',a,now); return a;
}
export function answer(s: State, id: string, action: string, by: string, now: number, minutes?: number) {
  const a = find(s,id); if (a.kind === 'grant') denied('no longer applies: agent access follows record scope');
  if (stateOf(a,now) !== 'pending') denied(`it's already ${stateOf(a,now)}`);
  if (!['allow','deny'].includes(action)) invalid('answer is allow or deny');
  Object.assign(a,{state: action === 'allow' ? 'allowed' : 'denied',decided: iso(now),by});
  if (action === 'allow') a.expires = iso(now + (minutes ?? a.minutes) * 60_000);
  else denySiblings(s,a,now,by);
  log(s,action,a,now); return a;
}
export function withdraw(s: State, id: string, c: DomainContext) {
  const a = find(s,id), { caller,now } = c;
  if (c.piece ? !pieceKinds.has(a.kind) || a.who.agent !== caller.who.agent : pieceKinds.has(a.kind) || !maySpend(a.who,caller.who) || !(samePrincipal(a,caller) || caller.for === 'owner' && forOf(a) === '?')) denied(`${id} isn't one this body may take back`);
  if (stateOf(a,now) !== 'pending') denied(`${id} is ${stateOf(a,now)}: an answer stands`);
  a.state = 'withdrawn'; a.withdrawn = iso(now); log(s,'withdraw',a,now); return a;
}
export function grant(s: State, kind: string, target: string, agent: string, by: string, deny: boolean, principal: string, now: number) {
  if (kind !== 'merge' || !repoOf(target)) invalid('grant is for a merge approval: --kind merge --target <forge>:<locator>#<n>@<head>');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(agent)) invalid('--for is the agent whose change it is');
  const pending = s.approvals.filter(a => a.kind === kind && a.target === target && a.who.agent === agent && forOf(a) === principal && stateOf(a,now) === 'pending' && !a.conversation && !a.member).sort((a,b) => b.at.localeCompare(a.at))[0];
  if (pending) return answer(s,pending.id,deny ? 'deny' : 'allow',by,now,1440);
  const a: Approval = { id: `a-${randomBytes(4).toString('hex')}`,kind,target,what: `merge ${target.split('@')[0]}`,why: `the owner said ${deny ? 'not yet' : 'yes, merge it'}`,who: { agent,where: 'any' },agent,for: principal,granted: true,minutes: 1440,at: iso(now),state: deny ? 'denied' : 'allowed',decided: iso(now),by,...(!deny ? { expires: iso(now+86400_000) } : {}) };
  if (deny) denySiblings(s,a,now,by); s.approvals.push(a); log(s,deny ? 'grant-deny' : 'grant',a,now); return a;
}
export function everyTimeOk(a: Approval, c: DomainContext) {
  return a.kind === 'local-wake' && stateOf(a,c.now) === 'pending' && standingTarget.exec(a.target)?.[1] === a.who.agent && a.who.agent === c.localAgent && /^[0-9a-f]{64}$/.test(a.digest ?? '') && (forOf(a) === 'owner' || forOf(a) === '?' && !a.people?.length && serviceOf(a.who) === undefined);
}
export function allowEveryTime(s: State, id: string, by: string, c: DomainContext) {
  const a = find(s,id); if (!everyTimeOk(a,c)) invalid("Allow every time is for a job on loom's machine, for you or for someone loom can't name");
  let same = s.standing.find(j => !j.off && j.agent === a.who.agent && j.digest === a.digest && JSON.stringify(j.who) === JSON.stringify(a.who) && samePrincipal(j,a));
  if (!same) {
    const on = s.standing.filter(j => !j.off); if (on.length >= 50) invalid('50 standing jobs at most: turn one off first');
    same = { id: `s-${randomBytes(4).toString('hex')}`,kind: 'local-wake',agent: a.who.agent,target: a.target,digest: a.digest!,who: a.who,for: forOf(a),...(a.people ? { people: a.people } : {}),from: id,what: a.what,...(a.details ? { details: a.details } : {}),at: iso(c.now),uses: 0,by };
    s.standing = [...on,same,...s.standing.filter(j => j.off).slice(0,100-on.length-1)];
  }
  answer(s,id,'allow',by,c.now); return same;
}
export function standingMatch(s: State, kind: string, target: string, digest: string, c: DomainContext): Standing | undefined {
  if (!c.piece) denied('standing is for the clock, acting for a body');
  exactTarget(target); if (kind !== 'local-wake' || !/^[0-9a-f]{64}$/.test(digest)) return;
  const j = s.standing.find(j => !j.off && j.agent === c.caller.who.agent && j.target === target && j.digest === digest && maySpend(j.who,c.caller.who) && samePrincipal(j,c.caller));
  if (j) { j.uses++; j.used = iso(c.now); log(s,'standing-use',j,c.now,{asked_from: c.caller.who}); } return j;
}
export function alwaysScope(a: Approval, projects?: Project[]) {
  const repo=repoOf(a.target);
  if(a.kind!=='merge'||!repo||forOf(a)==='?') return;
  const project=projects?.find(p=>p.repos.includes(repo.repo));
  return project?`project:${project.slug}`:repo.repo;
}
export function always(s: State, id: string, by: string, c: DomainContext, expectedScope?:string) {
  const a = find(s,id), repo = repoOf(a.target);
  if (a.kind !== 'merge' || !repo || forOf(a) === '?') invalid('Always is for a merge of one repo, for you or for one person');
  const scope = alwaysScope(a,c.projects)!;
  if(expectedScope!==undefined&&expectedScope!==scope) throw new OperationError('conflict','The standing scope changed; open this question again');
  const r = setRule(s,'merge',scope,'do',by,c.now,forOf(a) === 'owner' ? undefined : forOf(a));
  answer(s,id,'allow',by,c.now); return r;
}
export function recordNotice(s: State, input: Record<string,unknown>, c: DomainContext) {
  if (input.kind === 'host' && !c.piece) denied("a host step's notice is the runtime's");
  const target = String(input.target), kind = String(input.kind);
  const rule = rulesFor(s,c.caller,kind,[target],c.projects,c.now)[target];
  if (!['do','tell'].includes(rule.tier)) denied(`the rule for ${target.split('@')[0]} is ask me: request a merge approval instead`);
  const what = plain(String(input.what ?? ''));
  if (!what || what.length > 300) invalid('--what says what was merged, at most 300 characters');
  const notice = { at:iso(c.now), agent:c.caller.who.agent, kind, target, what, ...(c.caller.for !== 'owner' ? {for:c.caller.for} : {}) };
  s.notices.unshift(notice);
  s.notices = s.notices.slice(0,50);
  return notice;
}
