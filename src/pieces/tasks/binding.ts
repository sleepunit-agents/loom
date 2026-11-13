import type { Command, Result, StoreState, Task } from './domain.js';
import { apply } from './domain.js';
import { describe as describeFinding, EXAMPLE, lint, PLAIN_RULE, type Finding, type PlainField } from './plain.js';
export function cliBefore(state: StoreState, command: Command, owner = 'jonathan') {
  const check = plainWords({ run: c => apply(state, c).result }, command, owner);
  const rejected: Result | undefined = check.refuse ? {
    ok: false, errors: ['E_NOT_PLAIN'],
    message: `${check.refuse} ${PLAIN_RULE} Say it again in words, like:\n${EXAMPLE}`,
    found: check.findings.map(describeFinding),
  } : undefined;
  return { rejected, warnings: check.warnings, refuse: check.refuse };
}
export function cliAfter(command: Command, result: Result, warnings: string[]): Result {
  if (result.ok === true && warnings.length) result.warnings = warnings;
  if ((command.op === 'link' || command.op === 'unlink') && result.ok === true) {
    const rel = command.type === 'parent-child' ? 'CHILD OF' : 'BLOCKED BY';
    const a = String(command.id), b = String(command.dependsOn);
    result.edge = command.op === 'link'
      ? result.linked === true ? `${a} is now ${rel} ${b}` : `ALREADY LINKED: ${String(command.type)} edge from ${a} to ${b} already exists`
      : result.removed === true ? `${a} is no longer ${rel} ${b}` : `NOTHING REMOVED: no ${String(command.type)} edge from ${a} to ${b} (check the direction and --type)`;
  }
  return result;
}
function plainWords(s: { run(c: Command): Result }, c: Command, owner: string): { refuse?: string; findings: Finding[]; warnings: string[] } {
  const none = { findings: [], warnings: [] };
  if (c.op !== "create" && c.op !== "update") return none;
  const given: Record<string, unknown> = c.op === "create" ? c : ((c.set as Record<string, unknown> | undefined) ?? {});
  const before = c.op === "update" && typeof c.id === "string"
    ? ((s.run({ op: "show", id: c.id }) as { task?: Task }).task)
    : undefined;
  if (c.op === "update" && !before) return none; // the core reports the unknown id
  const after = { ...(before ?? {}), ...given } as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const fields: PlainField[] = ["title", "goal", "why", "doneWhen", "ask", "ifYes", "ifNo"];
  const becomesOwners = after.assignee === owner && before?.assignee !== owner;
  const read: Partial<Record<PlainField, string>> = {};
  for (const f of fields) {
    const v = becomesOwners && (f === "title" || f === "ask") ? str(after[f]) : str(given[f]);
    if (v !== undefined) read[f] = v;
  }
  const findings = lint(read);
  const isOwners = after.assignee === owner;
  const askLeft = !str(after.ask);
  if (isOwners && (findings.length || (askLeft && (becomesOwners || given.ask !== undefined)))) {
    const why = findings.length
      ? `This task is ${owner}'s to read, and ${findings.map(describeFinding).join("; ")}.`
      : `This task is ${owner}'s: give it an --ask (one plain question; --if-yes and --if-no say what happens either way).`;
    return { refuse: why, findings, warnings: [] };
  }
  const warnings = findings.map((f) => `${describeFinding(f)}: it will read as jargon on the task list`);
  const touchesHeadline = c.op === "create" || given.title !== undefined || given.goal !== undefined;
  if (touchesHeadline && !str(after.goal)) warnings.push("needs a plain summary: give it a --goal (what's true when it's done) and a --why");
  if (warnings.length) warnings.push(`the plain form, like:\n${EXAMPLE}`);
  return { findings, warnings };
}

