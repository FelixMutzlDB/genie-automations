import { describe, expect, it } from 'vitest';
import { dueAtFor, nextCheckAt, stateAt, type ChasePolicy } from './chase';

const policy: ChasePolicy = {
  cadence: 'daily',
  dueOffsetDays: 2,
  defaultDueAt: null,
  approachOffsets: [7, 2],
  postDueOffsets: [1, 7, 14],
  timezone: 'Europe/Berlin',
};

describe('chase due-date and state computation', () => {
  it('derives period month-end plus the owner offset in the configured timezone', () => {
    expect(dueAtFor('2026-09', policy)?.toISOString()).toBe('2026-10-01T22:00:00.000Z');
  });

  it('uses the optional default only when the accounting period cannot be parsed', () => {
    expect(dueAtFor('not-a-period', { ...policy, defaultDueAt: '2026-10-10T12:00:00.000Z' })?.toISOString()).toBe(
      '2026-10-10T12:00:00.000Z'
    );
    expect(dueAtFor('not-a-period', policy)).toBeNull();
  });

  it('accepts a YYYY-MM-DD accounting period as the due-date base', () => {
    expect(dueAtFor('2026-03-28', policy)?.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  it('holds exact scheduled, approaching, and overdue boundaries', () => {
    const due = new Date('2026-10-10T00:00:00.000Z');
    expect(stateAt(new Date('2026-10-02T23:59:59.999Z'), due, policy.approachOffsets, policy.timezone)).toBe(
      'scheduled'
    );
    expect(stateAt(new Date('2026-10-03T00:00:00.000Z'), due, policy.approachOffsets, policy.timezone)).toBe(
      'approaching_due'
    );
    expect(stateAt(new Date('2026-10-09T23:59:59.999Z'), due, policy.approachOffsets, policy.timezone)).toBe(
      'approaching_due'
    );
    expect(stateAt(due, due, policy.approachOffsets, policy.timezone)).toBe('overdue');
  });

  it('keeps approach boundaries at local midnight across the spring DST transition', () => {
    const due = new Date('2026-03-31T22:00:00.000Z'); // 1 April, 00:00 Europe/Berlin
    const dstPolicy = { ...policy, cadence: 'weekly' as const, approachOffsets: [3] };
    const boundary = new Date('2026-03-28T23:00:00.000Z'); // 29 March, 00:00 Europe/Berlin

    expect(stateAt(new Date(boundary.getTime() - 1), due, [3], policy.timezone)).toBe('scheduled');
    expect(stateAt(boundary, due, [3], policy.timezone)).toBe('approaching_due');
    expect(nextCheckAt(new Date('2026-03-28T22:00:00.000Z'), due, dstPolicy)?.toISOString()).toBe(
      boundary.toISOString()
    );
  });

  it('chooses the next approach, due, or post-due checkpoint', () => {
    const due = new Date('2026-10-10T00:00:00.000Z');
    expect(nextCheckAt(new Date('2026-10-03T00:00:00.000Z'), due, policy)?.toISOString()).toBe(
      '2026-10-04T00:00:00.000Z'
    );
    expect(nextCheckAt(new Date('2026-10-25T00:00:00.000Z'), due, policy)).toBeNull();
  });
});
