/** What every reading of a Comms thread row selects (CommsThread, comms-view/model.ts). Plain text and nothing
 * else, so the boards page reads the same row the desktop does without taking the desktop with it. */
export const threadFields = 'id conversation venue title agent project member pinned archivedAt lastAt readSeq working stopRequested';
