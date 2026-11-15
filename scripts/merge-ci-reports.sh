#!/usr/bin/env bash
# Keep both Node versions' evidence even when the first one contains failures.
set -euo pipefail
result=0
for version in 22.x 24.x; do
  mkdir -p "merged/$version/blobs"
  for shard in reports/ci-node-$version-shard-*; do
    [ -f "$shard/shard.blob.json" ] || continue
    cp "$shard/shard.blob.json" "merged/$version/blobs/$(basename "$shard").json" || result=1
  done
  if [ -n "$(ls -A "merged/$version/blobs")" ]; then
    # Affected-only shards can legitimately have no tests. The workflow still
    # requires every shard and the deploy build to succeed.
    npx vitest --passWithNoTests --merge-reports="merged/$version/blobs" --reporter=json --outputFile="merged/$version/vitest.json" || result=1
  fi
done
exit "$result"
