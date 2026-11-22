import { expect, it } from 'vitest';
import { guestIoHundredths, readGuestIoPressure } from './guest-io-pressure.js';

it('reads the sixty-second some average even when full is reported first', () => {
  expect(guestIoHundredths('full avg60=1.11\nsome avg10=13.42 avg60=39.99 avg300=89.99 total=123\n')).toBe(3999);
  expect(guestIoHundredths('some avg60=0.00')).toBe(0);
  expect(guestIoHundredths('some avg60=100.00')).toBe(10000);
});

it('keeps missing, malformed and ambiguous measurements unknown', () => {
  for (const input of ['', 'full avg60=0.00', 'some avg60=100.01', 'some avg60=1x50',
    'some avg60=1.23 avg60=2.34', 'some avg60=1.23\nsome avg60=2.34']) {
    expect(guestIoHundredths(input)).toBeUndefined();
  }
  expect(readGuestIoPressure('../103')).toBeUndefined();
});
