import { createElement, type ComponentProps, type ElementType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenieChat } from '@databricks/appkit-ui/react';
import { presentGenieMessage, type GeniePresentationMessage } from '../lib/geniePresentation';
import { GenieTab } from './GenieTab';

vi.mock('@databricks/appkit-ui/react', () => {
  const component = (element: ElementType = 'div') => {
    const MockComponent = ({ children, ...props }: ComponentProps<'div'>) => createElement(element, props, children);
    MockComponent.displayName = `Mock${String(element)}`;
    return MockComponent;
  };
  return {
    Alert: component(),
    AlertDescription: component(),
    Badge: component('span'),
    Button: component('button'),
    Card: component(),
    CardContent: component(),
    CardDescription: component(),
    CardHeader: component(),
    CardTitle: component(),
    Collapsible: component(),
    CollapsibleContent: component(),
    CollapsibleTrigger: component(),
    Empty: component(),
    EmptyDescription: component(),
    EmptyHeader: component(),
    EmptyTitle: component(),
    Input: component('input'),
    Skeleton: component(),
    Table: component('table'),
    TableBody: component('tbody'),
    TableCell: component('td'),
    TableHead: component('th'),
    TableHeader: component('thead'),
    TableRow: component('tr'),
    useGenieChat: vi.fn(),
  };
});

const mockedUseGenieChat = vi.mocked(useGenieChat);

function mockChat(status: ReturnType<typeof useGenieChat>['status'], error: string | null = null) {
  mockedUseGenieChat.mockReturnValue({
    messages: [],
    status,
    conversationId: null,
    error,
    sendMessage: vi.fn(),
    reset: vi.fn(),
    hasPreviousPage: false,
    isFetchingPreviousPage: false,
    fetchPreviousPage: vi.fn(),
  });
}

describe('Ask data result presentation', () => {
  beforeEach(() => mockChat('idle'));

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

  it('renders only a humanized message when Genie returns a technical error', () => {
    mockChat(
      'error',
      'SQLSTATE 42501: JDBC driver failed\nError: private failure\n    at GenieClient.poll (client.js:42:9)'
    );

    const markup = renderToStaticMarkup(<GenieTab identity="alice@example.com" />);

    expect(markup).toContain("I couldn&#x27;t answer that from the receivables data. Try rephrasing the question.");
    expect(markup).not.toMatch(/SQLSTATE|42501|JDBC|private failure|GenieClient\.poll|client\.js|stack/i);
    expect(markup).not.toContain('{');
  });

  it('renders a humanized loading state while Genie is working', () => {
    mockChat('streaming');

    const markup = renderToStaticMarkup(<GenieTab identity="alice@example.com" />);

    expect(markup).toContain('Analyzing your receivables data…');
    expect(markup).toContain('Genie is preparing and running a read-only query.');
  });

  it('renders a useful empty state before the first question', () => {
    const markup = renderToStaticMarkup(<GenieTab identity="alice@example.com" />);

    expect(markup).toContain('Ask your first receivables question');
    expect(markup).toContain('Answers use committed data only.');
  });
});
