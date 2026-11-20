/** What a command-line client is given to work with: its streams, and how it reaches the program. */

export interface IOStreams {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: NodeJS.ReadableStream;
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function realStreams(): IOStreams {
  return {
    stdout: (s) => { process.stdout.write(s); },
    stderr: (s) => { process.stderr.write(s); },
    stdin: process.stdin,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    env: process.env,
  };
}

export async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** How a client sends a request and waits before a retry. Tests pass their own. */
export interface ClientRuntime { request: typeof fetch; retry(ms: number): Promise<void> }
