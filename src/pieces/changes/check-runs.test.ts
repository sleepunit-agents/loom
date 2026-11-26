import { expect, it } from 'vitest';
import { pullCheckReader } from './check-runs.js';
import type { Secrets } from './roles.js';
const secrets: Secrets = {
  async resolveGitHub() {
    return 'test';
  },
  async withValue(_name, use) {
    return use('test-token');
  },
};
it('reads completed, skipped and pending checks across pages and rejects a changed head', async () => {
  const pages: (string | null)[] = [];
  const read = pullCheckReader(secrets, async (_url, options) => {
    const after = JSON.parse(String(options?.body)).variables.after;
    pages.push(after);
    const contexts = {
      pageInfo: { hasNextPage: !after, endCursor: 'next' },
      nodes: after
        ? [{ context: 'Deploy', state: 'PENDING' }]
        : [
            { name: 'Unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'Platform', status: 'COMPLETED', conclusion: 'SKIPPED' },
          ],
    };
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            headRefOid: 'head',
            commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] },
          },
        },
      },
    });
  });
  expect(await read('github:house/loom', 12, 'head')).toEqual([
    { name: 'Unit', state: 'SUCCESS' },
    { name: 'Platform', state: 'SKIPPED' },
    { name: 'Deploy', state: 'PENDING' },
  ]);
  expect(pages).toEqual([null, 'next']);
  await expect(read('github:house/loom', 12, 'old-head')).rejects.toThrow();
});
