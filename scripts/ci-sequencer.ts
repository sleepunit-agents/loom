import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import durations from './ci-test-durations.json' with { type: 'json' };

// Medians of successful Node 24 file reports, 52 runs ending at 42770831885.
// Balance each project separately: Vitest runs the projects sequentially.
// New files still run, with a conservative 1s estimate until the next refresh.
export function partition<T>(files: readonly T[], count: number, key: (file: T) => string,
  weight: (file: T) => number): T[][] {
  const shards = Array.from({ length: count }, () => [] as T[]);
  const loads = Array<number>(count).fill(0);
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || key(a).localeCompare(key(b)))) {
    const shard = loads.indexOf(Math.min(...loads));
    shards[shard].push(file);
    loads[shard] += weight(file);
  }
  return shards;
}

export default class CiSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!;
    const path = (file: TestSpecification) => relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/');
    const estimates: Record<string, number> = durations;
    const projects = new Map<string, TestSpecification[]>();
    for (const file of files) {
      const group = projects.get(file.project.name) ?? [];
      group.push(file);
      projects.set(file.project.name, group);
    }
    return [...projects.values()].flatMap(group => partition(group, count, path,
      file => estimates[path(file)] ?? 1000)[index - 1]);
  }
}
