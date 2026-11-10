#!/usr/bin/env bash
# The lock on loom's self-hosted runners: their ACTIONS_RUNNER_HOOK_JOB_STARTED. A job this refuses fails
# before any of its steps run. ci.yml's runs-on only asks for these runners for trusted runs, but a fork can
# edit ci.yml in its own pull request, and a merge-queue group carries the code of every pull request queued
# ahead of it. So the runner decides for itself, from the event GitHub delivered, never from the checkout.
# Install it from main, not from a pull request: copy it outside the runner's work directory, owned by root
# and not writable by the runner's user, and set ACTIONS_RUNNER_HOOK_JOB_STARTED to that copy in the
# runner's .env.
#
# Allowed: a push to this repository; a pull request whose branch is in this repository and which a person
# opened (not Dependabot); a merge-queue group on main that is still queued and holds no fork's pull
# request. Anything else,
# and anything this can't read, is refused.
#
# The merge queue is only in GitHub's GraphQL API, which needs a token: LOOM_RUNNER_QUEUE_TOKEN_FILE names a
# file holding a read-only token (it needs no permissions beyond reading this public repository).
set -euo pipefail
# Tools from the system, never from a PATH a job could have touched. The test points curl at a stand-in.
PATH=/usr/bin:/bin
JQ=/usr/bin/jq
CURL=${LOOM_RUNNER_HOOK_CURL:-/usr/bin/curl}

REPO=sleepunit-agents/loom
refuse() { echo "::error::loom runner refuses this job: $*"; exit 1; }

[ "${GITHUB_REPOSITORY:-}" = "$REPO" ] || refuse "repository ${GITHUB_REPOSITORY:-unknown}"
[ -r "${GITHUB_EVENT_PATH:-}" ] || refuse "no event payload to check"
event=$GITHUB_EVENT_PATH

case "${GITHUB_EVENT_NAME:-}" in
  push)
    exit 0 ;;
  pull_request)
    head=$("$JQ" -r '.pull_request.head.repo.full_name // ""' "$event")
    author=$("$JQ" -r '.pull_request.user.login // ""' "$event")
    [ "$head" = "$REPO" ] || refuse "pull request from ${head:-a deleted fork}"
    [ "$author" != 'dependabot[bot]' ] || refuse "a Dependabot pull request"
    exit 0 ;;
  merge_group)
    # Only main has a merge queue. A group holds the code of its own entry and every entry ahead of it, so
    # those must all be this repository's; entries behind it are not in it. The group must still be queued
    # (its head commit is an entry's): one built with a fork's pull request that has since left the queue
    # is refused too. A fork's pull request can't merge through the queue while our runners are on.
    base=$("$JQ" -r '.merge_group.base_ref // ""' "$event")
    sha=$("$JQ" -r '.merge_group.head_sha // ""' "$event")
    [ "$base" = refs/heads/main ] || refuse "a merge queue on ${base:-an unknown branch}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "a merge-queue group with no head commit"
    token_file=${LOOM_RUNNER_QUEUE_TOKEN_FILE:-}
    [ -n "$token_file" ] && [ -r "$token_file" ] || refuse "no token to read the merge queue"
    query='{"query":"{ repository(owner: \"sleepunit-agents\", name: \"loom\") { mergeQueue(branch: \"main\") { entries(first: 100) { totalCount nodes { headCommit { oid } pullRequest { number isCrossRepository } } } } } }"}'
    # The token goes to curl on stdin, not in its arguments, where any process could read it.
    answer=$(printf 'header = "Authorization: bearer %s"\n' "$(< "$token_file")" \
      | "$CURL" -fsS --max-time 20 -K - -H 'Content-Type: application/json' -d "$query" https://api.github.com/graphql) \
      || refuse "could not read the merge queue"
    verdict=$("$JQ" -r --arg sha "$sha" '
      .data.repository.mergeQueue.entries as $e
      | if ($e | type) != "object" or ($e.nodes | type) != "array" or $e.totalCount > ($e.nodes | length) then "unreadable"
        else ([$e.nodes | to_entries[] | select(.value.headCommit.oid == $sha) | .key] | first) as $at
        | if $at == null then "gone"
          else ([$e.nodes[0:$at + 1][] | select(.pullRequest.isCrossRepository != false) | .pullRequest.number // "?"] | join(" "))
          end
        end' <<<"$answer") || refuse "could not read the merge queue"
    [ "$verdict" != unreadable ] || refuse "could not read the whole merge queue"
    [ "$verdict" != gone ] || refuse "this group is no longer in the merge queue"
    [ -z "$verdict" ] || refuse "this group holds a fork's pull request (#$verdict)"
    exit 0 ;;
  *)
    refuse "event ${GITHUB_EVENT_NAME:-unknown}" ;;
esac
