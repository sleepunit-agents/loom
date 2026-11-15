#!/usr/bin/env bash
# Keep both Node versions' evidence even when the first one contains failures.
set -euo pipefail
result=0
for version in 22.x 24.x; do
  mkdir -p "merged/$version/blobs"
  # download-artifact includes every run attempt. A failed-jobs rerun only
  # replaces those shards, so choose the newest attempt independently for each.
  declare -A newest=() attempts=()
  for shard in reports/ci-node-$version-shard-*; do
    [ -f "$shard/shard.blob.json" ] || continue
    suffix=${shard##*/ci-node-$version-shard-}
    [[ $suffix =~ ^([0-9]+)-([0-9]+)$ ]] || continue
    number=${BASH_REMATCH[1]} attempt=${BASH_REMATCH[2]}
    if (( attempt > ${attempts[$number]:-0} )); then
      newest[$number]=$shard
      attempts[$number]=$attempt
    fi
  done
  for shard in "${newest[@]}"; do
    cp "$shard/shard.blob.json" "merged/$version/blobs/$(basename "$shard").json" || result=1
  done
  if [ -n "$(ls -A "merged/$version/blobs")" ]; then
    # Affected-only shards can legitimately have no tests. The workflow still
    # requires every shard and the deploy build to succeed.
    npx vitest --passWithNoTests --merge-reports="merged/$version/blobs" --reporter=json --outputFile="merged/$version/vitest.json" || result=1
  fi
done
exit "$result"
