import { createHash, randomUUID } from 'node:crypto';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['csv', 'xlsx']);

export interface IngestTaskGate {
  is_member: boolean;
  ingest_enabled: boolean;
  target_catalog: string | null;
  target_schema: string | null;
  target_table: string | null;
}

export type GateFailure = 'not_member' | 'ingest_disabled' | 'target_unbound' | null;

export function ingestGateFailure(task: IngestTaskGate | undefined): GateFailure {
  if (!task?.is_member) return 'not_member';
  if (!task.ingest_enabled) return 'ingest_disabled';
  if (!task.target_catalog || !task.target_schema || !task.target_table) return 'target_unbound';
  return null;
}

export function safeExtension(filename: string): 'csv' | 'xlsx' | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const extension = match?.[1]?.toLowerCase();
  return extension && ALLOWED_EXTENSIONS.has(extension) ? (extension as 'csv' | 'xlsx') : null;
}

export function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function uploadPath(taskId: string, digest: string, extension: 'csv' | 'xlsx'): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(taskId)) throw new Error('invalid task id');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid SHA-256');
  return `${taskId}/${digest}/original.${extension}`;
}

export function newParseId(): string {
  return randomUUID();
}
