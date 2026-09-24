import type { ChangeEvent, RefObject } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Input,
} from '@databricks/appkit-ui/react';
import { Plus, Send, Wrench } from 'lucide-react';
import type { Msg, ToolEvent } from '../types';

const SUGGESTIONS = ['List the remittances', 'Correct allocation A-2 on RDEMO-1 to 1150', 'Show vendors'];

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Details unavailable';
  }
}

function toolSummary(event: ToolEvent): string {
  const rows = Array.isArray(event.result) ? event.result.length : null;
  const labels: Record<string, string> = {
    list_tasks: 'Looked up available automations',
    list_remittances: 'Looked up remittances',
    list_vendors: 'Looked up vendors',
    get_proposal: 'Checked the proposed change',
    stage_allocation_correction: 'Prepared an allocation change for review',
    stage_vendor_bank_update: 'Prepared a bank-details change for review',
  };
  const label = labels[event.tool] ?? 'Ran a step';
  return rows === null ? `${label}.` : `${label} — found ${rows}.`;
}

interface ChatViewProps {
  messages: Msg[];
  busy: boolean;
  input: string;
  canIngest: boolean;
  ingestDisabledReason: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  onSend: (text: string) => void;
  onUpload: (file: File) => void;
}

export function ChatView({
  messages,
  busy,
  input,
  canIngest,
  ingestDisabledReason,
  scrollRef,
  fileInputRef,
  onInputChange,
  onSend,
  onUpload,
}: ChatViewProps) {
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onUpload(file);
    event.target.value = '';
  };

  return (
    <main className="flex flex-col min-h-0 border-r" aria-label="Conversation">
      <div ref={scrollRef} className="flex-1 overflow-auto p-5 space-y-4">
        {messages.map((message) => (
          <div key={`${message.role}-${message.text}`} className={message.role === 'you' ? 'text-right' : ''}>
            <div className="text-xs text-muted-foreground mb-1">{message.role === 'you' ? 'You' : 'Co-worker'}</div>
            <div
              className={`inline-block max-w-[85%] rounded-lg border px-3 py-2 text-left whitespace-pre-wrap ${message.role === 'you' ? 'bg-muted' : 'bg-card'}`}
            >
              {message.text}
            </div>
            {message.events && message.events.length > 0 && (
              <Accordion type="single" collapsible className="text-left mt-1">
                <AccordionItem value="steps">
                  <AccordionTrigger className="text-xs text-muted-foreground justify-start gap-2">
                    <Wrench className="h-3 w-3" /> Show what I did
                  </AccordionTrigger>
                  <AccordionContent className="space-y-2">
                    {message.events.map((event) => (
                      <div
                        key={`${event.tool}-${safeJson(event.args)}`}
                        className="text-sm border-l-2 border-primary pl-3"
                      >
                        <p>{toolSummary(event)}</p>
                        <Accordion type="single" collapsible>
                          <AccordionItem value="raw">
                            <AccordionTrigger className="text-xs">Raw</AccordionTrigger>
                            <AccordionContent>
                              <pre className="text-xs overflow-auto whitespace-pre-wrap bg-muted p-2 rounded">
                                {safeJson({ args: event.args, result: event.result })}
                              </pre>
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      </div>
                    ))}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </div>
        ))}
        {busy && <p className="text-sm text-muted-foreground">Working on that…</p>}
      </div>
      <div className="border-t px-5 py-2 flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <Button key={suggestion} size="sm" variant="outline" onClick={() => onSend(suggestion)}>
            {suggestion}
          </Button>
        ))}
      </div>
      <div className="border-t p-3 flex gap-2">
        <input ref={fileInputRef} className="hidden" type="file" accept=".csv,.xlsx" onChange={handleFileChange} />
        <Button
          variant="outline"
          size="icon"
          disabled={!canIngest}
          title={
            canIngest
              ? 'Upload CSV or Excel for a safe preview'
              : ingestDisabledReason
          }
          onClick={() => fileInputRef.current?.click()}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Input
          className="flex-1"
          placeholder="Ask the co-worker…"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSend(input);
          }}
        />
        <Button onClick={() => onSend(input)} disabled={busy || !input.trim()}>
          <Send className="h-4 w-4" />
          <span className="sr-only">Send</span>
        </Button>
      </div>
    </main>
  );
}
