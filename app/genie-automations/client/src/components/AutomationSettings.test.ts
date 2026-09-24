import { describe, expect, it } from 'vitest';
import type { Task, TaskConfig } from '../types';
import { canUseIngest, governanceLabel } from '../lib/governanceState';

const task = { governance_status: 'active' } as Task;
const config = {
  binding_status: 'active',
  active_version_hash: 'abc',
  active_settings: {
    ingest_enabled: true,
    validation_thresholds: { over_allocation_ceiling: 1, structural_confidence_floor: 0.8 },
    header_aliases: {},
  },
} as TaskConfig;

describe('automation settings governance gating', () => {
  it('humanizes every governance status', () => {
    expect(['unbound', 'awaiting_approval', 'active', 'retired'].map((status) => governanceLabel(status as Task['governance_status']))).toEqual([
      'Unbound', 'Awaiting approval', 'Active', 'Retired',
    ]);
  });

  it('enables ingest only with an active binding and published active configuration', () => {
    expect(canUseIngest(task, config)).toBe(true);
    expect(canUseIngest({ ...task, governance_status: 'awaiting_approval' }, config)).toBe(false);
    expect(canUseIngest(task, { ...config, binding_status: 'pending' })).toBe(false);
    expect(canUseIngest(task, { ...config, active_version_hash: null })).toBe(false);
    expect(canUseIngest(task, { ...config, active_settings: { ...config.active_settings!, ingest_enabled: false } })).toBe(false);
  });
});
