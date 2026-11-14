/** Injected private-word operations. Key loading belongs to the composition. */
export interface WordsKey {
 seal(words: string): Promise<Buffer>;
 open(blob: Uint8Array): Promise<string>;
 hash(words: string): string;
}
