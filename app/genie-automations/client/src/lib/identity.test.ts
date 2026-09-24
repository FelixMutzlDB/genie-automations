import { describe, expect, it, vi } from 'vitest';
import { loadCanonicalIdentity, loadWhoami } from './identity';

describe('loadCanonicalIdentity', () => {
  it('uses only the canonical whoami identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ identity: ' canonical@example.com ', proposals_identity: 'other@example.com' }), {
        status: 200,
      })
    );

    await expect(loadCanonicalIdentity(fetcher)).resolves.toBe('canonical@example.com');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/api/whoami', { signal: undefined });
  });

  it('resolves to no identity after a non-success response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(loadCanonicalIdentity(fetcher)).resolves.toBeNull();
  });
});

describe('loadWhoami', () => {
  it('uses whoami as the sole admin-status source', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ identity: 'admin@example.com', is_admin: true }), { status: 200 })
    );

    await expect(loadWhoami(fetcher)).resolves.toEqual({ identity: 'admin@example.com', isAdmin: true });
    expect(fetcher).toHaveBeenCalledWith('/api/whoami', { signal: undefined });
  });
});
