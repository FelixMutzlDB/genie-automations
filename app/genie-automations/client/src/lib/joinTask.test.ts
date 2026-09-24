import { describe, expect, it, vi } from 'vitest';
import { joinAndReloadTasks } from './joinTask';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('joinAndReloadTasks', () => {
  it('parses a successful join and refreshes task membership', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, role: 'member' }))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1', role: 'member' }]));

    const result = await joinAndReloadTasks('task-1', fetcher);

    expect(result).toEqual({ joined: true, role: 'member', tasks: [{ task_id: 'task-1', role: 'member' }] });
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/tasks');
  });

  it('treats an ambiguous join failure as success when refreshed membership exists', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed'))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1', role: 'member' }]));

    await expect(joinAndReloadTasks('task-1', fetcher)).resolves.toMatchObject({ joined: true });
  });

  it('reports failure only when refreshed membership is absent', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'safe message' }, 500))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1', role: null }]));

    await expect(joinAndReloadTasks('task-1', fetcher)).resolves.toMatchObject({ joined: false });
  });

  it('rejects a malformed refreshed task payload explicitly', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, role: 'member' }))
      .mockResolvedValueOnce(jsonResponse({ tasks: [] }));

    await expect(joinAndReloadTasks('task-1', fetcher)).rejects.toThrow('Invalid tasks response');
  });
});
