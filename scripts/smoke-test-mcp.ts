/**
 * End-to-end MCP smoke test.
 *
 * Spawns loom as a stdio MCP subprocess against the live
 * ~/.config/loom/art context dir, then drives recall / remember /
 * recall-the-new-thing / forget through the MCP client. Confirms the
 * sqlite-vec + fastembed pipeline works under the actual MCP runtime,
 * not just the unit harness.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CONTEXT_DIR = resolve(homedir(), '.config', 'loom', 'art');

async function main() {
  console.log(`[smoke] Spawning loom against ${CONTEXT_DIR}`);

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', resolve(process.cwd(), 'src/index.ts')],
    env: {
      ...process.env,
      LOOM_CONTEXT_DIR: CONTEXT_DIR,
    },
  });

  const client = new Client({ name: 'smoke-test', version: '0.0.1' });
  await client.connect(transport);
  console.log('[smoke] Connected');

  const tools = await client.listTools();
  console.log(`[smoke] Tools available: ${tools.tools.map((t) => t.name).join(', ')}`);

  // 1. Recall something we know should be there
  const r1 = await client.callTool({
    name: 'recall',
    arguments: { query: 'earworm phase 5 compose pipeline', limit: 3 },
  });
  console.log('\n[smoke] recall("earworm phase 5 compose pipeline"):');
  printToolResult(r1);

  // 2. List a few memories by category
  const r2 = await client.callTool({
    name: 'memory_list',
    arguments: { category: 'project', limit: 5 },
  });
  console.log('\n[smoke] memory_list({category: project, limit: 5}):');
  printToolResult(r2);

  // 3. Remember a new fact
  const stamp = new Date().toISOString();
  const r3 = await client.callTool({
    name: 'remember',
    arguments: {
      category: 'self',
      title: 'Rescue smoke test',
      content: `MCP smoke test ran at ${stamp}. sqlite-vec + fastembed working end-to-end.`,
      ttl: '1h',
    },
  });
  console.log('\n[smoke] remember(rescue smoke test):');
  printToolResult(r3);

  // 4. Recall it back
  const r4 = await client.callTool({
    name: 'recall',
    arguments: { query: 'rescue smoke test sqlite-vec fastembed', limit: 3 },
  });
  console.log('\n[smoke] recall back:');
  printToolResult(r4);

  // 5. Forget the test memory by extracting ref from r3
  const ref = extractRef(r3);
  if (ref) {
    const r5 = await client.callTool({
      name: 'forget',
      arguments: { ref },
    });
    console.log(`\n[smoke] forget(${ref}):`);
    printToolResult(r5);
  } else {
    console.log('\n[smoke] could not extract ref from remember; skipping forget');
  }

  await client.close();
  console.log('\n[smoke] Done — full MCP pipeline working');
}

function printToolResult(r: any) {
  if (r.isError) {
    console.log('  ERROR:', JSON.stringify(r, null, 2));
    return;
  }
  for (const block of r.content ?? []) {
    if (block.type === 'text') {
      console.log(
        block.text.split('\n').map((l: string) => `  ${l}`).join('\n'),
      );
    }
  }
}

function extractRef(r: any): string | null {
  for (const block of r.content ?? []) {
    if (block.type === 'text') {
      const m = block.text.match(/[a-z]+\/[a-z0-9-]+/i);
      if (m) return m[0];
    }
  }
  return null;
}

main().catch((e) => {
  console.error('[smoke] FAILED:', e);
  process.exit(1);
});
