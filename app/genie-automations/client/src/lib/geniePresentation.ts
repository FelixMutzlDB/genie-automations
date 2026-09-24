export interface GeniePresentationMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments: Array<{
    attachmentId?: string;
    query?: { query?: string };
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
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
}

export function presentGenieMessage(message: GeniePresentationMessage | undefined): PresentedAnswer | null {
  if (!message || message.role !== 'assistant' || !message.content.trim()) return null;
  const queryAttachment = message.attachments.find((attachment) => attachment.query?.query);
  const result = queryAttachment?.attachmentId
    ? message.queryResults.get(queryAttachment.attachmentId)
    : undefined;
  return {
    answer: message.content,
    sql: queryAttachment?.query?.query ?? null,
    columns: result?.manifest.schema.columns.map((column) => column.name) ?? [],
    rows: result?.result.data_array ?? [],
  };
}
