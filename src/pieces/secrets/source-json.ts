/** Strict JSON decoding for offline legacy metadata. Callers redact failures. */
// JSON.parse accepts duplicate keys with last-key-wins semantics. After syntax
// validation, walk the token stream and reject duplicates at every object depth,
// comparing decoded keys so escaped aliases cannot hide records or unknown fields.
function rejectDuplicateKeys(text: string): void {
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)!;
  let cursor = 0;
  const value = (): void => {
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set<string>();
      if (tokens[cursor] === '}') { cursor++; return; }
      for (;;) {
        const key = JSON.parse(tokens[cursor++]) as string;
        if (keys.has(key)) throw new Error();
        keys.add(key);
        cursor++; // colon (the complete text already passed JSON syntax validation)
        value();
        if (tokens[cursor++] === '}') return;
      }
    }
    if (token === '[') {
      if (tokens[cursor] === ']') { cursor++; return; }
      for (;;) { value(); if (tokens[cursor++] === ']') return; }
    }
  };
  value();
}

/** No filesystem, DB, clock or legacy-program dependencies. */
export function parseLegacyMetadataJson(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const json: unknown = JSON.parse(text);
  rejectDuplicateKeys(text);
  return json;
}
