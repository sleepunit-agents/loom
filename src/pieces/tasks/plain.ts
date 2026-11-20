// Plain words: the lint on what a person reads first (a task's title, its
// goal, the owner's ask), the binding's policy over it_ts-plain's fields. No
// model in the loop: a few patterns, small and tested (test/plain.test.ts),
// the same idea as loom's needs lint (sleepunit-agents/loom#474).
//
// Jonathan, 2026-11-04, on t-1273 ("pond: get the dead S13 MiFi onto a
// bench, or drop this", a description of site codes and dmesg notes): it read
// like a log, not a request. And on the rest: "even stuff you're planning to
// do that I may never get involved in, if I can't understand it from the task
// list, I can't know if we're doing the right thing."
//
// The policy (src/cli.ts): a task that's the owner's is refused until its
// title and ask read plainly and it has an ask; any other task is created or
// updated anyway, with warnings, because agents file tasks mid-lane and a
// refusal there loses the work.

/** The fields the lint reads, by their CLI flag names' core keys. */
export type PlainField = "title" | "goal" | "why" | "doneWhen" | "ask" | "ifYes" | "ifNo";

/** Strict fields are headlines: no ids of any kind. The rest may name a task or a pull request (loom links them). */
const STRICT: ReadonlySet<PlainField> = new Set(["title", "goal", "ask"]);

export const LIMITS: Record<PlainField, number> = {
  title: 120, goal: 200, why: 240, doneWhen: 200, ask: 140, ifYes: 200, ifNo: 200,
};

interface Rule { what: string; re: RegExp; strictOnly?: boolean }

/** Each rule says, in words, what the reader can't read. */
const RULES: readonly Rule[] = [
  { what: "a task id", re: /\bt-\d+\b/g, strictOnly: true },
  { what: "a pull request or issue id", re: /(?<![\w./-])(?:[\w.-]+\/)?[\w.-]+#\d+\b/g, strictOnly: true },
  { what: "an internal id", re: /\b(?:a-[0-9a-f]{8}|cv-[0-9a-f]{6,}|dg-[0-9a-f]{6,}|w-[0-9a-f]{6,}|r-\d{3,}|h-\d+)\b/gi },
  // A bare hex id (a commit, a device): six or more hex digits with at least one digit and one letter.
  { what: "a hex id", re: /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,40}\b/gi },
  { what: "a round number", re: /\bround\s+\d+\b/gi },
  // Lane and wake jargon, the words themselves: not "lane" alone, which is plain English and a music word too
  // (Phasecraft's pitch lane), and is what a task about Art's lanes is about.
  { what: "a lane or wake word", re: /\b(?:nudge[- ]watch|chain[- ]check|local[- ]wake|plan[- ]night|wake (?:in|at|park|relay|list))\b/gi },
  // A unit or site code (S13, A007): what someone on site calls it, not its row in a sheet.
  { what: "a raw site or unit code", re: /\b[A-Z]{1,2}\d{2,4}\b/g },
];

/** A leading "pond:" or "loom-ui:" is a filing tag, not words: say what it's about in the sentence. */
const TAG = /^([\w.-]+):\s/;

export interface Finding { field: PlainField; what: string; text: string }

/** What in `value` (the field `field`) a person can't read: each thing found, as written. */
export function lintField(field: PlainField, value: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const add = (what: string, text: string) => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ field, what, text });
  };
  const strict = STRICT.has(field);
  if (strict) {
    const tag = TAG.exec(value);
    if (tag) add("a leading tag", `${tag[1]}:`);
  }
  for (const r of RULES) {
    if (r.strictOnly && !strict) continue;
    for (const m of value.matchAll(r.re)) add(r.what, m[0]);
  }
  if (value.length > LIMITS[field]) add(`over ${LIMITS[field]} characters`, `${value.length} characters`);
  if (/[\r\n]/.test(value)) add("more than one line", "a line break");
  return out;
}

/** Every field given, linted, in a stable order. Blank values (an update clearing a field) aren't read. */
export function lint(fields: Partial<Record<PlainField, string>>): Finding[] {
  const order: PlainField[] = ["title", "goal", "why", "doneWhen", "ask", "ifYes", "ifNo"];
  return order.flatMap((f) => (typeof fields[f] === "string" && fields[f]!.trim() ? lintField(f, fields[f]!) : []));
}

const FLAG: Record<PlainField, string> = {
  title: "--title", goal: "--goal", why: "--why", doneWhen: "--done-when", ask: "--ask", ifYes: "--if-yes", ifNo: "--if-no",
};

/** "--title can't name "S13" (a raw site or unit code)". */
export function describe(f: Finding): string {
  return `${FLAG[f.field]} can't have ${JSON.stringify(f.text)} (${f.what})`;
}

/** The plain form, as an agent would type it: shown with every refusal and warning, so it retries in words. */
export const EXAMPLE = [
  'taskstore update <id> --assignee jonathan',
  '  --title "Find out why the field Pis drop off the network, using the failed Station 13 hotspot"',
  '  --goal "We know what makes a field Pi lose its connection, from a failing unit on a bench."',
  '  --why "The same failure hit two sites, and we have never caught it on hardware we can test."',
  '  --ask "Can you get the old Station 13 hotspot and a spare Pi onto a bench I can reach?"',
  '  --if-yes "I run the checks against a good hotspot and report what is actually wrong."',
  '  --if-no "I close this and fold it into the LTE hats question."',
].join(" \\\n");

export const PLAIN_RULE =
  "A task's title, goal and ask are what a person reads first, so they say in plain words what's being done or "
  + "asked: no ids (put those in the description), no lane or wake words, no round numbers, no site codes, no leading tag.";
