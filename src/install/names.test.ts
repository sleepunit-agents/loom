import { describe, it, expect } from 'vitest';
import { validateAgentName, RESERVED_AGENT_NAMES } from './names.js';

describe('validateAgentName', () => {
  it('accepts lowercase alphanumeric with hyphens', () => {
    expect(validateAgentName('art')).toEqual({ ok: true });
    expect(validateAgentName('alex-v2')).toEqual({ ok: true });
    expect(validateAgentName('a')).toEqual({ ok: true });
    expect(validateAgentName('agent-2026-04')).toEqual({ ok: true });
  });

  it('rejects empty name', () => {
    expect(validateAgentName('')).toEqual({ ok: false, reason: 'Name is empty.' });
  });

  it('rejects uppercase letters', () => {
    const r = validateAgentName('Agent');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/lowercase/);
  });

  it('rejects underscores and spaces', () => {
    expect(validateAgentName('my_agent').ok).toBe(false);
    expect(validateAgentName('my agent').ok).toBe(false);
    expect(validateAgentName('my.agent').ok).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(validateAgentName('-art').ok).toBe(false);
  });

  it('rejects names longer than 64 characters', () => {
    const long = 'a'.repeat(65);
    const r = validateAgentName(long);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/64/);
  });

  it('rejects reserved names', () => {
    for (const reserved of RESERVED_AGENT_NAMES) {
      const r = validateAgentName(reserved);
      expect(r.ok, `expected ${reserved} to be rejected`).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toMatch(/reserved/);
    }
  });

  it('reserved list contains the documented slots', () => {
    expect([...RESERVED_AGENT_NAMES].sort()).toEqual(
      ['backups', 'cache', 'config', 'current', 'default', 'shared', 'tmp'],
    );
  });
});
