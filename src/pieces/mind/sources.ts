/** Where Memory's files are. The commons paths are declared in program.json; which agents have files is the
 * household's `agents` table and nothing else (`householdMemorySources` in src/shared-memory.ts). Nothing is
 * discovered.
 *
 * `agents` is read each time it is used. In a running household it follows the table, so an agent added in
 * Setup is in it from then on: a reader must not keep a copy of the list. */
export interface AgentSource { agent: string; directory: string; memories: string }
export interface MindSources {
  commons: { directory: string; knowledge: string; people: string };
  agents: AgentSource[];
}

/** What a reader holds open for each agent, by agent id: a Map that looks at the list of agents again
 * whenever it is read, and opens the files of an agent it has not met. Each agent is looked at once, when it
 * is first listed: an agent whose file is not there then (`open` answers nothing) has none until the next
 * start, as before. An agent added while the program runs is listed only once its files are made, so its
 * files are there at that first look. Entries set by hand are left alone. */
export class AgentFiles<Source extends { agent: string }, Opened> extends Map<string, Opened> {
  private ended = false;
  private readonly met = new Set<string>();
  constructor(private readonly list: () => readonly Source[], private readonly open: (source: Source) => Opened | undefined) { super(); }
  /** Bring the map up to the list. Reads do this themselves; a reader calls it once to fail at its own start. */
  follow(): this {
    if (this.ended) return this;
    const listed = new Set<string>();
    for (const source of this.list()) {
      if (listed.has(source.agent)) throw Error('Duplicate Memory source agent');
      listed.add(source.agent);
      if (this.met.has(source.agent) || super.has(source.agent)) continue;
      this.met.add(source.agent);
      const opened = this.open(source);
      if (opened !== undefined) super.set(source.agent, opened);
    }
    return this;
  }
  /** Stop following, hand back everything that is open, and forget it. */
  end(): Opened[] { this.ended = true; const all = [...super.values()]; super.clear(); return all; }
  override get(agent: string) { this.follow(); return super.get(agent); }
  override has(agent: string) { this.follow(); return super.has(agent); }
  override get size() { this.follow(); return super.size; }
  override keys() { this.follow(); return super.keys(); }
  override values() { this.follow(); return super.values(); }
  override entries() { this.follow(); return super.entries(); }
  override forEach(each: (value: Opened, key: string, map: Map<string, Opened>) => void, self?: unknown) { this.follow(); super.forEach(each, self); }
  override [Symbol.iterator]() { this.follow(); return super[Symbol.iterator](); }
}
