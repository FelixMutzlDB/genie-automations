import type { Task, TaskConfig } from '../types';

export function governanceLabel(status: Task['governance_status']): string {
  return {
    unbound: 'Unbound',
    awaiting_approval: 'Awaiting approval',
    active: 'Active',
    retired: 'Retired',
  }[status];
}

export function canUseIngest(task: Task, config: TaskConfig): boolean {
  return (
    task.governance_status === 'active' &&
    config.binding_status === 'active' &&
    Boolean(config.active_version_hash) &&
    config.active_settings?.ingest_enabled === true
  );
}

export function shouldShowAdminSurface(isAdmin: boolean): boolean {
  return isAdmin;
}
