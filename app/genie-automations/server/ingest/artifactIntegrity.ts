import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function calculateArtifactHash(artifact: object): string {
  const record = artifact as Record<string, unknown>;
  const withoutEmbeddedHash = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'artifact_hash'));
  return createHash('sha256').update(canonicalJson(withoutEmbeddedHash)).digest('hex');
}
