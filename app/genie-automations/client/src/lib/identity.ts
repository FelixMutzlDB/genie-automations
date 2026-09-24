import type { Whoami } from '../types';

export async function loadWhoami(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Whoami> {
  const response = await fetcher('/api/whoami', { signal });
  if (!response.ok) return { identity: null, isAdmin: false };
  const data = (await response.json()) as { identity?: unknown; is_admin?: unknown };
  return {
    identity: typeof data.identity === 'string' && data.identity.trim() ? data.identity.trim() : null,
    isAdmin: data.is_admin === true,
  };
}

export async function loadCanonicalIdentity(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<string | null> {
  return (await loadWhoami(fetcher, signal)).identity;
}
