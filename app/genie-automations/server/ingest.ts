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

export function validCsvBytes(raw: Buffer): boolean {
  if (raw.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (!text.trim()) return false;
    let controls = 0;
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls += 1;
    }
    return controls / text.length < 0.01;
  } catch {
    // The unchanged parser also supports cp1252. Reject bytes that are clearly
    // binary while allowing that declared text fallback.
    let controls = 0;
    for (const byte of raw) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls += 1;
    return controls / raw.length < 0.01;
  }
}

export function isAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const rawMessage = record['message'];
  const rawCode = record['code'] ?? record['error_code'];
  const message = error instanceof Error ? error.message : typeof rawMessage === 'string' ? rawMessage : '';
  const code = typeof rawCode === 'string' ? rawCode : '';
  const status = record['status'] ?? record['statusCode'];
  return status === 409 || /ALREADY_EXISTS|RESOURCE_ALREADY_EXISTS/i.test(code) || /already exists/i.test(message);
}

export type ParseRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export function parseRunStatus(run: Record<string, unknown>): ParseRunStatus {
  const state = run['state'];
  if (!state || typeof state !== 'object') return 'pending';
  const values = state as Record<string, unknown>;
  const rawLifecycle = values['life_cycle_state'];
  const rawResult = values['result_state'];
  const lifecycle = typeof rawLifecycle === 'string' ? rawLifecycle : 'PENDING';
  const result = typeof rawResult === 'string' ? rawResult : '';
  if (lifecycle === 'TERMINATED') return result === 'SUCCESS' ? 'succeeded' : 'failed';
  if (lifecycle === 'INTERNAL_ERROR' || lifecycle === 'SKIPPED') return 'failed';
  if (lifecycle === 'RUNNING' || lifecycle === 'TERMINATING') return 'running';
  return 'pending';
}

export function uploadPath(taskId: string, digest: string, extension: 'csv' | 'xlsx'): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(taskId)) throw new Error('invalid task id');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid SHA-256');
  return `${taskId}/${digest}/original.${extension}`;
}

export function newParseId(): string {
  return randomUUID();
}
