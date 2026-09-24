import { describe, expect, it } from 'vitest';
import { presentGenieMessage, type GeniePresentationMessage } from '../lib/geniePresentation';

describe('Ask data result presentation', () => {
  it('extracts the human answer, generated SQL, columns, and rows without exposing raw payloads', () => {
    const message: GeniePresentationMessage = {
      role: 'assistant',
      content: 'The open balance is €1,250.',
      attachments: [
        {
          attachmentId: 'query-1',
          query: {
            query: 'SELECT subsidiary, open_balance FROM governed.receivables',
          },
        },
      ],
      queryResults: new Map([
        [
          'query-1',
          {
            manifest: {
              schema: {
                columns: [
                  { name: 'subsidiary', type_name: 'STRING' },
                  { name: 'open_balance', type_name: 'DECIMAL' },
                ],
              },
            },
            result: { data_array: [['DE01', '1250.00']] },
          },
        ],
      ]),
    };

    expect(presentGenieMessage(message)).toEqual({
      answer: 'The open balance is €1,250.',
      sql: 'SELECT subsidiary, open_balance FROM governed.receivables',
      columns: ['subsidiary', 'open_balance'],
      rows: [['DE01', '1250.00']],
    });
  });

  it('keeps empty assistant placeholders out of the answer surface', () => {
    expect(
      presentGenieMessage({
        role: 'assistant',
        content: '',
        attachments: [],
        queryResults: new Map(),
      })
    ).toBeNull();
  });
});
