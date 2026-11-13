import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Operations, Viewer } from '../core/index.js';
/** Only daemon sessions expose app operations; offline stdio keeps continuity only. */
export function registerOperationTools(server: McpServer, operations: Operations, viewer: Viewer) {
  operations.registerMcp((name, input, call) => {
    server.registerTool(name, {
      description: `Call ${name} through the daemon operation registry.`,
      inputSchema: z.object({ input, id: z.string().optional() }),
    }, async args => {
      const result = call(viewer, args.input, args.id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(!result.ok ? { isError: true } : {}) };
    });
  });
}
