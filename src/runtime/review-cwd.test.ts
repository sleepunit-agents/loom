import { expect, it } from 'vitest';
import { frozenReviewCwd } from './review-cwd.js';

it('starts a frozen review\'s harness outside its copy: the scratch directory, else the house\'s, never /review', () => {
  expect(frozenReviewCwd('/home/agent/repo', '/tmp')).toBe('/tmp');
  expect(frozenReviewCwd('/home/agent/repo', undefined)).toBe('/home/agent/repo');
  expect(frozenReviewCwd('/home/agent/repo', '/review/tree')).toBe('/home/agent/repo');
  expect(frozenReviewCwd('/home/agent/repo', 'relative')).toBe('/home/agent/repo');
  for (const cwd of ['/review', '/review/tree', '/review/../review/tree', '/review/'])
    expect(() => frozenReviewCwd(cwd, undefined)).toThrow('may not start in its copy');
  expect(frozenReviewCwd('/reviewer', undefined)).toBe('/reviewer');
});
