export const PROGRAM_OUTPUT_BYTES = 16_384;

/** Keep execution bounded even when the caller does not cancel. */
export function programDeadline(timeoutMs: number, parent?: AbortSignal) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, deadline]) : deadline;
}

const programCredential = /(?:Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-|loom_[a-z0-9_-]{43}|(?:body_|loom_ui=)[a-f0-9]{32,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|xox[baprs]-[\w-]{10,}|sk-(?:ant-)?[\w-]{20,})/i;
const diagnosticCredential = /(?:\b(?:loom_|body_|gh[pousr]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{8,}|\b(?:bearer|basic)\s+[A-Za-z0-9_+/=.:-]+|\b(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key)["']?\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|:\/\/[^\s/@]+:[^\s/@]+@)/i;

export function looksLikeCredential(text: string, secrets: readonly string[] = [], purpose: 'program' | 'diagnostic' = 'program'): boolean {
  const forms = secrets.filter(Boolean).flatMap(value => [value, Buffer.from(value).toString('base64')]);
  const inspect = (value: string) => {
    return programCredential.test(value) || (purpose === 'diagnostic' && diagnosticCredential.test(value)) || forms.some(secret => value.includes(secret));
  };
  if (inspect(text)) return true;
  // A helper can print JSON inside a larger text response. Inspect decoded keys and values there too.
  for (const [literal] of text.matchAll(/"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/g))
    if (inspect(JSON.parse(literal))) return true;
  return false;
}
