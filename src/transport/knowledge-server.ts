/**
 * Knowledge-only MCP server factory (t-677) — the scoped half of the
 * knowledge/memory split. Registers ONLY the knowledge_* tools (via the
 * same registerKnowledgeTools() the full loom server uses — see
 * knowledge-tools.ts for why that sharing matters), with no identity,
 * dossier, remember/recall, or any other memory-wing tool on the surface.
 *
 * This is what lets a second identity (e.g. Mark) read/write Art's
 * knowledge store over the mesh without ever being handed memory tools:
 * the MCP tool list itself is smaller, not just access-controlled.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveRepoRoot } from '../config.js';
import { registerKnowledgeTools } from './knowledge-tools.js';

export interface KnowledgeServerConfig {
  contextDir: string;
  gapsDir?: string;
  /** The identity this connection is serving — resolved from its bearer token. */
  identity: string;
}

export interface KnowledgeServerInstance {
  server: McpServer;
}

export function createKnowledgeOnlyServer(config: KnowledgeServerConfig): KnowledgeServerInstance {
  const { contextDir, gapsDir, identity } = config;

  const pkg = JSON.parse(readFileSync(join(resolveRepoRoot(), 'package.json'), 'utf-8')) as { version: string };
  const server = new McpServer({
    name: 'loom-knowledge',
    version: pkg.version,
  });

  // Multi-identity surface: a caller-asserted created_by that names a
  // DIFFERENT identity than its own bearer resolved to is an attribution
  // spoof, not a legitimate attribution (t-677 authorization finding) —
  // the full/local server leaves this open since it's single-operator.
  registerKnowledgeTools(server, { contextDir, gapsDir, identity, restrictCreatedByToIdentity: true });

  return { server };
}
