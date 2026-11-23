#!/usr/bin/env bash
# Exercise an already-built image with its own disposable household, including a restart.
set -euo pipefail
image=${1:?Usage: scripts/check-container-image.sh IMAGE}
volume=$(podman volume create)
container=
cleanup() {
  if [[ -n "$container" ]]; then podman rm -f "$container" >/dev/null; fi
  podman volume rm "$volume" >/dev/null
}
trap cleanup EXIT
podman run --rm --network none -v "$volume:/var/lib/loom" "$image" \
  node scripts/example-home.mjs /var/lib/loom/household >/dev/null
container=$(podman run -d --network none -e LOOM_PUBLIC_URL=http://localhost:8787 -v "$volume:/var/lib/loom" "$image")
for run in 1 2; do
  if [[ "$run" == 2 ]]; then podman restart "$container" >/dev/null; fi
  podman exec -i "$container" node --input-type=module - "$run" <<'JS'
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
const origin='http://localhost:8787';
for(let i=0;i<60;i++){
  if(await fetch(origin).then(r=>r.ok).catch(()=>false))break;
  await delay(250);
}
assert.ok((await fetch(origin)).ok);
const browser=await chromium.launch({executablePath:process.env.LOOM_TEST_CHROME});
try {
  const page=await browser.newPage({reducedMotion:'reduce'});
  const link=execFileSync(process.execPath,['dist/index.js','signin','--member','alex'],{encoding:'utf8'}).trim();
  const url=new URL(link);
  assert.equal(url.origin,origin);
  await page.goto(link).catch(()=>{throw Error('The browser could not open its local sign-in link');});
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();
  await page.goto(origin+'/p/tasks-preview?folder=progress');
  const tasks=page.getByRole('region',{name:'Tasks tile',exact:true});
  await tasks.locator('[data-split-row]').filter({hasText:'Compare garden pumps'}).click();
  const comment='Checked in the container before restart.';
  if(process.argv[2]==='1'){
    await tasks.getByRole('button',{name:'Comment',exact:true}).click();
    const form=tasks.getByRole('form',{name:'Add comment',exact:true});
    await form.getByLabel('Comment',{exact:true}).fill(comment);
    await form.getByRole('button',{name:'Add comment',exact:true}).click();
  }
  await tasks.getByText(comment,{exact:true}).waitFor();
} finally {await browser.close();}
JS
done
echo 'Chromium saved a task comment in the image and read it after restarting the container.'
