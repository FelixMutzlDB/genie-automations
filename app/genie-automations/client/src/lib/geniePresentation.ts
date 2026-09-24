export interface GeniePresentationMessage {
  role: 'user' | 'assistant';
  content: string;
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
  kind: 'answer' | 'clarification';
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
  suggestedQuestions: string[];
}

export function presentGenieMessage(message: GeniePresentationMessage | undefined): PresentedAnswer | null {
  if (!message || message.role !== 'assistant' || !message.content.trim()) return null;
  const queryAttachment = message.attachments.find((attachment) => attachment.query?.query);
  const result = queryAttachment?.attachmentId
    ? message.queryResults.get(queryAttachment.attachmentId)
    : undefined;
  return {
    answer: message.content,
    kind: queryAttachment ? 'answer' : 'clarification',
    sql: queryAttachment?.query?.query ?? null,
    columns: result?.manifest.schema.columns.map((column) => column.name) ?? [],
    rows: result?.result.data_array ?? [],
    suggestedQuestions: message.attachments.flatMap((attachment) => attachment.suggestedQuestions ?? []),
  };
}
