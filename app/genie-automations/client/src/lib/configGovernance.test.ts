import { describe, expect, it, vi } from 'vitest';
import { approveBinding, proposeBinding, publishConfig, retireConfig } from './configGovernance';

function okFetcher() {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
}

describe('admin config governance actions', () => {
  it('proposes an allowlisted destination through the binding endpoint', async () => {
    const fetcher = okFetcher();
    await proposeBinding('task 1', 'catalog.schema.table', fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/admin/tasks/task%201/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest_catalog: 'catalog', dest_schema: 'schema', dest_table: 'table' }),
    });
  });

  it.each([
    [approveBinding, '/api/admin/tasks/task/bindings/binding/approve'],
    [publishConfig, '/api/admin/tasks/task/config/hash/publish'],
    [retireConfig, '/api/admin/tasks/task/config/hash/retire'],
  ])('posts the action to the protected endpoint', async (action, url) => {
    const fetcher = okFetcher();
    await action('task', action === approveBinding ? 'binding' : 'hash', fetcher);
    expect(fetcher).toHaveBeenCalledWith(url, { method: 'POST' });
  });
});
