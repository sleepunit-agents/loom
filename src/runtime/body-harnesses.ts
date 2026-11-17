/** Every harness a body can run on, by the name a model's role gives it. Adding one is one line here and
 * one file beside this: see body-harness.ts for what that file has to do. */
import type { BodyHarness } from './body-harness.js';
import { agyBody, agyLeftovers } from './agy-body.js';
import { claudeBody } from './claude-body.js';
import { codexBody } from './codex-body.js';

export const bodyHarnesses: Readonly<Record<string, BodyHarness>> = Object.freeze({ agy: agyBody, claude: claudeBody, codex: codexBody });

/** What a harness leaves outside its body's scratch directory and can only remove itself when it ends normally.
 * The worker calls this with the scratch directory and the body's environment after the body's process
 * group is gone, so a killed body is tidied too. */
export const bodyLeftovers: Readonly<Record<string, (scratch: string, env: Readonly<Record<string, string | undefined>>) => void>> = Object.freeze({ agy: agyLeftovers });
