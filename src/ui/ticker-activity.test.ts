import { expect, it } from 'vitest';
import { tickerActivityOf } from './handler.js';
import { parseManifest } from './vocab.js';
import type { PieceInfo } from './pieces.js';
const now = Date.parse('2026-11-09T20:00:00Z');
const activity = { action: 'Reading a file', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString() };
function pieces(doing: unknown[], jobs: unknown[] = []): PieceInfo[] {
 const m = parseManifest({v:2,asks:[],agents:{art:{readings:[],doing,jobs}}});
 if (typeof m === 'string') throw new Error(m);
 return [{piece:'runtime',path:'runtime',manifest:m}];
}
it('selects fresh safe observations and fixed venue, never lifecycle text as a heartbeat', () => {
 expect(tickerActivityOf(pieces([{text:'private',kind:'talk',where:'Discord',activity}]),'art',now)).toEqual({activity:{...activity,where:'Discord'}});
 expect(tickerActivityOf(pieces([{text:'pgrep secret',since:new Date(now).toISOString()}]),'art',now)).toEqual({});
 expect(tickerActivityOf(pieces([], [{id:'x',text:'private',status:'running',since:new Date(now).toISOString()}]),'art',now)).toEqual({});
 expect(tickerActivityOf(pieces([{text:'private',activity}]),'art',now+30000)).toEqual({});
 expect(tickerActivityOf(pieces([{text:'private',activity}]),'art',now-1)).toEqual({});
});
it('rejects raw action words and invalid/unbounded freshness at the piece boundary', () => {
 for (const bad of [{...activity,action:'pgrep secret'}, {...activity,expiresAt:new Date(now+30001).toISOString()}, {...activity,observedAt:'unknown'}, {...activity,expiresAt:activity.observedAt}])
  expect(typeof parseManifest({v:2,asks:[],agents:{art:{readings:[],doing:[{text:'private',activity:bad}]}}})).toBe('string');
});

it('only a fresh explicit idle observation proves idle', () => {
 const m=parseManifest({v:2,asks:[],agents:{art:{readings:[],idle:{observedAt:activity.observedAt,expiresAt:activity.expiresAt}}}});
 if(typeof m === 'string') throw new Error(m);
 const ps=[{piece:'runtime',path:'runtime',manifest:m}];
 expect(tickerActivityOf(ps,'art',now)).toHaveProperty('activity.action','Idle');
 expect(tickerActivityOf(ps,'art',now+30000)).toEqual({});
 expect(tickerActivityOf(pieces([]),'art',now)).toEqual({});
});
