import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(', ')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${canonicalJson(object[key])}`)
    .join(', ')}}`;
}

export function configHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function bindingDigest(binding: {
  task_id: string;
  dest_catalog: string;
  dest_schema: string;
  dest_table: string;
  write_scope: unknown;
  identity_ref: string;
}): string {
  return configHash(binding);
}
