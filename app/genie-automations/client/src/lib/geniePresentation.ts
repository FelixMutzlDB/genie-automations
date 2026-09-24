export interface GeniePresentationMessage {
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  error?: string;
  attachments: Array<{
    attachmentId?: string;
    query?: { query?: string };
    text?: { content?: string };
    suggestedQuestions?: string[];
  }>;
  queryResults: Map<
    string,
    {
      manifest: { schema: { columns: Array<{ name: string }> } };
      result: { data_array: (string | null)[][] };
    }
  >;
}

export interface PresentedAnswer {
  answer: string;
  kind: 'answer' | 'clarification' | 'error';
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
  suggestedQuestions: string[];
}

const MAX_ANSWER_LENGTH = 800;
const MAX_SUGGESTION_LENGTH = 180;
const SAFE_ANSWER_FALLBACK = 'Genie could not provide a safe text response. Try one of the suggested questions.';
const TECHNICAL_LINE =
  /(?:\bSQLSTATE\b|\bJDBC\b|\bODBC\b|\b(?:stack\s*trace|traceback)\b|\b(?:request|statement|trace|correlation)_?id\b|\b(?:error_code|error_class|exception)\b|^\s*at\s+[\w$.<>]+\s*\([^)]*:\d+(?::\d+)?\))/i;
const INTERNAL_FIELD_DUMP = /^\s*["']?[\w.-]+["']?\s*:\s*(?:["'{[]|null\b|true\b|false\b|-?\d)/i;

function removeJsonBlobs(value: string): string {
  let output = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = output.replace(/\{[^{}]{0,2000}\}|\[[^[\]]{0,2000}\]/g, ' ');
    if (next === output) break;
    output = next;
  }
  return output;
}

export function sanitizeGenieText(value: unknown, fallback = '', maxLength = MAX_ANSWER_LENGTH): string {
  if (typeof value !== 'string') return fallback;
  const boundedInput = [...value.slice(0, maxLength * 4)]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && character !== '\n' && character !== '\r' && character !== '\t' || code === 127
        ? ' '
        : character;
    })
    .join('');
  const withoutCodeBlocks = boundedInput.replace(/```[\s\S]{0,4000}?```/g, ' ');
  const withoutJson = removeJsonBlobs(withoutCodeBlocks);
  const cleanLines = withoutJson.split(/\r?\n/).flatMap((line) => {
    const technicalIndex = line.search(TECHNICAL_LINE);
    const humanPrefix = technicalIndex >= 0 ? line.slice(0, technicalIndex) : line;
    if (INTERNAL_FIELD_DUMP.test(humanPrefix)) return [];
    return humanPrefix;
  });
  const clean = cleanLines
    .join(' ')
    .replace(/[{}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || TECHNICAL_LINE.test(clean) || INTERNAL_FIELD_DUMP.test(clean)) return fallback;
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function messageKind(message: GeniePresentationMessage, hasQuery: boolean): PresentedAnswer['kind'] | null {
  const status = message.status?.toUpperCase();
  if (message.error?.trim() || ['FAILED', 'CANCELLED', 'ERROR', 'TIMEOUT'].includes(status ?? '')) return 'error';
  if (status && status !== 'COMPLETED') return null;
  const hasClarificationAttachment = message.attachments.some(
    (attachment) => (attachment.suggestedQuestions?.length ?? 0) > 0
  );
  if (!hasQuery && hasClarificationAttachment) return 'clarification';
  return 'answer';
}

export function presentGenieMessage(message: GeniePresentationMessage | undefined): PresentedAnswer | null {
  if (!message || message.role !== 'assistant') return null;
  const queryAttachment = message.attachments.find((attachment) => attachment.query?.query);
  const kind = messageKind(message, Boolean(queryAttachment));
  if (!kind || kind !== 'error' && !message.content.trim()) return null;
  const result = queryAttachment?.attachmentId
    ? message.queryResults.get(queryAttachment.attachmentId)
    : undefined;
  const answer = sanitizeGenieText(message.content, SAFE_ANSWER_FALLBACK);
  const suggestedQuestions = message.attachments
    .flatMap((attachment) => attachment.suggestedQuestions ?? [])
    .map((suggestion) => sanitizeGenieText(suggestion, '', MAX_SUGGESTION_LENGTH))
    .filter((suggestion, index, all) => suggestion && all.indexOf(suggestion) === index)
    .slice(0, 5);
  return {
    answer,
    kind,
    sql: queryAttachment?.query?.query ?? null,
    columns: result?.manifest.schema.columns.map((column) => column.name) ?? [],
    rows: result?.result.data_array ?? [],
    suggestedQuestions,
  };
}
