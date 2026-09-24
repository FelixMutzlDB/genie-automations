import { createElement, type ComponentProps, type ElementType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenieChat } from '@databricks/appkit-ui/react';
import { presentGenieMessage, type GeniePresentationMessage } from '../lib/geniePresentation';
import { GenieTab } from './GenieTab';

const buttonHandlers = vi.hoisted(() => new Map<string, () => void>());

vi.mock('@databricks/appkit-ui/react', () => {
  const component = (element: ElementType = 'div') => {
    const MockComponent = ({ children, ...props }: ComponentProps<'div'>) => createElement(element, props, children);
    MockComponent.displayName = `Mock${String(element)}`;
    return MockComponent;
  };
  const MockButton = ({ children, onClick, ...props }: ComponentProps<'button'>) => {
    if (typeof children === 'string' && onClick) buttonHandlers.set(children, () => onClick({} as never));
    return createElement('button', props, children);
  };
  return {
    Alert: component(),
    AlertDescription: component(),
    Badge: component('span'),
    Button: MockButton,
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
  beforeEach(() => {
    buttonHandlers.clear();
    mockChat('idle');
  });

  it('extracts the human answer, generated SQL, columns, and rows without exposing raw payloads', () => {
    const message: GeniePresentationMessage = {
      role: 'assistant',
      status: 'COMPLETED',
      content: 'The remaining outstanding amount for 2026-Q1 is €1,250.',
      attachments: [
        {
          attachmentId: 'query-1',
          query: {
            query: 'SELECT accounting_period, SUM(remaining_amount) FROM governed.receivables GROUP BY accounting_period',
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
                  { name: 'accounting_period', type_name: 'STRING' },
                  { name: 'remaining_amount', type_name: 'DECIMAL' },
                ],
              },
            },
            result: { data_array: [['2026-Q1', '1250.00']] },
          },
        ],
      ]),
    };

    expect(presentGenieMessage(message)).toEqual({
      answer: 'The remaining outstanding amount for 2026-Q1 is €1,250.',
      kind: 'answer',
      sql: 'SELECT accounting_period, SUM(remaining_amount) FROM governed.receivables GROUP BY accounting_period',
      columns: ['accounting_period', 'remaining_amount'],
      rows: [['2026-Q1', '1250.00']],
      suggestedQuestions: [],
    });
  });

  it('keeps empty assistant placeholders out of the answer surface', () => {
    expect(
      presentGenieMessage({
        role: 'assistant',
        status: 'ASKING_AI',
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

    expect(markup).toContain("I couldn&#x27;t reach Genie just now. Your question wasn&#x27;t changed — please try again.");
    expect(markup).not.toMatch(/SQLSTATE|42501|JDBC|private failure|GenieClient\.poll|client\.js|stack/i);
    expect(markup).not.toContain('{');
  });

  it('keeps a Genie error out of the Co-worker tab surface', () => {
    mockChat('error', 'private transport detail');

    const inactiveMarkup = renderToStaticMarkup(<GenieTab identity="alice@example.com" active={false} />);
    const activeMarkup = renderToStaticMarkup(<GenieTab identity="alice@example.com" active />);

    expect(inactiveMarkup).not.toContain("I couldn&#x27;t reach Genie just now.");
    expect(inactiveMarkup).not.toContain("I couldn&#x27;t complete that");
    expect(activeMarkup).toContain("I couldn&#x27;t reach Genie just now.");
    expect(activeMarkup).not.toContain("I couldn&#x27;t complete that");
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
    expect(markup).toContain('What is the total remaining outstanding?');
    expect(markup).not.toMatch(/subsidiar|unallocated balances/i);
  });

  it('presents a no-answer response as neutral guidance with safe follow-ups', () => {
    mockedUseGenieChat.mockReturnValue({
      messages: [
        {
          id: 'answer-1',
          role: 'assistant',
          status: 'COMPLETED',
          content: 'I do not have a subsidiary field. Would you like to group the remaining amount by accounting period?',
          attachments: [
            {
              suggestedQuestions: ['What is the remaining outstanding amount by accounting period?'],
            },
          ],
          queryResults: new Map(),
        },
      ],
      status: 'idle',
      conversationId: 'conversation-1',
      error: null,
      sendMessage: vi.fn(),
      reset: vi.fn(),
      hasPreviousPage: false,
      isFetchingPreviousPage: false,
      fetchPreviousPage: vi.fn(),
    });

    const markup = renderToStaticMarkup(<GenieTab identity="alice@example.com" />);

    expect(markup).toContain('Genie needs a little more detail.');
    expect(markup).toContain('I do not have a subsidiary field.');
    expect(markup).toContain('What is the remaining outstanding amount by accounting period?');
    expect(markup).toContain('This data covers remittances');
    expect(markup).not.toContain('data-variant="destructive"');
    expect(markup).not.toMatch(/SQLSTATE|JDBC|stack trace|\{\s*&quot;/i);
  });

  it('renders an ordinary completed text-only response as an answer', () => {
    const presented = presentGenieMessage({
      role: 'assistant',
      status: 'COMPLETED',
      content: 'There are 56 remittances that are not fully allocated.',
      attachments: [{ text: { content: 'There are 56 remittances that are not fully allocated.' } }],
      queryResults: new Map(),
    });

    expect(presented?.kind).toBe('answer');
  });

  it('uses explicit failed metadata for a destructive error even without a query', () => {
    mockedUseGenieChat.mockReturnValue({
      messages: [
        {
          id: 'failed-1',
          role: 'assistant',
          status: 'FAILED',
          error: 'SQLSTATE 42501: internal detail',
          content: '',
          attachments: [],
          queryResults: new Map(),
        },
      ],
      status: 'idle',
      conversationId: 'conversation-1',
      error: null,
      sendMessage: vi.fn(),
      reset: vi.fn(),
      hasPreviousPage: false,
      isFetchingPreviousPage: false,
      fetchPreviousPage: vi.fn(),
    });

    const markup = renderToStaticMarkup(<GenieTab identity="alice@example.com" />);

    expect(markup).toContain('variant="destructive"');
    expect(markup).toContain("I couldn&#x27;t reach Genie just now.");
    expect(markup).not.toMatch(/SQLSTATE|42501|internal detail/i);
  });

  it('redacts unsafe assistant text and suggestions, then submits the exact sanitized follow-up', () => {
    const sendMessage = vi.fn();
    mockedUseGenieChat.mockReturnValue({
      messages: [
        {
          id: 'clarification-unsafe',
          role: 'assistant',
          status: 'COMPLETED',
          content:
            'I can help with accounting periods.\n{"error_code":"PRIVATE","statement_id":"abc"}\nSQLSTATE 42501 JDBC denied\n    at GenieClient.poll (client.js:42:9)',
          attachments: [
            {
              suggestedQuestions: [
                'Show remaining amounts by accounting period. {"request_id":"secret"}',
                'SQLSTATE 42501 JDBC driver failed\n at Driver.run (driver.js:9:1)',
              ],
            },
          ],
          queryResults: new Map(),
        },
      ],
      status: 'idle',
      conversationId: 'conversation-1',
      error: null,
      sendMessage,
      reset: vi.fn(),
      hasPreviousPage: false,
      isFetchingPreviousPage: false,
      fetchPreviousPage: vi.fn(),
    });

    const markup = renderToStaticMarkup(<GenieTab identity="alice@example.com" />);
    const sanitizedSuggestion = 'Show remaining amounts by accounting period.';

    expect(markup).toContain('I can help with accounting periods.');
    expect(markup).toContain(sanitizedSuggestion);
    expect(markup).not.toMatch(/PRIVATE|error_code|statement_id|request_id|SQLSTATE|42501|JDBC|GenieClient|client\.js|Driver\.run|driver\.js/i);
    expect(markup).not.toContain('{');

    buttonHandlers.get(sanitizedSuggestion)?.();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(sanitizedSuggestion);
  });
});
