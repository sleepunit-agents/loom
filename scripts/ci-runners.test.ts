// Standing rule: our own runners never run a fork's code. A self-hosted runner sits on the home lab,
// so every job in .github/workflows must either run on a GitHub-hosted machine or use TRUSTED_RUNS_ON,
// the one expression that sends only pushes, merge-queue groups and this repository's own branches'
// pull requests to self-hosted. This test fails on anything else that could reach one: a self-hosted or
// custom label, a runner group, a list form it can't read, a reusable workflow from elsewhere, or a
// trigger that runs with a fork's input on the base repository (pull_request_target and friends).
// It checks text, not YAML, so a form it doesn't know is a failure, not a pass.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TRUSTED_RUNS_ON =
  "${{ vars.LOOM_SELF_HOSTED_RUNNERS == 'on' && (github.event_name == 'push' || github.event_name == 'merge_group' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]')) && fromJSON('[\"self-hosted\",\"Linux\",\"X64\",\"loom\"]') || 'ubuntu-latest' }}";

// GitHub's own images by name: a self-hosted runner can carry any label, even ubuntu-lab.
const HOSTED = /^(ubuntu-(latest|2\d\.04)(-arm)?|windows-(latest|20\d\d)|macos-(latest|\d+))$/;
// Triggers a workflow with TRUSTED_RUNS_ON may have: each is started by someone with write access, or
// (pull_request) carries the head repository that the expression checks. The same three the runners'
// hook (ci-runner-hook.sh) lets through.
const TRUSTED_TRIGGERS = new Set(['push', 'pull_request', 'merge_group']);

function triggers(text: string): string[] {
  const inline = text.match(/^on:[ \t]*([^\s#].*)$/m);
  if (inline) return inline[1].replace(/[[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean);
  const block = text.match(/^on:[ \t]*(?:#.*)?\n((?:[ \t]+.*\n|[ \t]*\n)*)/m);
  const indent = block?.[1].match(/^([ \t]+)[^\s#]/m)?.[1];
  if (!block || !indent) return ['<unreadable on:>'];
  const keys = [...block[1].matchAll(new RegExp(`^${indent}([^\\s#:]+):`, 'gm'))].map((m) => m[1]);
  return keys.length ? keys : ['<unreadable on:>'];
}

export function checkWorkflow(name: string, text: string): string[] {
  const problems: string[] = [];
  let trusted = false;
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/(^|\s)#.*$/, '');
    const at = `${name}:${i + 1}`;
    const runsOn = code.match(/^\s*runs-on:(.*)$/);
    if (!runsOn && /["']?runs-on["']?\s*:/.test(code)) {
      problems.push(`${at}: runs-on in a form this check can't read (quoted key, flow mapping, …)`);
    } else if (/<<\s*:/.test(code) || /(:|-)\s+[&*][A-Za-z_]/.test(code)) {
      problems.push(`${at}: YAML anchors, aliases and merge keys could carry a runner past this check`);
    } else if (runsOn) {
      const value = runsOn[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value === TRUSTED_RUNS_ON) trusted = true;
      else if (!HOSTED.test(value)) problems.push(`${at}: runs-on must be a GitHub-hosted label or TRUSTED_RUNS_ON, not ${JSON.stringify(value)}`);
    } else if (/self-hosted/.test(code)) {
      problems.push(`${at}: self-hosted outside the trusted runs-on`);
    }
    const uses = code.match(/^\s*uses:\s*(\S+\/\.github\/workflows\/\S+)/);
    if (uses && !uses[1].startsWith('./')) problems.push(`${at}: reusable workflow from elsewhere (${uses[1]}) could pick its own runner`);
  });
  if (trusted) {
    for (const t of triggers(text)) {
      if (!TRUSTED_TRIGGERS.has(t)) problems.push(`${name}: trigger ${t} may not share a workflow with self-hosted runners`);
    }
  }
  return problems;
}

describe('CI runner fork safety', () => {
  const dir = resolve(__dirname, '../.github/workflows');
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it('finds the workflows', () => {
    expect(files).toContain('ci.yml');
  });

  it.each(files)('%s sends no fork-reachable job to a self-hosted runner', (f) => {
    expect(checkWorkflow(f, readFileSync(join(dir, f), 'utf8'))).toEqual([]);
  });

  it('ci.yml uses the trusted expression for its tests and results', () => {
    const lines = readFileSync(join(dir, 'ci.yml'), 'utf8').split('\n').map((l) => l.trim());
    expect(lines.filter((l) => l === `runs-on: ${TRUSTED_RUNS_ON}`)).toHaveLength(2);
  });

  const wf = (job: string, on = 'on:\n  pull_request:\n') => `${on}jobs:\n  t:\n${job}`;
  it.each([
    ['a bare self-hosted label', wf('    runs-on: [self-hosted, loom]\n')],
    ['a list form', wf('    runs-on:\n      - self-hosted\n')],
    ['a runner group', wf('    runs-on:\n      group: loom\n')],
    ['a custom label', wf('    runs-on: wunder\n')],
    ['a matrix-chosen runner', wf('    runs-on: ${{ matrix.os }}\n')],
    ['the expression without the fork guard', wf(`    runs-on: ${TRUSTED_RUNS_ON.replace(" && github.event.pull_request.head.repo.full_name == github.repository", '')}\n`)],
    ['the expression under pull_request_target', wf(`    runs-on: ${TRUSTED_RUNS_ON}\n`, 'on:\n  pull_request_target:\n')],
    ['the expression under an inline workflow_run', wf(`    runs-on: ${TRUSTED_RUNS_ON}\n`, 'on: [push, workflow_run]\n')],
    ['the expression letting Dependabot in', wf(`    runs-on: ${TRUSTED_RUNS_ON.replace(" && github.event.pull_request.user.login != 'dependabot[bot]'", '')}\n`)],
    ['the expression under a four-space pull_request_target', wf(`    runs-on: ${TRUSTED_RUNS_ON}\n`, 'on:\n    pull_request_target:\n')],
    ['the expression under an unreadable on:', wf(`    runs-on: ${TRUSTED_RUNS_ON}\n`, '"on":\n  pull_request_target:\n')],
    ['a hosted-looking custom label', wf('    runs-on: ubuntu-lab\n')],
    ['a quoted runs-on key', wf('    "runs-on": wunder\n')],
    ['a flow mapping', 'on: [pull_request]\njobs:\n  t: { runs-on: wunder, steps: [] }\n'],
    ['a merge key', wf('    <<: *lab\n')],
    ['an anchored runner', wf('    runs-on: &lab wunder\n')],
    ['a reusable workflow from another repository', wf('    uses: someone/else/.github/workflows/ci.yml@main\n')],
  ])('refuses %s', (_, text) => {
    expect(checkWorkflow('x.yml', text)).not.toEqual([]);
  });

  it('accepts hosted labels and the trusted expression', () => {
    expect(checkWorkflow('x.yml', wf("    runs-on: ubuntu-latest\n  u:\n    runs-on: 'ubuntu-24.04'\n"))).toEqual([]);
    expect(checkWorkflow('x.yml', wf(`    runs-on: ${TRUSTED_RUNS_ON}\n`, 'on:\n  push:\n    branches: [main]\n  pull_request:\n  merge_group:\n'))).toEqual([]);
  });
});
