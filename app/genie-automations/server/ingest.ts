import { createHash, randomUUID } from 'node:crypto';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export type IngestExtension = 'csv' | 'xlsx' | 'png' | 'jpg' | 'jpeg';
export type ExtractionKind = 'deterministic' | 'probabilistic_image';
export type DetectedIngestType = 'csv' | 'xlsx' | 'png' | 'jpeg';
const ALLOWED_EXTENSIONS = new Set<IngestExtension>(['csv', 'xlsx', 'png', 'jpg', 'jpeg']);

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

export function safeExtension(filename: string): IngestExtension | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const extension = match?.[1]?.toLowerCase();
  return extension && ALLOWED_EXTENSIONS.has(extension as IngestExtension) ? (extension as IngestExtension) : null;
}

export function extractionKind(detected: DetectedIngestType): ExtractionKind {
  return detected === 'csv' || detected === 'xlsx' ? 'deterministic' : 'probabilistic_image';
}

export function detectIngestType(raw: Buffer): DetectedIngestType | null {
  if (raw.length >= 8 && raw.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (raw.length >= 4 && raw[0] === 0xff && raw[1] === 0xd8 && raw[raw.length - 2] === 0xff && raw[raw.length - 1] === 0xd9)
    return 'jpeg';
  if (raw.length >= 4 && raw.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) return 'xlsx';
  if (validCsvBytes(raw)) return 'csv';
  return null;
}

export function extensionMatchesDetectedType(extension: IngestExtension, detected: DetectedIngestType): boolean {
  return extension === detected || ((extension === 'jpg' || extension === 'jpeg') && detected === 'jpeg');
}

export function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function validCsvBytes(raw: Buffer): boolean {
  if (raw.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    try {
      text = new TextDecoder('windows-1252', { fatal: true }).decode(raw);
    } catch {
      return false;
    }
  }
  if (!text.trim()) return false;
  for (const character of text) {
    const code = character.charCodeAt(0);
    const forbiddenControl = (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159);
    if (forbiddenControl || code === 0xfffd) return false;
  }

  const delimiters = [',', ';', '\t', '|'];
  return delimiters.some((delimiter) => {
    const widths = csvRecordWidths(text, delimiter);
    return widths !== null && widths.length >= 2 && widths[0] >= 2 && widths.every((width) => width === widths[0]);
  });
}

function csvRecordWidths(text: string, delimiter: string): number[] | null {
  const widths: number[] = [];
  let fields = 1;
  let inQuotes = false;
  let recordHasContent = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
      recordHasContent = true;
    } else if (!inQuotes && character === delimiter) {
      fields += 1;
      recordHasContent = true;
    } else if (!inQuotes && (character === '\n' || character === '\r')) {
      if (recordHasContent) widths.push(fields);
      fields = 1;
      recordHasContent = false;
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else if (!/\s/u.test(character)) {
      recordHasContent = true;
    }
  }
  if (inQuotes) return null;
  if (recordHasContent) widths.push(fields);
  return widths;
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

export function uploadPath(taskId: string, digest: string, extension: IngestExtension): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(taskId)) throw new Error('invalid task id');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid SHA-256');
  return `${taskId}/${digest}/original.${extension}`;
}

export function newParseId(): string {
  return randomUUID();
}
