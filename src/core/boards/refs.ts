/** Shapes and fixed lists the brick catalogue (bricks.ts) and the page that draws the bricks both read. Plain values:
 * the page imports this file without the catalogue or its schema library. */
/** A knowledge page's slug, as Knowledge addresses a page (memoryKnowledgePage, mind.knowledgeVerify). Loom makes one
 * from a title as lowercase letters, digits and `-`, up to 128 long; older pages hold `_`, `.` and `/`. Longer than
 * the shared reference, and with no `:` or `@`. A page whose slug holds anything else cannot be placed. */
export const knowledgePageRef = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
/** A knowledge topic: a page's domain or the part of it before a `/`, as Knowledge lists its topics. */
export const knowledgeTopicRef = /^[a-z0-9][a-z0-9._\/-]{0,119}$/;
/** The lists Knowledge has beside its topics (web/src/pieces/knowledge/model.ts, inFolder). */
export const knowledgeLists = ['all', 'recent', 'due'] as const;
/** What mind.knowledgeAnnotate takes as `kind` (src/pieces/mind/actions.ts). The words go to it and never to the board. */
export const knowledgeAnnotations = ['note', 'outdated', 'intent', 'no-longer-owned', 'in-use'] as const;
/** The People app's folders, which are the two kinds of card (web/src/pieces/people/model.ts, contacts). */
export const peopleFolders = ['all', 'person', 'agent'] as const;
/** A Tempo trigger's id, as Tempo addresses one (`tempo.stop`, `tempo.runNow`, the desktop's /p/tempo/trigger/<id>):
 * `tr-` and a UUID where loom made it, a short name where its setter gave one. The shape of an id and nothing else;
 * a trigger whose id holds anything else cannot be placed, and the page then says its name without a chip. */
export const triggerRef = /^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/;
