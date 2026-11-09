// A chart's series never share a colour (Jonathan, 2026-11-05: Tasks' "opened and done are the same color in the
// graph"). web/src/lib/cojeev/chart-geometry.ts distinctColors, which 000h's chart frame resolves its series with; the
// tint half of that bug (an app's accent re-pointing --v-pink) is checked in a real browser, in app-nav.integration.test.ts.
import { describe, it, expect } from 'vitest';
import { distinctColors } from '../../web/src/lib/cojeev/chart-geometry';

const colors = (s: Array<{ key: string; color?: 'pink' | 'blue' | 'olive' | 'yellow' | 'ink' }>) => distinctColors(s).map((x) => x.color);

describe('a chart\'s series colours', () => {
  it('keeps the colours the series name when they differ', () => {
    expect(colors([{ key: 'opened', color: 'pink' }, { key: 'done', color: 'olive' }])).toEqual(['pink', 'olive']);
  });

  it('gives a series that names a taken colour the first one nobody has', () => {
    expect(colors([{ key: 'a', color: 'pink' }, { key: 'b', color: 'pink' }])).toEqual(['pink', 'blue']);
  });

  it('never gives a series with no colour one a later series names', () => {
    // The old rule (the palette by position) drew both of these blue.
    expect(colors([{ key: 'a', color: 'blue' }, { key: 'b' }])).toEqual(['blue', 'pink']);
    expect(colors([{ key: 'a' }, { key: 'b', color: 'pink' }])).toEqual(['blue', 'pink']);
  });

  it('keeps every colour different up to the palette\'s five, and only then comes round again', () => {
    // Five that all ask for olive: the old rule drew all five olive.
    const five = colors(['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, color: 'olive' as const })));
    expect(five).toEqual(['olive', 'pink', 'blue', 'yellow', 'ink']);
    // A sixth has nothing left: it takes the palette by its position, the sixth's being the first again.
    expect(colors(['a', 'b', 'c', 'd', 'e', 'f'].map((key) => ({ key, color: 'olive' as const })))[5]).toBe('pink');
  });
});
