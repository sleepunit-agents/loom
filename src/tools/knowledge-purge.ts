import { createKnowledgeBackend } from '../backends/index.js';

export interface KnowledgePurgeToolInput {
  slugs: string[];
  confirm: boolean;
}

export async function knowledgePurge(
  contextDir: string,
  input: KnowledgePurgeToolInput,
): Promise<string> {
  if (!input.confirm) {
    return 'Error: confirm must be explicitly true to execute a hard delete.';
  }
  if (!input.slugs || input.slugs.length === 0) {
    return 'Error: slugs must not be empty.';
  }

  const backend = createKnowledgeBackend(contextDir);
  try {
    const result = await backend.purgePages({ slugs: input.slugs, confirm: true });
    return `Purged ${result.purged} page(s): ${result.slugs.map((s) => `\`${s}\``).join(', ')}.`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
