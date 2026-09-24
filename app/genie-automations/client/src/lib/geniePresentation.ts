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
const SQL_STATEMENT =
  /(?:^|[;\n])\s*(?:SELECT\b[\s\S]{0,500}?\bFROM\b|WITH\b[\s\S]{0,500}?\bSELECT\b|INSERT\s+INTO\b|UPDATE\s+[\w.`"-]+\s+SET\b|DELETE\s+FROM\b|(?:DROP|ALTER|CREATE|TRUNCATE)\s+(?:TABLE|VIEW|SCHEMA|CATALOG)\b|(?:GRANT|REVOKE)\b[\s\S]{0,300}?\bON\b|MERGE\s+INTO\b)/i;
const PROMPT_INJECTION =
  /(?:ignore\s+(?:all\s+)?(?:previous|prior|the\s+above)\s+instructions|disregard\s+(?:the\s+)?(?:above|previous|prior)(?:\s+instructions)?|(?:act|respond|pretend)\s+as\s+(?:the\s+)?(?:system|assistant|developer)\b|(?:^|\n)\s*(?:system|assistant|developer)\s*:|(?:system|assistant|developer)\s+(?:message|prompt|role)\s*:|<\|(?:system|assistant|developer)\|>|you\s+are\s+now\s+(?:the\s+)?(?:system|assistant|developer)\b)/i;
const CONTROL_CHARACTER = /\p{Cc}/u;

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
  const normalized = value.normalize('NFKC').replace(/[\p{Cf}\p{Cs}]/gu, '');
  const boundedInput = [...normalized]
    .slice(0, maxLength * 4)
    .map((character) => {
      return CONTROL_CHARACTER.test(character) && character !== '\n' && character !== '\r' && character !== '\t'
        ? ' '
        : character;
    })
    .join('');
  if (SQL_STATEMENT.test(boundedInput) || PROMPT_INJECTION.test(boundedInput)) return fallback;
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
  if (
    !clean ||
    TECHNICAL_LINE.test(clean) ||
    INTERNAL_FIELD_DUMP.test(clean) ||
    SQL_STATEMENT.test(clean) ||
    PROMPT_INJECTION.test(clean)
  ) return fallback;
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function messageStatusKind(message: GeniePresentationMessage): 'error' | 'completed' | null {
  const status = message.status?.toUpperCase();
  if (message.error?.trim() || ['FAILED', 'CANCELLED', 'ERROR', 'TIMEOUT'].includes(status ?? '')) return 'error';
  if (status && status !== 'COMPLETED') return null;
  return 'completed';
}

export function presentGenieMessage(message: GeniePresentationMessage | undefined): PresentedAnswer | null {
  if (!message || message.role !== 'assistant') return null;
  const queryAttachment = message.attachments.find((attachment) => attachment.query?.query);
  const statusKind = messageStatusKind(message);
  if (!statusKind) return null;
  const result = queryAttachment?.attachmentId
    ? message.queryResults.get(queryAttachment.attachmentId)
    : undefined;
  const safeAnswer = sanitizeGenieText(message.content);
  const suggestedQuestions = message.attachments
    .flatMap((attachment) => attachment.suggestedQuestions ?? [])
    .map((suggestion) => sanitizeGenieText(suggestion, '', MAX_SUGGESTION_LENGTH))
    .filter((suggestion, index, all) => suggestion && all.indexOf(suggestion) === index)
    .slice(0, 5);
  const kind: PresentedAnswer['kind'] = statusKind === 'error'
    ? 'error'
    : safeAnswer
      ? 'answer'
      : !queryAttachment && suggestedQuestions.length > 0
        ? 'clarification'
        : 'answer';
  return {
    answer: safeAnswer || SAFE_ANSWER_FALLBACK,
    kind,
    sql: queryAttachment?.query?.query ?? null,
    columns: result?.manifest.schema.columns.map((column) => column.name) ?? [],
    rows: result?.result.data_array ?? [],
    suggestedQuestions,
  };
}
