/** Where Memory's files are. Startup builds this from what program.json declares (src/shared-startup.ts);
 * nothing is discovered. */
export interface MindSources {
  commons: { directory: string; knowledge: string; people: string };
  agents: Array<{ agent: string; directory: string; memories: string }>;
}
