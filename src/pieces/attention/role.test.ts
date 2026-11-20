import { describe, expect, it, vi } from 'vitest';
import { attentionRole } from './role.js';
import type { Operations, Result, Viewer } from '../../core/index.js';

describe('attention role', () => {
  it('preserves viewer, payload, operation id and failure on the direct door', () => {
    const denied: Result = { ok: false, code: 'denied', message: 'Permission denied' };
    const call = vi.fn<Operations['call']>(() => denied);
    const role = attentionRole({ call });
    const viewer: Viewer = { kind: 'agent', id: 'art' };
    const input = { id: 'approval:a-1', agent: 'art', ask: 'Allow this?', source: { kind: 'approval' as const, id: 'a-1' } };
    expect(role.raise(viewer, input, 'raise-1')).toBe(denied);
    expect(call).toHaveBeenLastCalledWith('direct', viewer, 'attention.raise', input, 'raise-1');
    role.answer(viewer, { id: input.id, answer: { kind: 'yes' } }, 'answer-1');
    expect(call).toHaveBeenLastCalledWith('direct', viewer, 'attention.answer', { id: input.id, answer: { kind: 'yes' } }, 'answer-1');
    role.resolve(viewer, { id: input.id, reason: 'Approval answered' }, 'resolve-1');
    expect(call).toHaveBeenLastCalledWith('direct', viewer, 'attention.resolve', { id: input.id, reason: 'Approval answered' }, 'resolve-1');
    role.get(viewer, { id: input.id });
    expect(call).toHaveBeenLastCalledWith('direct', viewer, 'attention.get', { id: input.id });
    const status = { id: 'art', agent: 'art', state: 'working' as const, work: 'Building the desk', jobs: [], watched: [] };
    role.reportStatus(viewer, status, 'status-1');
    expect(call).toHaveBeenLastCalledWith('direct', viewer, 'attention.reportStatus', status, 'status-1');
  });
});
