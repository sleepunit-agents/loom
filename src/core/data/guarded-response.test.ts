import { expect, it } from 'vitest';
import { guardedResponse, responseAvailability } from './guarded-response.js';

it('keeps the exact guard on wrapped responses and both native clone branches', async () => {
  let allowed = true;
  const guard = () => allowed;
  const response = new Response(guardedResponse('PRIVATE WORDS', {}, guard).body);
  response.headers.set('x-fixture', 'kept');
  const copy = response.clone();
  expect(responseAvailability(response)).toBe(guard);
  expect(responseAvailability(copy)).toBe(guard);
  expect(response.headers.get('x-fixture')).toBe('kept');
  allowed = false;
  await expect(response.text()).rejects.toThrow('Data access ended');
  await expect(copy.text()).rejects.toThrow('Data access ended');
});
it('lets an outer transport retain the lease after consuming the nested body', async () => {
  let current = true;
  const nested = guardedResponse(JSON.stringify({ words: 'PRIVATE WORDS' }), {}, () => current);
  const lease = responseAvailability(nested)!;
  const value = await nested.json();
  const outer = guardedResponse(JSON.stringify({result:value}), {}, lease);
  current = false;
  expect(lease()).toBe(false);
  await expect(outer.text()).rejects.toThrow('Data access ended');
  expect(responseAvailability(new Response('unguarded'))).toBeUndefined();
  expect(responseAvailability(new Response(null))).toBeUndefined();
});
