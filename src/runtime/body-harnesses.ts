/** Every harness a body can run on, by the name a model's role gives it. Adding one is one line here and
 * one file beside this: see body-harness.ts for what that file has to do. */
import type { BodyHarness } from './body-harness.js';
import { agyBody } from './agy-body.js';
import { claudeBody } from './claude-body.js';
import { codexBody } from './codex-body.js';

export const bodyHarnesses: Readonly<Record<string, BodyHarness>> = Object.freeze({ agy: agyBody, claude: claudeBody, codex: codexBody });
