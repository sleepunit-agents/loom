/** Attribution retained with archived Clock records; never current authority. */
import type { WorkAuthorship, WorkPrincipal } from '../../core/index.js';
export interface Authorship extends WorkAuthorship { principal: WorkPrincipal }
