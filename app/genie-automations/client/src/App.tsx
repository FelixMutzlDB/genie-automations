import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardContent } from '@databricks/appkit-ui/react';
import { Send, ShieldCheck, User, Wrench } from 'lucide-react';

// ── Types mirroring the server routes ────────────────────────────────────────
interface ToolEvent { tool: string; args: Record<string, unknown>; result: unknown }
interface Proposal {
  proposal_id: string;
  task_id: string;
  change_type: string;
  state: string;
  proposer_id: string | null;
  approver_id: string | null;
  diff: Record<string, unknown>;
}
interface ChatResponse { identity?: string; reply?: string; tool_events?: ToolEvent[]; proposals?: Proposal[]; error?: string }
interface ActionResponse { ok: boolean; result?: unknown; audit?: { actor_id?: string; db_principal?: string; payload_sha256?: string } | null; sqlstate?: string; error?: string }

type Msg = { role: 'you' | 'co-worker'; text: string };
type Outcome = { cls: 'ok' | 'bad'; html: string };

const GA_HELP: Record<string, string> = {
  GA003: 'Segregation of duties: a different authenticated person must approve. This is the guardrail working.',
  GA004: 'The underlying record changed since this was staged. Re-stage to pick up the current version.',
  GA005: 'Over-allocation: the sum would exceed the remittance total. Nothing was written.',
  GA012: 'IBAN failed checksum/format validation. Nothing was written.',
  GA013: 'That IBAN is already assigned to a different vendor. Nothing was written.',
  GA010: 'Identity mismatch — the action was rejected.',
};

const SUGGESTIONS = [
  'list the remittances',
  'correct allocation A-2 on RDEMO-1 to 1150',
  'show vendors',
  'change VEND-1003 IBAN to NL91ABNA0417164300, BIC ABNANL2AXXX, effective 2027-05-01',
];

export default function App() {
  const [identity, setIdentity] = useState<string>('…');
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'co-worker', text: "Hi — I'm your genie-automations co-worker. I can reconcile receivables and govern vendor bank-detail changes. I read the ledger and stage proposals; I can't approve or commit — you do that with the buttons, and a different person must approve what you stage." },
  ]);
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshProposals = useCallback(async () => {
    const r = await fetch('/api/proposals');
    const d = (await r.json()) as ChatResponse;
    if (d.identity) setIdentity(d.identity);
    if (d.proposals) setProposals(d.proposals);
  }, []);

  useEffect(() => { void refreshProposals(); }, [refreshProposals]);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'you', text }]);
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }),
      });
      const d = (await r.json()) as ChatResponse;
      if (d.identity) setIdentity(d.identity);
      if (d.tool_events?.length) setEvents((e) => [...e, ...d.tool_events!]);
      setMessages((m) => [...m, { role: 'co-worker', text: d.reply || d.error || '(no reply)' }]);
      if (d.proposals) setProposals(d.proposals);
    } catch (err) {
      setMessages((m) => [...m, { role: 'co-worker', text: `Error: ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const act = useCallback(async (kind: 'approve' | 'commit', id: string) => {
    const r = await fetch(`/api/${kind}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal_id: id }),
    });
    const d = (await r.json()) as ActionResponse;
    let outcome: Outcome;
    if (d.ok) {
      if (kind === 'commit' && d.audit) {
        outcome = { cls: 'ok', html: `✅ Committed. actor_id = ${d.audit.actor_id} · db_principal = ${d.audit.db_principal} · sha ${(d.audit.payload_sha256 ?? '').slice(0, 12)}…` };
      } else {
        outcome = { cls: 'ok', html: `✅ ${JSON.stringify(d.result)}` };
      }
    } else {
      const help = d.sqlstate && GA_HELP[d.sqlstate] ? ` — ${GA_HELP[d.sqlstate]}` : '';
      outcome = { cls: 'bad', html: `⛔ ${d.sqlstate ?? 'error'}: ${d.error ?? ''}${help}` };
    }
    setOutcomes((o) => ({ ...o, [id]: outcome }));
    await refreshProposals();
  }, [refreshProposals]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <header className="border-b px-5 py-3 flex items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h1 className="text-base font-semibold">genie-automations · reconciliation co-worker</h1>
        <span className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
          <User className="h-4 w-4" /> acting as <span className="font-medium text-foreground">{identity}</span>
          <span className="ml-1 rounded-full border border-primary px-2 py-0.5 text-xs text-primary">OBO</span>
        </span>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[1.6fr_1fr] flex-1 min-h-0">
        {/* Center: chat */}
        <div className="flex flex-col min-h-0 border-r">
          <div ref={scrollRef} className="flex-1 overflow-auto p-5 space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'you' ? 'text-right' : ''}>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{m.role}</div>
                <div className={`inline-block rounded-lg border px-3 py-2 text-left whitespace-pre-wrap ${m.role === 'you' ? 'bg-muted' : 'bg-card'}`}>{m.text}</div>
              </div>
            ))}
            {busy && <div className="text-sm text-muted-foreground">Analyzing…</div>}
          </div>

          {/* Activity / tool events */}
          {events.length > 0 && (
            <div className="border-t max-h-40 overflow-auto px-5 py-2 bg-muted/40">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1"><Wrench className="h-3 w-3" /> Activity — what the agent actually did</div>
              {events.map((e, i) => (
                <div key={i} className="font-mono text-xs text-muted-foreground border-l-2 border-primary pl-2 mb-1">
                  <span className="text-primary">{e.tool}</span>({JSON.stringify(e.args)}) → {JSON.stringify(e.result).slice(0, 240)}
                </div>
              ))}
            </div>
          )}

          <div className="border-t px-5 py-2 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => void send(s)} className="text-xs rounded-full border px-2.5 py-1 text-muted-foreground hover:bg-muted">{s}</button>
            ))}
          </div>
          <div className="border-t p-3 flex gap-2">
            <input
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Ask the co-worker… (Enter to send)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void send(input); }}
            />
            <Button onClick={() => void send(input)} disabled={busy}><Send className="h-4 w-4" /></Button>
          </div>
        </div>

        {/* Right: proposals */}
        <div className="flex flex-col min-h-0 overflow-auto p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Proposals — approve / commit are your explicit actions</div>
          {proposals.length === 0 && <div className="text-sm text-muted-foreground">No proposals yet. Ask the co-worker to stage a correction.</div>}
          <div className="space-y-3">
            {proposals.map((p) => {
              const canApprove = p.state === 'staged' || p.state === 'validated';
              const canCommit = p.state === 'approved';
              const oc = outcomes[p.proposal_id];
              return (
                <Card key={p.proposal_id}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-primary">{p.proposal_id}</span>
                      <span className="text-xs rounded-full border px-2 py-0.5 text-muted-foreground">{p.state}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{p.change_type}</span>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">{JSON.stringify(p.diff)}</div>
                    <div className="text-xs text-muted-foreground">proposer: <b className="text-foreground">{p.proposer_id}</b>{p.approver_id ? <> · approver: <b className="text-foreground">{p.approver_id}</b></> : null}</div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" disabled={!canApprove} onClick={() => void act('approve', p.proposal_id)}>Approve</Button>
                      <Button size="sm" disabled={!canCommit} onClick={() => void act('commit', p.proposal_id)}>Commit</Button>
                    </div>
                    {oc && (
                      <div className={`text-xs rounded-md px-2 py-1.5 ${oc.cls === 'ok' ? 'bg-muted text-foreground' : 'bg-destructive/10 text-destructive'}`}>{oc.html}</div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
