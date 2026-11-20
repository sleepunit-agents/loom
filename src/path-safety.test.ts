import { describe, it, expect } from 'vitest';
import { pathSegmentError } from './path-safety.js';

describe('pathSegmentError', () => {
  it.each([
    '',
    '.',
    '..',
    '../escape',
    '../../../home/user/secrets',
    'foo/bar',
    'foo\\bar',
    '\\\\server\\share',
    'foo\0bar',
  ])('rejects %j', (value) => {
    const error = pathSegmentError(value, 'role');
    expect(error).toMatch(/Invalid role/);
    expect(error).toMatch(/path separators/);
  });

  it.each([
    'claude-code',
    'gemini-cli',
    'wonder',
    'self-model',
    'claude-opus-4.5',
    '...three-dots-is-a-name',
  ])('accepts %j', (value) => {
    expect(pathSegmentError(value, 'role')).toBeNull();
  });

  it('names the offending param in the error', () => {
    expect(pathSegmentError('../x', 'model')).toContain('Invalid model');
    expect(pathSegmentError('', 'client')).toContain('Invalid client');
  });
});
