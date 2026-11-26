import { z } from 'zod';
import { withGitHub, type Secrets } from './roles.js';
import { parseRedactedJSON } from './redact.js';
import { repoId } from './model.js';

const query = `query PullChecks($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid commits(last:1){nodes{
    commit{statusCheckRollup{contexts(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{
      ... on CheckRun {name status conclusion} ... on StatusContext {context state}
    }}}}
  }}}}
}`;
const connection = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(
    z.union([
      z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
      z.object({ context: z.string(), state: z.string() }),
    ]),
  ),
});
const response = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: z.string(),
        commits: z.object({
          nodes: z.tuple([
            z.object({
              commit: z.object({ statusCheckRollup: z.object({ contexts: connection }).nullable() }),
            }),
          ]),
        }),
      }),
    }),
  }),
});

/** Look up just the recorded PR head; a moving head invalidates the entire paged read. */
export function pullCheckReader(secrets: Secrets, request: typeof fetch = fetch) {
  return async (repository: string, number: number, head: string) => {
    const [owner, name] = repoId(repository).slice(7).split('/');
    return withGitHub(secrets, owner, async (token) => {
      const checks: { name: string; state: string }[] = [],
        seen = new Set<string>();
      let after: string | null = null;
      for (;;) {
        const res = await request('https://api.github.com/graphql', {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables: { owner, name, number, after } }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw Error('GitHub checks unavailable');
        const body = response.parse(parseRedactedJSON(await res.text(), token));
        const pull = body.data.repository.pullRequest;
        if (body.errors?.length || pull.headRefOid !== head)
          throw Error('GitHub checks unavailable for this head');
        const page = pull.commits.nodes[0].commit.statusCheckRollup?.contexts;
        if (!page) return checks;
        for (const node of page.nodes)
          checks.push(
            'context' in node
              ? { name: node.context, state: node.state }
              : { name: node.name, state: node.conclusion || node.status },
          );
        if (!page.pageInfo.hasNextPage) return checks;
        after = page.pageInfo.endCursor;
        if (!after || seen.has(after)) throw Error('Invalid check pagination');
        seen.add(after);
      }
    });
  };
}
