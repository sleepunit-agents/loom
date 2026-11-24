import assert from 'node:assert/strict';
import {withNamedTools} from './rebuild-named-tool-client.mjs';

export async function namedCards(call, secondAgent) {
  await withNamedTools(secondAgent, async other => {
    for (const kind of ['person', 'project']) {
      const slug = 'orchard-' + kind;
      const name = 'Orchard ' + kind;
      const original = 'Fern observed three seedlings.';
      const revised = 'Fern observed five seedlings.';
      const independent = 'Moss counted two trays.';
      await call(kind + '_write', {slug, name, summary: original});
      assert.ok((await call(kind, {slug})).includes(original));
      assert.ok((await call(kind, {})).includes(slug + ' (' + name + ')'));
      assert.equal(await other(kind, {slug}), 'No ' + kind + ' card for ' + slug);
      assert.ok(!(await other(kind, {})).includes(slug));

      await other(kind + '_write', {slug, name: 'Second ' + kind, summary: independent});
      await call(kind + '_write', {slug, merge: true, summary: revised});
      const first = await call(kind, {slug});
      assert.ok(first.includes('# ' + name) && first.includes(revised));
      assert.ok(!first.includes(original) && !first.includes(independent));
      const second = await other(kind, {slug});
      assert.ok(second.includes(independent) && !second.includes(revised));
      assert.ok((await other(kind, {})).includes(slug + ' (Second ' + kind + ')'));
    }
  });
  return {ok:true, reason:'Two agents wrote and listed people and project cards under the same slugs. Each read its own words, and edits preserved the card name and the other agent’s copy.'};
}
