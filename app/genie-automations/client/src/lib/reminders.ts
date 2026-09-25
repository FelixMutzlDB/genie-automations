import type { ChaseApprovalBatch, ReminderConfig, ReminderPreview } from '../types';

export const REMINDER_LOAD_ERROR = "We couldn't load reminders right now. Try again.";
export const REMINDER_SAVE_ERROR = "We couldn't save that reminder schedule. Nothing was changed.";
export const REMINDER_REFRESH_ERROR = "We couldn't refresh the reminder preview. Nothing was sent.";
export const REMINDER_APPROVAL_ERROR = "We couldn't save that reminder decision. Nothing was changed.";

async function request<T>(
  path: string,
  fallback: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) throw new Error(fallback);
  return (await response.json()) as T;
}

export function loadReminderConfig(
  taskId: string,
  fetcher?: typeof fetch
): Promise<{ config: ReminderConfig | null; can_edit: boolean }> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/reminders/config`, REMINDER_LOAD_ERROR, undefined, fetcher);
}

export function saveReminderConfig(
  taskId: string,
  config: ReminderConfig,
  fetcher?: typeof fetch
): Promise<ReminderConfig> {
  return request(
    `/api/tasks/${encodeURIComponent(taskId)}/reminders/config`,
    REMINDER_SAVE_ERROR,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) },
    fetcher
  );
}

export function evaluateReminders(taskId: string, fetcher?: typeof fetch): Promise<{ item_count: number }> {
  return request(
    `/api/tasks/${encodeURIComponent(taskId)}/reminders/evaluate`,
    REMINDER_REFRESH_ERROR,
    { method: 'POST' },
    fetcher
  );
}

export function loadReminderPreview(taskId: string, fetcher?: typeof fetch): Promise<ReminderPreview> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/reminders/preview`, REMINDER_LOAD_ERROR, undefined, fetcher);
}

export function loadChaseApprovalQueue(fetcher?: typeof fetch): Promise<{ batches: ChaseApprovalBatch[] }> {
  return request('/api/reminders/approval-queue', REMINDER_LOAD_ERROR, undefined, fetcher);
}

export function reviewChaseBatch(
  batchId: string,
  action: 'approve' | 'archive',
  note = '',
  fetcher?: typeof fetch
): Promise<{ message: string }> {
  return request(
    `/api/reminders/batches/${encodeURIComponent(batchId)}/action`,
    REMINDER_APPROVAL_ERROR,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, note, confirmed: true }),
    },
    fetcher
  );
}
