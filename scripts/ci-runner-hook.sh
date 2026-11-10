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
# opened (not Dependabot); a merge-queue group on main that is still queued, while no fork's pull
# request is in the queue. Anything else,
# and anything this can't read, is refused.
#
# The merge queue is only in GitHub's GraphQL API, which needs a token: LOOM_RUNNER_QUEUE_TOKEN_FILE names a
# file holding a read-only token (it needs no permissions beyond reading this public repository).
set -euo pipefail

REPO=sleepunit-agents/loom
refuse() { echo "::error::loom runner refuses this job: $*"; exit 1; }

[ "${GITHUB_REPOSITORY:-}" = "$REPO" ] || refuse "repository ${GITHUB_REPOSITORY:-unknown}"
[ -r "${GITHUB_EVENT_PATH:-}" ] || refuse "no event payload to check"
event=$GITHUB_EVENT_PATH

case "${GITHUB_EVENT_NAME:-}" in
  push)
    exit 0 ;;
  pull_request)
    head=$(jq -r '.pull_request.head.repo.full_name // ""' "$event")
    author=$(jq -r '.pull_request.user.login // ""' "$event")
    [ "$head" = "$REPO" ] || refuse "pull request from ${head:-a deleted fork}"
    [ "$author" != 'dependabot[bot]' ] || refuse "a Dependabot pull request"
    exit 0 ;;
  merge_group)
    # Only main has a merge queue. The group must still be queued (its head commit is an entry's), so a group
    # built with a fork's pull request that has since left the queue is refused too, and no fork's pull
    # request may be queued anywhere.
    base=$(jq -r '.merge_group.base_ref // ""' "$event")
    sha=$(jq -r '.merge_group.head_sha // ""' "$event")
    [ "$base" = refs/heads/main ] || refuse "a merge queue on ${base:-an unknown branch}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "a merge-queue group with no head commit"
    token_file=${LOOM_RUNNER_QUEUE_TOKEN_FILE:-}
    [ -n "$token_file" ] && [ -r "$token_file" ] || refuse "no token to read the merge queue"
    query='{"query":"{ repository(owner: \"sleepunit-agents\", name: \"loom\") { mergeQueue(branch: \"main\") { entries(first: 100) { totalCount nodes { headCommit { oid } pullRequest { number isCrossRepository } } } } } }"}'
    answer=$(curl -fsS --max-time 20 -H "Authorization: bearer $(cat "$token_file")" -H 'Content-Type: application/json' \
      -d "$query" https://api.github.com/graphql) || refuse "could not read the merge queue"
    verdict=$(jq -r --arg sha "$sha" '
      .data.repository.mergeQueue.entries as $e
      | if $e == null or ($e.totalCount > ($e.nodes | length)) then "unreadable"
        elif ([$e.nodes[] | select(.headCommit.oid == $sha)] | length) == 0 then "gone"
        else ([$e.nodes[] | select(.pullRequest.isCrossRepository != false) | .pullRequest.number // "?"] | join(" "))
        end' <<<"$answer") || refuse "could not read the merge queue"
    [ "$verdict" != unreadable ] || refuse "could not read the whole merge queue"
    [ "$verdict" != gone ] || refuse "this group is no longer in the merge queue"
    [ -z "$verdict" ] || refuse "a fork's pull request is in the merge queue (#$verdict)"
    exit 0 ;;
  *)
    refuse "event ${GITHUB_EVENT_NAME:-unknown}" ;;
esac
