#!/usr/bin/env bash
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/merge-ci-reports.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
mkdir -p bin reports/ci-node-22.x-shard-1-1 reports/ci-node-24.x-shard-1-1
printf '{}\n' > reports/ci-node-22.x-shard-1-1/shard.blob.json
printf '{}\n' > reports/ci-node-24.x-shard-1-1/shard.blob.json
cat > bin/npx <<'STUB'
#!/usr/bin/env bash
for arg; do
  case "$arg" in --outputFile=*) dest=${arg#--outputFile=};; esac
done
printf '{}\n' > "$dest"
case "$dest" in *22.x*) exit 1;; esac
STUB
chmod +x bin/npx
export PATH="$scratch/bin:$PATH"
if bash "$script"; then echo 'failed Node22 report must keep the gate red' >&2; exit 1; fi
test -s merged/22.x/vitest.json
test -s merged/24.x/vitest.json
# The queue runs Node24 only: the absent Node22 report is normal.
rm -r merged reports/ci-node-22.x-shard-1-1
bash "$script"
test -s merged/24.x/vitest.json
printf 'both versions retained after failure; Node24-only queue passes\n'
