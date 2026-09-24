import { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingDigest, canonicalJson, configHash } from './canonical';
import { ConfigResolutionError, configureTaskConfigResolver, resolveTaskConfig } from './resolveTaskConfig';

const binding = {
  task_id: 'receivables-eu',
  dest_catalog: 'catalog',
  dest_schema: 'finance',
  dest_table: 'allocation',
  write_scope: { change_types: ['allocation_upsert'] },
  identity_ref: 'obo_user',
};
const payload = { binding_digest: bindingDigest(binding), settings: { ingest_enabled: true } };
const hash = configHash(payload);

function req(): Request {
  return { header: (name: string) => (name === 'x-forwarded-email' ? 'alice@example.com' : undefined) } as Request;
}
function row(overrides: Record<string, unknown> = {}) {
  return {
    ...binding,
    binding_id: 'binding-1',
    task_type: 'receivables',
    version_hash: hash,
    payload,
    computed_hash: hash,
    computed_binding_digest: payload.binding_digest,
    config_status: 'published',
    active_version_hash: hash,
    binding_status: 'active',
    ...overrides,
  };
}
function configure(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  configureTaskConfigResolver({ lakebase: { asUser: () => ({ query }) } });
  return query;
}

describe('canonical governance hashes', () => {
  it('matches the shared PostgreSQL jsonb::text test vector deterministically', () => {
    expect(canonicalJson({ b: [2, 3], a: 1 })).toBe('{"a": 1, "b": [2, 3]}');
    expect(configHash({ b: [2, 3], a: 1 })).toBe('fd28b17488e0d3ec39d085da9a7acf40e0a6e4f3bbc310f112a1e4c5490394fc');
  });
});

describe('resolveTaskConfig', () => {
  beforeEach(() => {
    process.env['CONFIG_DESTINATION_ALLOWLIST'] = 'catalog.finance.allocation';
  });

  it('returns a credential-free execution spec for the exact active published version', async () => {
    configure([row()]);
    const spec = await resolveTaskConfig(req(), binding.task_id, hash, 'allocation_upsert');
    expect(spec.destination.fullyQualifiedName).toBe('catalog.finance.allocation');
    expect(spec).not.toHaveProperty('credentials');
  });

  it('resolves the seeded vendor modification scope without enabling vendor ingest', async () => {
    process.env['CONFIG_DESTINATION_ALLOWLIST'] = 'catalog.finance.vendor_bank_detail';
    configure([
      row({
        task_id: 'vendor-bank-eu',
        task_type: 'vendor_bank',
        dest_table: 'vendor_bank_detail',
        write_scope: { change_types: ['vendor_bank_update'] },
        payload: { ...payload, settings: { ingest_enabled: false } },
      }),
    ]);
    await expect(resolveTaskConfig(req(), 'vendor-bank-eu', hash, 'vendor_bank_update')).resolves.toMatchObject({
      taskType: 'vendor_bank',
      settings: { ingest_enabled: false },
      destination: { table: 'vendor_bank_detail' },
    });
  });

  it.each([
    ['retired', { config_status: 'retired' }, 'config_not_published'],
    ['unpublished', { config_status: 'draft' }, 'config_not_published'],
    ['wrong scope', { write_scope: { change_types: ['other'] } }, 'wrong_scope'],
  ])('rejects %s config', async (_label, overrides, code) => {
    configure([row(overrides)]);
    await expect(resolveTaskConfig(req(), binding.task_id, hash, 'allocation_upsert')).rejects.toMatchObject({ code });
  });

  it('rejects a non-allowlisted destination', async () => {
    process.env['CONFIG_DESTINATION_ALLOWLIST'] = 'catalog.finance.other';
    configure([row()]);
    await expect(resolveTaskConfig(req(), binding.task_id, hash, 'allocation_upsert')).rejects.toMatchObject({
      code: 'destination_not_allowed',
    });
  });

  it('requires active config for new work but permits a published pinned version to finish', async () => {
    configure([row({ active_version_hash: 'f'.repeat(64) })]);
    await expect(resolveTaskConfig(req(), binding.task_id, hash, 'allocation_upsert')).rejects.toMatchObject({
      code: 'config_not_active',
    });
    await expect(resolveTaskConfig(req(), binding.task_id, hash, 'allocation_upsert', false)).resolves.toMatchObject({
      configVersionHash: hash,
    });
  });

  it('fails closed for cross-task or non-member lookups', async () => {
    const query = configure([]);
    await expect(resolveTaskConfig(req(), 'other-task', hash, 'allocation_upsert')).rejects.toBeInstanceOf(
      ConfigResolutionError
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('tm.task_id=t.task_id'), [
      'other-task',
      'alice@example.com',
      hash,
    ]);
  });
});
