/** The most words one message may carry, in characters. Every door that takes words someone will be sent
 * holds them to this: a message and a reply in Comms, a card, an answer, a question and its parts, a
 * handed-off message, a reply out through a bridge, a trigger's instructions and an approval's details.
 * One number, because the same words pass from one of these to the next: words one door took and the
 * next writer of the same message refused would be lost between them. The app's two message boxes show
 * the same number as a hint (src/single-home.contract.test.ts holds them to it). */
export const MESSAGE_WORDS_MAX = 100_000;
/** Injected private-word operations. Key loading belongs to the composition. */
export interface WordsKey {
 seal(words: string): Promise<Buffer>;
 open(blob: Uint8Array): Promise<string>;
 hash(words: string): string;
}
