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

  it('holds exact scheduled, approaching, and overdue boundaries', () => {
    const due = new Date('2026-10-10T00:00:00.000Z');
    expect(stateAt(new Date('2026-10-02T23:59:59.999Z'), due, policy.approachOffsets)).toBe('scheduled');
    expect(stateAt(new Date('2026-10-03T00:00:00.000Z'), due, policy.approachOffsets)).toBe('approaching_due');
    expect(stateAt(new Date('2026-10-09T23:59:59.999Z'), due, policy.approachOffsets)).toBe('approaching_due');
    expect(stateAt(due, due, policy.approachOffsets)).toBe('overdue');
  });

  it('chooses the next approach, due, or post-due checkpoint', () => {
    const due = new Date('2026-10-10T00:00:00.000Z');
    expect(nextCheckAt(new Date('2026-10-03T00:00:00.000Z'), due, policy)?.toISOString()).toBe(
      '2026-10-04T00:00:00.000Z'
    );
    expect(nextCheckAt(new Date('2026-10-25T00:00:00.000Z'), due, policy)).toBeNull();
  });
});
