// Frozen legacy CLI binding, taskstore 3736e1c72bee3cbd3e65c65768996476bc5c4a7a.
// Extracted without command/process/store startup so parity runs in-process.
import { readFileSync } from 'node:fs';
import { apply, emptyState, type Command, type Result, type StoreState, type Task } from './domain.js';
import { describe as describeFinding, EXAMPLE, lint, PLAIN_RULE, type Finding, type PlainField } from './plain.js';
export function legacyFixture() {
 let state: StoreState = emptyState();
 const store = { run(c: Command): Result { const next = apply(state,c); state = next.state; return next.result; } };
 return (args: string[], at: string, env: NodeJS.ProcessEnv = {}) => {
 let stdout = '', stderr = '';
 const console = { error: (s: string) => { stderr += s + '\n'; }, log: (s: string) => { stdout += s + '\n'; } };
 const process: { env: NodeJS.ProcessEnv; exit(n: number): never } = { env, exit(n: number): never { throw { status: n }; } };
 const writeAll = (s: string) => { stdout += s; };
 const argv = [...args]; const verb = argv.shift();
 const positional: string[] = []; const flags: Record<string,string> = Object.create(null);
 for(let i=0;i<argv.length;i++) { const a=argv[i]; if(a.startsWith('--')) flags[a.slice(2)]=argv[++i] ?? ''; else positional.push(a); }
 const actor = env.TASKSTORE_ACTOR ?? 'art';
const PLAIN_FLAGS: Record<string, string> = {
  goal: "goal", why: "why", "done-when": "doneWhen", ask: "ask", "if-yes": "ifYes", "if-no": "ifNo", answers: "answers",
};
const KNOWN_FLAGS: Record<string, Set<string>> = {
  create: new Set(["description", "type", "priority", "parent", "spec-item-ref", "criterion-id", "legacy-ref", "source", ...Object.keys(PLAIN_FLAGS)]),
  claim: new Set(),
  unclaim: new Set(),
  close: new Set(["reason"]),
  reopen: new Set(),
  delete: new Set(),
  update: new Set(["title", "description", "assignee", "priority", "source", ...Object.keys(PLAIN_FLAGS)]),
  comment: new Set(["file"]),
  link: new Set(["type"]),
  unlink: new Set(["type"]),
  show: new Set(),
  list: new Set(["status"]),
  search: new Set(["status"]),
  ready: new Set(),
  report: new Set(),
  export: new Set(),
  import: new Set(),
};

function checkKnownFlags(): void {
  // Object.hasOwn, not a bare KNOWN_FLAGS[verb]: a caller-controlled verb
  // string can name an inherited Object.prototype member (toString,
  // constructor, valueOf, hasOwnProperty, ...). Without this check `taskstore
  // toString --x y` binds `allowed` to that inherited function, `allowed.has`
  // throws an uncaught TypeError, and the command exits 1 with a stack trace
  // instead of the switch default's clean "unknown verb" / exit 2.
  const allowed = verb !== undefined && Object.hasOwn(KNOWN_FLAGS, verb) ? KNOWN_FLAGS[verb] : undefined;
  if (!allowed) return; // unknown verb: the switch's default case owns this error
  const unknown = Object.keys(flags).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    const plural = unknown.length > 1 ? "s" : "";
    console.error(`unknown flag${plural} for '${verb}': ${unknown.map((k) => `--${k}`).join(", ")}`);
    process.exit(2);
  }
}

function envSource(): string | undefined {
  const cv = process.env.LOOM_BODY_CONVERSATION?.trim();
  return cv && /^cv-[0-9a-f]{12}$/.test(cv) ? `conversation:${cv}` : undefined;
}

function buildCommand(): Command {
  switch (verb) {
    case "create": {
      const c: Command = { op: "create", title: positional[0], actor, at };
      if (flags.description !== undefined) c.description = flags.description;
      if (flags.type !== undefined) c.type = flags.type;
      if (flags.priority !== undefined) c.priority = Number(flags.priority);
      if (flags.parent !== undefined) c.parent = flags.parent;
      if (flags["spec-item-ref"] !== undefined) c.specItemRef = flags["spec-item-ref"];
      if (flags["criterion-id"] !== undefined) c.criterionId = flags["criterion-id"];
      if (flags["legacy-ref"] !== undefined) c.legacyRef = flags["legacy-ref"];
      const source = flags.source ?? envSource();
      if (source !== undefined) c.source = source;
      for (const [flag, key] of Object.entries(PLAIN_FLAGS)) if (flags[flag] !== undefined) c[key] = flags[flag];
      return c;
    }
    case "claim":
      return { op: "claim", id: positional[0], actor, at };
    case "unclaim":
      return { op: "unclaim", id: positional[0], actor, at };
    case "close": {
      const c: Command = { op: "close", id: positional[0], actor, at };
      if (flags.reason !== undefined) c.reason = flags.reason;
      return c;
    }
    case "reopen":
      return { op: "reopen", id: positional[0], actor, at };
    case "delete":
      return { op: "delete", id: positional[0], actor, at };
    case "update": {
      const set: Record<string, unknown> = {};
      for (const k of ["title", "description", "assignee"]) if (flags[k] !== undefined) set[k] = flags[k];
      if (flags.priority !== undefined) set.priority = Number(flags.priority);
      for (const [flag, key] of Object.entries(PLAIN_FLAGS)) if (flags[flag] !== undefined) set[key] = flags[flag];
      if (flags.source !== undefined) set.source = flags.source;
      return { op: "update", id: positional[0], set, actor, at };
    }
    case "comment": {
      // --file <path>, or --file - for stdin: the text as it is, no shell quoting.
      // Not both: a text and a file would leave which one landed to a guess.
      if (flags.file !== undefined) {
        if (positional[1] !== undefined) {
          console.error("taskstore: comment takes its text inline or from --file, not both");
          process.exit(2);
        }
        if (flags.file === "") {
          console.error("taskstore: --file needs a path (or - for stdin)");
          process.exit(2);
        }
        // A rejection answers like every other one: JSON on stdout (ok: false), exit 1.
        const reject = (code: string, message: string): never => {
          console.error(`taskstore: ${message}`);
          writeAll(JSON.stringify({ ok: false, errors: [code], message }, null, 2) + "\n");
          process.exit(1);
        };
        let text = "";
        try {
          text = readFileSync(flags.file === "-" ? 0 : flags.file, "utf8");
        } catch (err) {
          reject("E_FILE", `can't read --file ${flags.file}: ${(err as Error).message}`);
        }
        // One trailing newline is the file's (a heredoc, an editor), not the comment's: "\n", or "\r\n" from a
        // CRLF file. Anything else is kept as written.
        text = text.replace(/\r?\n$/, "");
        // An empty file is most likely a redirect that produced nothing, not a comment anyone meant.
        if (text.trim() === "") reject("E_EMPTY", `--file ${flags.file} has no text`);
        return { op: "comment", id: positional[0], text, actor, at };
      }
      return { op: "comment", id: positional[0], text: positional[1], actor, at };
    }
    // --type is passed through ABSENT when absent. It used to default to
    // "blocks", which meant a missing flag silently built the edge that gates
    // the ready queue; the core has always required the field (E_MISSING_FIELD)
    // and the binding was overriding that refusal with the destructive choice.
    case "link":
      return { op: "link", id: positional[0], dependsOn: positional[1], type: flags.type, actor, at };
    case "unlink":
      return { op: "unlink", id: positional[0], dependsOn: positional[1], type: flags.type, actor, at };
    case "show":
      return { op: "show", id: positional[0] };
    case "list": {
      const c: Command = { op: "list" };
      if (flags.status !== undefined) c.status = flags.status;
      return c;
    }
    case "search": {
      const c: Command = { op: "search", q: positional[0] };
      if (flags.status !== undefined) c.status = flags.status;
      return c;
    }
    case "ready":
      return { op: "ready" };
    case "report":
      return { op: "report" };
    case "export":
      return { op: "export" };
    case "import": {
      const payload = JSON.parse(readFileSync(positional[0], "utf8")) as Record<string, unknown>;
      return { op: "import", tasks: payload.tasks, links: payload.links, actor, at };
    }
    default:
      console.error(
        "usage: taskstore <create|claim|unclaim|close|reopen|delete|update|comment|link|unlink|show|list|search|ready|report|export|import> ...",
      );
      // This exit() stays, unlike the one at the end of the file. It is the
      // only way out of a branch that owes the caller a Command and has none
      // — setting process.exitCode here would fall through and run the whole
      // command path on `undefined`. It is also safe on the grounds the other
      // one was not: nothing has been written to stdout yet, and the single
      // short line above fits any pipe buffer, so there is no queued write to
      // discard.
      process.exit(2);
  }
}
function plainWords(s: { run(c: Command): Result }, c: Command): { refuse?: string; findings: Finding[]; warnings: string[] } {
  const none = { findings: [], warnings: [] };
  if (c.op !== "create" && c.op !== "update") return none;
  const owner = process.env.TASKSTORE_OWNER?.trim() || "jonathan";
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


 try {
 checkKnownFlags(); const command = buildCommand();
const plainCheck = plainWords(store, command);
let result: Record<string, unknown>;
if (plainCheck.refuse) {
  result = {
    ok: false, errors: ["E_NOT_PLAIN"],
    message: `${plainCheck.refuse} ${PLAIN_RULE} Say it again in words, like:\n${EXAMPLE}`,
    found: plainCheck.findings.map(describeFinding),
  };
  console.error(`taskstore: refused: ${plainCheck.refuse}`);
} else {
  try {
    result = store.run(command);
  } catch (err) {
    // The store couldn't apply it: the write lock didn't come in time
    // (SQLITE_BUSY), the disk is full, the mirror couldn't be written. The
    // write rolled back, so this is a failure, said as one — never an ok.
    const e = err as { code?: unknown; message?: unknown };
    result = { ok: false, errors: ["E_STORE"], message: `the store couldn't apply this ${command.op}: ${String(e.message ?? err)}`, ...(typeof e.code === "string" ? { code: e.code } : {}) };
    console.error(`taskstore: ${result.message}`);
  }
  if (result.ok === true && plainCheck.warnings.length) {
    result.warnings = plainCheck.warnings;
    for (const w of plainCheck.warnings) console.error(`taskstore: warning: ${w}`);
  }
}
if ((command.op === "link" || command.op === "unlink") && result.ok === true) {
  const rel = command.type === "parent-child" ? "CHILD OF" : "BLOCKED BY";
  const a = String(command.id);
  const b = String(command.dependsOn);
  // A miss must not read as reassurance. The same removed:false covers a
  // reversed pair, the wrong --type, an edge that never existed and a plain
  // repeat, and only the last is benign — so the line names what did NOT
  // happen and points at the two ways to have got here wrong, rather than
  // stating a fact about the store that sounds like the requested outcome.
  result.edge =
    command.op === "link"
      ? result.linked === true
        ? `${a} is now ${rel} ${b}`
        : `ALREADY LINKED: ${String(command.type)} edge from ${a} to ${b} already exists`
      : result.removed === true
        ? `${a} is no longer ${rel} ${b}`
        : `NOTHING REMOVED: no ${String(command.type)} edge from ${a} to ${b} (check the direction and --type)`;
}


 console.log(JSON.stringify(result, null, 2));
 const status = result.ok !== true ? 1 : (command.op === 'unlink' && result.removed !== true) || (command.op === 'link' && result.linked !== true) ? 3 : 0;
 return { stdout, stderr, status };
 } catch(e) { return { stdout, stderr, status: (e as {status:number}).status ?? 1 }; }
 };
}
