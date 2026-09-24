import type { ConfigRequest, OwnerSettings, TaskConfig } from '../types';

async function api<T>(url: string, init?: RequestInit, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'The request could not be completed.');
  }
  return body;
}

export function loadTaskConfig(taskId: string, fetcher?: typeof fetch): Promise<TaskConfig> {
  return api(`/api/tasks/${encodeURIComponent(taskId)}/config`, undefined, fetcher);
}

export function saveConfigDraft(taskId: string, settings: OwnerSettings, fetcher?: typeof fetch): Promise<unknown> {
  return api(
    `/api/tasks/${encodeURIComponent(taskId)}/config/draft`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) },
    fetcher
  );
}

export function submitConfigDraft(taskId: string, fetcher?: typeof fetch): Promise<unknown> {
  return api(`/api/tasks/${encodeURIComponent(taskId)}/config/submit`, { method: 'POST' }, fetcher);
}

export function loadConfigRequests(fetcher?: typeof fetch): Promise<ConfigRequest[]> {
  return api('/api/admin/config-requests', undefined, fetcher);
}

export async function loadAllowedDestinations(fetcher?: typeof fetch): Promise<string[]> {
  const result = await api<{ destinations: string[] }>('/api/admin/config-destinations', undefined, fetcher);
  return result.destinations;
}

export function proposeBinding(taskId: string, destination: string, fetcher?: typeof fetch): Promise<unknown> {
  const [dest_catalog, dest_schema, dest_table] = destination.split('.');
  return api(
    `/api/admin/tasks/${encodeURIComponent(taskId)}/bindings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest_catalog, dest_schema, dest_table }),
    },
    fetcher
  );
}

export function approveBinding(taskId: string, bindingId: string, fetcher?: typeof fetch): Promise<unknown> {
  return api(
    `/api/admin/tasks/${encodeURIComponent(taskId)}/bindings/${encodeURIComponent(bindingId)}/approve`,
    { method: 'POST' },
    fetcher
  );
}

export function publishConfig(taskId: string, hash: string, fetcher?: typeof fetch): Promise<unknown> {
  return api(
    `/api/admin/tasks/${encodeURIComponent(taskId)}/config/${encodeURIComponent(hash)}/publish`,
    { method: 'POST' },
    fetcher
  );
}

export function retireConfig(taskId: string, hash: string, fetcher?: typeof fetch): Promise<unknown> {
  return api(
    `/api/admin/tasks/${encodeURIComponent(taskId)}/config/${encodeURIComponent(hash)}/retire`,
    { method: 'POST' },
    fetcher
  );
}
