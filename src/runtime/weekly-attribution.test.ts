import {expect, it} from 'vitest';
import {estimateWeeklyUsage} from './weekly-attribution.js';

it('allocates observed provider usage across overlapping jobs by their token rate during each interval', () => {
  const readings = [{at:0,usage:.125},{at:10,usage:.375},{at:20,usage:.625},{at:30,usage:.75}];
  const jobs = [{id:'long',start:0,end:20,tokens:200},{id:'short',start:0,end:10,tokens:300}];
  const {shares,unattributed} = estimateWeeklyUsage(readings,jobs);
  expect([...shares]).toEqual([['long',.3125],['short',.1875]]);
  expect(unattributed).toBe(.25);
});

it('starts over after a provider correction and leaves unknown token weights unassigned', () => {
  const readings = [{at:0,usage:.25},{at:10,usage:.5},{at:20,usage:.125},{at:30,usage:.25}];
  const jobs = [{id:'known',start:0,end:30,tokens:90},{id:'unknown',start:25,end:30,tokens:null}];
  const {shares,unattributed} = estimateWeeklyUsage(readings,jobs);
  expect(shares.size).toBe(0);
  expect(unattributed).toBe(.25);
});

it('counts a same-tick job at an observation boundary in exactly one interval', () => {
  const readings = [{at:0,usage:0},{at:10,usage:.5},{at:20,usage:1}];
  const long = {id:'long',start:0,end:20,tokens:20};
  const point = {id:'point',start:10,end:10,tokens:10};
  expect([...estimateWeeklyUsage(readings,[long,point]).shares]).toEqual([['long',.75],['point',.25]]);
  const unknown = estimateWeeklyUsage(readings,[long,{...point,tokens:null}]);
  expect([...unknown.shares]).toEqual([['long',.5]]);
  expect(unknown.unattributed).toBe(.5);
});
