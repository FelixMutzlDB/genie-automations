import { describe, expect, it, vi } from 'vitest';
import {
  loadReminderConfig,
  loadReminderPreview,
  REMINDER_LOAD_ERROR,
  REMINDER_SAVE_ERROR,
  saveReminderConfig,
} from './reminders';

const config = {
  enabled: true,
  cadence: 'daily' as const,
  due_offset_days: 2,
  default_due_at: null,
  approach_offsets: [7, 2],
  post_due_offsets: [1, 7, 14],
  quiet_hours_start: '18:00',
  quiet_hours_end: '08:00',
  timezone: 'Europe/Berlin',
};

describe('reminder client errors', () => {
  it('never exposes SQLSTATE, driver details, raw JSON, or stack traces while loading', async () => {
    const technical = 'SQLSTATE 42501: pg driver failed\n at Pool.query (private.js:42)';
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: technical }), { status: 500 }));

    await expect(loadReminderConfig('task', fetcher)).rejects.toThrow(REMINDER_LOAD_ERROR);
    await expect(loadReminderPreview('task', fetcher)).rejects.toThrow(REMINDER_LOAD_ERROR);
    expect(REMINDER_LOAD_ERROR).not.toMatch(/SQLSTATE|42501|driver|Pool\.query|private\.js|\{|stack/i);
  });

  it('uses a fixed human message for failed saves', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"error":"duplicate key 23505"}', { status: 500 }));
    await expect(saveReminderConfig('task', config, fetcher)).rejects.toThrow(REMINDER_SAVE_ERROR);
    expect(REMINDER_SAVE_ERROR).not.toMatch(/23505|duplicate|\{/i);
  });
});
