import {expect,it} from 'vitest';
import {localDate,nextTime,timesOnDate} from './calendar.js';

it.each([
  ['2026-03-08',['2026-03-08T07:30:00.000Z','2026-03-08T08:30:00.000Z']],
  ['2026-11-01',['2026-11-01T06:30:00.000Z','2026-11-01T08:30:00.000Z','2026-11-01T09:30:00.000Z']],
] as const)('lists the same Sunday instants as the scheduler on %s', (date,expected)=>{
  const times='02:30,03:30,01:30,01:30', zone='America/Chicago';
  const instants=timesOnDate(times,'weekends',date,zone);
  expect(instants.map(at=>new Date(at).toISOString())).toEqual(expected);
  let after=Date.parse(date+'T00:00:00Z');
  for(const instant of instants){expect(nextTime(times,'weekends',after,zone)).toBe(instant);after=instant;}
  expect(timesOnDate(times,'weekdays',date,zone)).toEqual([]);
});

it('places an offset timestamp on the household date and rejects an impossible date',()=>{
  const at='2026-11-02T00:15:00+09:00',zone='America/Chicago';
  expect(timesOnDate(at,null,'2026-11-01',zone)).toEqual([Date.parse(at)]);
  expect(timesOnDate(at,null,'2026-11-02',zone)).toEqual([]);
  expect(()=>timesOnDate(at,null,'2026-02-30',zone)).toThrow('Invalid calendar date');
});

it('uses the current household zone after a change or a rejected zone',()=>{
  const midnight=Date.parse('2026-11-01T03:00:00Z');
  expect(localDate(midnight,'America/Chicago')).toBe('2026-10-31');
  expect(localDate(midnight,'Asia/Tokyo')).toBe('2026-11-01');
  expect(()=>localDate(midnight,'Not/A_Zone')).toThrow(RangeError);
  expect(localDate(midnight,'America/Chicago')).toBe('2026-10-31');
});
