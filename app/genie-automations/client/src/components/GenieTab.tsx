import { useMemo, useState, type FormEvent } from 'react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useGenieChat,
} from '@databricks/appkit-ui/react';
import { ChevronDown, Send } from 'lucide-react';
import { presentGenieMessage } from '../lib/geniePresentation';

const SOURCE = 'felix_demo_catalog.genie-automations.receivables_committed';
const FRIENDLY_ERROR = "I couldn't answer that from the receivables data. Try rephrasing the question.";

export function GenieTab({ identity }: { identity: string | null }) {
  const [question, setQuestion] = useState('');
  const { messages, status, sendMessage, reset } = useGenieChat({
    alias: 'default',
    urlParamName: 'genieConversationId',
  });
  const answer = useMemo(
    () => presentGenieMessage([...messages].reverse().find((message) => message.role === 'assistant')),
    [messages]
  );
  const busy = status === 'streaming' || status === 'loading-history' || status === 'loading-older';

  const ask = (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || busy) return;
    sendMessage(question);
    setQuestion('');
  };

  return (
    <main className="flex-1 min-h-0 overflow-auto p-5" aria-label="Ask data">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Ask about receivables</h2>
            <p className="text-sm text-muted-foreground">
              Ask a business question in plain language. Genie will query the governed committed-receivables view.
            </p>
          </div>
          <Badge variant="secondary">{identity ?? 'Signed in'}</Badge>
        </div>

        <form className="flex gap-2" onSubmit={ask}>
          <Input
            aria-label="Receivables question"
            placeholder="For example: Which subsidiaries have the largest unallocated balances?"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !question.trim()}>
            <Send className="h-4 w-4" /> Ask
          </Button>
        </form>

        {status === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{FRIENDLY_ERROR}</AlertDescription>
          </Alert>
        )}

        {busy && (
          <Card aria-label="Analyzing receivables data">
            <CardHeader>
              <CardTitle className="text-base">Analyzing your receivables data…</CardTitle>
              <CardDescription>Genie is preparing and running a read-only query.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        )}

        {!busy && !answer && status !== 'error' && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Ask your first receivables question</EmptyTitle>
              <EmptyDescription>
                Answers use committed data only. Ask for totals, exceptions, trends, or a breakdown.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {!busy && answer && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Answer</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap">{answer.answer}</p>
              </CardContent>
            </Card>

            {answer.columns.length > 0 && answer.rows.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Results</CardTitle>
                  <CardDescription>Source: {SOURCE}</CardDescription>
                </CardHeader>
                <CardContent className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {answer.columns.map((column) => <TableHead key={column}>{column}</TableHead>)}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {answer.rows.map((row) => (
                        <TableRow key={row.join('\u001f')}>
                          {answer.columns.map((column, columnIndex) => (
                            <TableCell key={column}>{row[columnIndex] ?? '—'}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No result rows</EmptyTitle>
                  <EmptyDescription>Genie answered without a table. Try asking for a specific breakdown.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {answer.sql && (
              <Collapsible>
                <Card>
                  <CardHeader>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" className="w-full justify-between px-0">
                        View generated SQL <ChevronDown className="h-4 w-4" />
                      </Button>
                    </CollapsibleTrigger>
                  </CardHeader>
                  <CollapsibleContent>
                    <CardContent>
                      <pre className="overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{answer.sql}</pre>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}

            <p className="text-xs text-muted-foreground">
              Runs with your Databricks permissions. AI-generated — verify the answer against the generated SQL and source data.
            </p>
            <Button variant="outline" size="sm" onClick={reset}>Start a new question</Button>
          </div>
        )}
      </div>
    </main>
  );
}
