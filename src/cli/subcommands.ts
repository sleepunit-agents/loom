/**
 * Canonical list of loom CLI subcommands. Shared by the CLI dispatcher
 * (src/cli/index.ts) and the CLI-vs-MCP routing gate (src/index.ts) so
 * the set never drifts between entry points.
 */
export const SUBCOMMANDS = [
  'wake', 'recall', 'remember', 'forget', 'update',
  'memory', 'knowledge', 'person', 'update-identity', 'bootstrap', 'serve',
  'inject', 'harness',
  'install', 'doctor', 'migrate', 'pieces', 'household', 'token', 'export', 'restore', 'store',
] as const;

export type Subcommand = typeof SUBCOMMANDS[number];
