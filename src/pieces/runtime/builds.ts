/** Build metadata only. No repository, image or runner access. */
import type { RuntimeRecords } from './records.js';
type House = NonNullable<RuntimeRecords['job']['made']>;
/** Match the old runner image grammar, dropping podman's optional localhost prefix. */
export function buildTag(value: string, agent: string): string | undefined {
  const match = /^(?:localhost\/)?(loom-house-([a-z][a-z0-9-]{0,39}):[0-9a-f]{20})$/.exec(value);
  return match?.[2] === agent ? match[1] : undefined;
}
export function sameHouse(left: House | undefined, right: House | undefined): boolean {
  return !!left && !!right && left.repo === right.repo && left.houseFile === right.houseFile && left.branch === right.branch && left.repoSecret === right.repoSecret;
}
/** The effective current identity, including the repository credential reference (never its value). */
export function configuredHouse(settings: RuntimeRecords['settings'] | undefined): House | undefined {
  if (!settings?.house) return;
  const repoSecret = settings.grants?.repoSecret;
  return { ...settings.house, ...(repoSecret === undefined ? {} : { repoSecret }) };
}
/** A historical build must never supply the image for a changed house configuration. */
export function configuredBuild(job: RuntimeRecords['job'], house: House | undefined): string | undefined {
  return job.claimedAt !== undefined && job.build && sameHouse(job.made, house) ? buildTag(job.build, job.agent) : undefined;
}
