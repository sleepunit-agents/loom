#!/usr/bin/env bash
# DCO sign-off check (CONTRIBUTING.md, "Before you start").
#
#   scripts/check-signoff.sh --range BASE HEAD   every commit in BASE..HEAD (CI)
#   scripts/check-signoff.sh --message FILE      one commit message (.githooks/commit-msg)
#
# A message passes when it carries a trailer `Signed-off-by: Name <email>`.
# Merge commits are checked too, except merges GitHub commits (committer
# GitHub <noreply@github.com>: the "Update branch" button, web conflict
# resolution), which nobody can sign. Anyone can set that committer email to
# slip a merge past this; accepted, because anyone can also type a sign-off.
# The check catches a forgotten sign-off; it does not stop a false one.
# Exit 0 pass, 1 fail, 2 usage; any git error fails the check (exit 128),
# never passes it. Tests: scripts/check-signoff.test.ts.
set -euo pipefail

fix_hint='Sign off with `git commit -s` (or `git commit --amend -s --no-edit`; `git rebase --signoff BASE` for a branch).'

# stdin: a commit message. Succeeds when it has a well-formed sign-off trailer.
signed_off() {
  git interpret-trailers --parse | grep -qE '^Signed-off-by: [^<>]*[^<> ] <[^<>@ ]+@[^<> ]+>$'
}

case "${1:-}" in
  --message)
    [ $# -eq 2 ] || { echo "usage: $0 --message FILE" >&2; exit 2; }
    if signed_off < "$2"; then
      exit 0
    fi
    echo "commit message has no 'Signed-off-by: Name <email>' trailer. $fix_hint" >&2
    exit 1
    ;;
  --range)
    [ $# -eq 3 ] || { echo "usage: $0 --range BASE HEAD" >&2; exit 2; }
    # Not inline in the for: a failing substitution there (a SHA the clone
    # lacks) would check zero commits and pass.
    shas=$(git rev-list "$2..$3")
    missing=0
    for sha in $shas; do
      if [ "$(git log -1 --format='%p' "$sha" | wc -w)" -gt 1 ] &&
         [ "$(git log -1 --format='%ce' "$sha")" = "noreply@github.com" ]; then
        continue
      fi
      msg=$(git log -1 --format='%B' "$sha")
      if ! signed_off <<< "$msg"; then
        echo "missing 'Signed-off-by: Name <email>': $(git log -1 --format='%h %s' "$sha")" >&2
        missing=1
      fi
    done
    if [ "$missing" -eq 1 ]; then
      echo "$fix_hint" >&2
    fi
    exit "$missing"
    ;;
  *)
    echo "usage: $0 --range BASE HEAD | --message FILE" >&2
    exit 2
    ;;
esac
