import { expect, it } from 'vitest';
import { parseLegacyMetadataJson } from './source-json.js';

it('decodes valid Unicode and token-looking strings without changing supplied bytes', () => {
  const value = {reason: 'clé 🔑 quote " slash \\ {} [] , :', rows: [{grant: 'never'}, {grant: 'auto'}]};
  const bytes = Buffer.from(JSON.stringify(value));
  const original = Buffer.from(bytes);
  expect(parseLegacyMetadataJson(bytes)).toEqual(value);
  expect(bytes).toEqual(original);
});
it('refuses malformed UTF-8 even when replacement decoding would produce valid JSON', () => {
  const bytes = Buffer.from('{"reason":"X"}');
  bytes[bytes.indexOf('X')] = 0xff;
  expect(() => parseLegacyMetadataJson(bytes)).toThrow();
});
it('rejects duplicates inside arrays and escaped aliases while allowing distinct objects', () => {
  for (const text of [
    '{"rules":[{"grant":"never","grant":"auto"}]}',
    String.raw`{"rules":[{"grant":"never","gr\u0061nt":"auto"}]}`,
    '{"rules":[[{}, {"nested":{"x":1,"x":2}}]]}',
    '{"__proto__":{},"__proto__":{}}',
    '', '{', '[1,]', '{"x":1} trailing',
  ]) expect(() => parseLegacyMetadataJson(Buffer.from(text))).toThrow();
  expect(parseLegacyMetadataJson(Buffer.from('[{"x":1},{"x":2}]'))).toEqual([{x: 1}, {x: 2}]);
});
