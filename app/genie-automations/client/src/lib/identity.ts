export async function loadCanonicalIdentity(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<string | null> {
  const response = await fetcher('/api/whoami', { signal });
  if (!response.ok) return null;
  const data = (await response.json()) as { identity?: unknown };
  return typeof data.identity === 'string' && data.identity.trim() ? data.identity.trim() : null;
}
