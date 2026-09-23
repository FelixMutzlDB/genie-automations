import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@databricks/appkit-ui/react';
import { Bot, Plus, Send, ShieldCheck, User, Wrench } from 'lucide-react';
import { TaskContext } from './TaskContext';
import { humanizeActor, summarizeChange } from './lib/humanize';

interface ToolEvent {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}
interface Proposal {
  proposal_id: string;
  task_id: string;
  change_type: string;
  state: string;
  proposer_id: string | null;
  approver_id: string | null;
  diff: Record<string, unknown>;
}
interface Task {
  task_id: string;
  name: string;
  task_type: string;
  ingest_enabled: boolean;
  target_schema: string | null;
  target_table: string | null;
  org_id: string;
  role: 'owner' | 'member' | null;
  member_count: number;
}
interface Activity {
  user_id: string;
  action: string;
  status: 'success' | 'failure';
  detail: unknown;
  proposal_id: string | null;
  occurred_at: string;
}
interface ChatResponse {
  identity?: string;
  reply?: string;
  tool_events?: ToolEvent[];
  proposals?: Proposal[];
  error?: string;
}
interface ActionResponse {
  ok: boolean;
  result?: unknown;
  audit?: Record<string, unknown> | null;
  sqlstate?: string;
  error?: string;
}
type Msg = { role: 'you' | 'co-worker'; text: string; events?: ToolEvent[] };
type Outcome = { kind: 'success' | 'error'; message: string; technical?: unknown };

const START_MESSAGE: Msg = {
  role: 'co-worker',
  text: "Hi — I'm your automation co-worker. Tell me what you need checked or changed, and I'll prepare it for review.",
};
const STORAGE_KEY = 'genie-automations.selected-task';
const GA_HELP: Record<string, string> = {
  GA003: "You can't approve a change you proposed — a second person must approve it.",
  GA004: 'This record changed since the proposal was made. Please redo the change.',
  GA005: 'That would allocate more than the remittance total.',
  GA010: "We couldn't confirm your identity for this action.",
  GA012: "That IBAN isn't valid — please check it.",
  GA013: 'That IBAN is already in use by another current vendor record.',
  '42501': "You don't have permission to make this change directly.",
};
const FRIENDLY_ERROR = 'Something went wrong applying that change. Nothing was changed.';
const SUGGESTIONS = ['List the remittances', 'Correct allocation A-2 on RDEMO-1 to 1150', 'Show vendors'];
const ACTIVITY_LABELS: Record<string, string> = {
  chat: 'Asked the co-worker',
  approve: 'Approved a change',
  commit: 'Applied a change',
  task_created: 'Created this automation',
  joined: 'Joined this automation',
};
const STATE_LABELS: Record<string, string> = {
  staged: 'Awaiting review',
  validated: 'Checked',
  approved: 'Approved',
  committed: 'Applied',
  rejected: 'Rejected',
  expired: 'Expired',
};

function taskTypeLabel(type: string): string {
  if (type.includes('allocation') || type === 'receivables') return 'Receivables';
  if (type.includes('vendor_bank')) return 'Vendor bank';
  return 'Custom';
}

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

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return 'Recently';
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

function appliedMessage(proposal: Proposal): string {
  const target =
    typeof proposal.diff.vendor_id === 'string'
      ? `${proposal.diff.vendor_id} bank details updated`
      : typeof proposal.diff.remittance_id === 'string'
        ? `${proposal.diff.remittance_id} allocation updated`
        : 'change completed';
  return `Applied — ${target}, recorded under your name.`;
}

export default function App() {
  const [identity, setIdentity] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [messagesByTask, setMessagesByTask] = useState<Record<string, Msg[]>>({});
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState('allocation_upsert');
  const [ingestEnabled, setIngestEnabled] = useState(false);
  const [targetSchema, setTargetSchema] = useState('');
  const [targetTable, setTargetTable] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedTask = tasks.find((task) => task.task_id === selectedTaskId) ?? null;
  const ownTasks = tasks.filter((task) => task.role !== null);
  const availableTasks = tasks.filter((task) => task.role === null);
  const messages = useMemo(
    () => (selectedTaskId ? (messagesByTask[selectedTaskId] ?? [START_MESSAGE]) : []),
    [messagesByTask, selectedTaskId]
  );

  const selectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    localStorage.setItem(STORAGE_KEY, taskId);
    setPageError(null);
  }, []);

  const loadTasks = useCallback(
    async (preferredId?: string) => {
      setTasksLoading(true);
      try {
        const response = await fetch('/api/tasks');
        if (!response.ok) throw new Error('tasks');
        const data = (await response.json()) as Task[];
        setTasks(data);
        const memberTasks = data.filter((task) => task.role !== null);
        const candidate = preferredId ?? selectedTaskId;
        if (candidate && memberTasks.some((task) => task.task_id === candidate)) selectTask(candidate);
        else if (memberTasks[0]) selectTask(memberTasks[0].task_id);
        else setSelectedTaskId(null);
      } catch {
        setPageError("We couldn't load your automations. Please try again.");
      } finally {
        setTasksLoading(false);
      }
    },
    [selectTask, selectedTaskId]
  );

  const refreshTaskViews = useCallback(async (taskId: string) => {
    try {
      const [proposalResponse, activityResponse] = await Promise.all([
        fetch(`/api/proposals?task_id=${encodeURIComponent(taskId)}`),
        fetch(`/api/tasks/${encodeURIComponent(taskId)}/activity`),
      ]);
      if (!proposalResponse.ok || !activityResponse.ok) throw new Error('task views');
      const proposalData = (await proposalResponse.json()) as ChatResponse;
      const activityData = (await activityResponse.json()) as Activity[];
      if (proposalData.identity) setIdentity(proposalData.identity);
      setProposals(proposalData.proposals ?? []);
      setActivity(activityData);
    } catch {
      setPageError("We couldn't refresh this automation. Please try again.");
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selectedTaskId) void refreshTaskViews(selectedTaskId);
    else {
      setProposals([]);
      setActivity([]);
    }
  }, [refreshTaskViews, selectedTaskId]);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const joinTask = useCallback(
    async (taskId: string) => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/join`, { method: 'POST' });
        if (!response.ok) throw new Error('join');
        await loadTasks(taskId);
        setNotice('You joined the automation.');
      } catch {
        setPageError("We couldn't join that automation. Please try again.");
      }
    },
    [loadTasks]
  );

  const handleTaskChoice = useCallback(
    (value: string) => {
      if (value === '__new__') setCreateOpen(true);
      else if (value.startsWith('__join__:')) void joinTask(value.slice('__join__:'.length));
      else selectTask(value);
    },
    [joinTask, selectTask]
  );

  const createTask = useCallback(async () => {
    if (!createName.trim()) {
      setCreateError('Give this automation a name.');
      return;
    }
    if (ingestEnabled && (!targetSchema.trim() || !targetTable.trim())) {
      setCreateError('Add both a target schema and table.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName.trim(),
          task_type: createType,
          ingest_enabled: ingestEnabled,
          target_schema: ingestEnabled ? targetSchema.trim() : null,
          target_table: ingestEnabled ? targetTable.trim() : null,
        }),
      });
      if (!response.ok) throw new Error('create');
      const task = (await response.json()) as Task;
      setCreateOpen(false);
      setCreateName('');
      setIngestEnabled(false);
      setTargetSchema('');
      setTargetTable('');
      await loadTasks(task.task_id);
      setNotice('Automation created.');
    } catch {
      setCreateError("We couldn't create that automation. Check the details and try again.");
    } finally {
      setCreating(false);
    }
  }, [createName, createType, ingestEnabled, loadTasks, targetSchema, targetTable]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy || !selectedTaskId) return;
      const taskId = selectedTaskId;
      setInput('');
      setPageError(null);
      setBusy(true);
      setMessagesByTask((all) => ({ ...all, [taskId]: [...(all[taskId] ?? [START_MESSAGE]), { role: 'you', text }] }));
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, task_id: taskId }),
        });
        const data = (await response.json()) as ChatResponse;
        if (data.identity) setIdentity(data.identity);
        if (!response.ok || data.error) setPageError(data.error || "I couldn't complete that — could you rephrase?");
        else
          setMessagesByTask((all) => ({
            ...all,
            [taskId]: [
              ...(all[taskId] ?? [START_MESSAGE]),
              {
                role: 'co-worker',
                text: data.reply || "I couldn't complete that — could you rephrase?",
                events: data.tool_events,
              },
            ],
          }));
        if (data.proposals) setProposals(data.proposals);
        await refreshTaskViews(taskId);
      } catch {
        setPageError("I couldn't complete that — could you rephrase?");
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshTaskViews, selectedTaskId]
  );

  const act = useCallback(
    async (kind: 'approve' | 'commit', proposal: Proposal) => {
      if (!selectedTaskId) return;
      try {
        const response = await fetch(`/api/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposal_id: proposal.proposal_id, task_id: selectedTaskId }),
        });
        const data = (await response.json()) as ActionResponse;
        const outcome: Outcome = data.ok
          ? {
              kind: 'success',
              message: kind === 'commit' ? appliedMessage(proposal) : 'Approved — this change is ready to apply.',
              technical: data.audit,
            }
          : { kind: 'error', message: (data.sqlstate && GA_HELP[data.sqlstate]) || FRIENDLY_ERROR };
        setOutcomes((all) => ({ ...all, [proposal.proposal_id]: outcome }));
        await refreshTaskViews(selectedTaskId);
      } catch {
        setOutcomes((all) => ({ ...all, [proposal.proposal_id]: { kind: 'error', message: FRIENDLY_ERROR } }));
      }
    },
    [refreshTaskViews, selectedTaskId]
  );

  const taskContext = useMemo(() => ({ selectedTaskId }), [selectedTaskId]);

  return (
    <TaskContext.Provider value={taskContext}>
      <TooltipProvider>
        <div className="h-screen flex flex-col bg-background text-foreground">
          <header className="border-b px-5 py-3 flex flex-wrap items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            <h1 className="text-base font-semibold">Genie automations</h1>
            <Select value={selectedTaskId ?? undefined} onValueChange={handleTaskChoice}>
              <SelectTrigger className="w-[280px]" aria-label="Select automation">
                <SelectValue placeholder={tasksLoading ? 'Loading automations…' : 'Choose an automation'} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Your automations</SelectLabel>
                  {ownTasks.map((task) => (
                    <SelectItem key={task.task_id} value={task.task_id}>
                      {task.name} · {taskTypeLabel(task.task_type)}
                      {task.role === 'owner' ? ' · Owner' : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {availableTasks.length > 0 && (
                  <>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Available to join</SelectLabel>
                      {availableTasks.map((task) => (
                        <SelectItem key={task.task_id} value={`__join__:${task.task_id}`}>
                          Join · {task.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </>
                )}
                <SelectSeparator />
                <SelectItem value="__new__">
                  <Plus className="h-4 w-4" /> New automation…
                </SelectItem>
              </SelectContent>
            </Select>
            {selectedTask && (
              <span className="text-xs text-muted-foreground">{taskTypeLabel(selectedTask.task_type)}</span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="ml-auto gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  {humanizeActor(identity)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Actions you take are recorded under your own name.</TooltipContent>
            </Tooltip>
          </header>
          {notice && (
            <div
              role="status"
              className="fixed right-4 top-16 z-50 rounded-md border bg-card px-4 py-3 text-sm shadow-md"
            >
              {notice}
            </div>
          )}
          {pageError && (
            <Alert variant="destructive" className="m-4 w-auto">
              <AlertDescription>{pageError}</AlertDescription>
            </Alert>
          )}
          {tasksLoading ? (
            <div className="p-6 space-y-3">
              <Skeleton className="h-8 w-72" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : !selectedTask ? (
            <div className="flex-1 grid place-items-center p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>You’re not part of an automation yet</EmptyTitle>
                </EmptyHeader>
                <EmptyDescription>Create one or ask an owner to add you.</EmptyDescription>
                <EmptyContent>
                  <Button onClick={() => setCreateOpen(true)}>
                    <Plus className="h-4 w-4" /> New automation
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-[1.6fr_1fr] flex-1 min-h-0">
              <main className="flex flex-col min-h-0 border-r" aria-label="Conversation">
                <div ref={scrollRef} className="flex-1 overflow-auto p-5 space-y-4">
                  {messages.map((message) => (
                    <div key={`${message.role}-${message.text}`} className={message.role === 'you' ? 'text-right' : ''}>
                      <div className="text-xs text-muted-foreground mb-1">
                        {message.role === 'you' ? 'You' : 'Co-worker'}
                      </div>
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
                    <Button key={suggestion} size="sm" variant="outline" onClick={() => void send(suggestion)}>
                      {suggestion}
                    </Button>
                  ))}
                </div>
                <div className="border-t p-3 flex gap-2">
                  <Button variant="outline" size="icon" disabled title="File upload is coming soon">
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Input
                    className="flex-1"
                    placeholder="Ask the co-worker…"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void send(input);
                    }}
                  />
                  <Button onClick={() => void send(input)} disabled={busy || !input.trim()}>
                    <Send className="h-4 w-4" />
                    <span className="sr-only">Send</span>
                  </Button>
                </div>
              </main>
              <aside className="min-h-0 overflow-auto p-4" aria-label="Automation details">
                <Tabs defaultValue="proposals">
                  <TabsList className="w-full">
                    <TabsTrigger value="proposals">Proposals</TabsTrigger>
                    <TabsTrigger value="activity">Activity</TabsTrigger>
                  </TabsList>
                  <TabsContent value="proposals" className="space-y-3 pt-3">
                    {proposals.length === 0 && (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>No proposals yet</EmptyTitle>
                        </EmptyHeader>
                        <EmptyDescription>Ask the co-worker to prepare a change.</EmptyDescription>
                      </Empty>
                    )}
                    {proposals.map((proposal) => {
                      const canApprove = proposal.state === 'staged' || proposal.state === 'validated';
                      const canApply = proposal.state === 'approved';
                      const isProposer = proposal.proposer_id === identity;
                      const outcome = outcomes[proposal.proposal_id];
                      return (
                        <Card key={proposal.proposal_id}>
                          <CardHeader className="pb-2">
                            <div className="flex items-start gap-2">
                              <CardTitle className="text-base">
                                {summarizeChange(proposal.change_type, proposal.diff)}
                              </CardTitle>
                              <Badge
                                className={`ml-auto shrink-0 ${proposal.state === 'committed' ? 'bg-success text-success-foreground' : proposal.state === 'rejected' ? 'bg-destructive text-destructive-foreground' : ''}`}
                                variant="secondary"
                              >
                                {STATE_LABELS[proposal.state] ?? 'In review'}
                              </Badge>
                            </div>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <div className="text-sm text-muted-foreground">
                              <p>Proposed by {humanizeActor(proposal.proposer_id)}</p>
                              {proposal.approver_id && <p>Approved by {humanizeActor(proposal.approver_id)}</p>}
                            </div>
                            <div className="flex gap-2">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={!canApprove || isProposer}
                                      onClick={() => void act('approve', proposal)}
                                    >
                                      Approve
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                {isProposer && (
                                  <TooltipContent>A second person must approve a change you proposed.</TooltipContent>
                                )}
                              </Tooltip>
                              <Button size="sm" disabled={!canApply} onClick={() => void act('commit', proposal)}>
                                Apply
                              </Button>
                            </div>
                            {outcome && (
                              <Alert variant={outcome.kind === 'error' ? 'destructive' : 'default'}>
                                <AlertDescription>{outcome.message}</AlertDescription>
                              </Alert>
                            )}
                            <Accordion type="single" collapsible>
                              <AccordionItem value="technical">
                                <AccordionTrigger>Technical details</AccordionTrigger>
                                <AccordionContent>
                                  <pre className="text-xs overflow-auto whitespace-pre-wrap bg-muted p-2 rounded">
                                    {safeJson({
                                      proposal_id: proposal.proposal_id,
                                      change_type: proposal.change_type,
                                      diff: proposal.diff,
                                      audit: outcome?.technical,
                                    })}
                                  </pre>
                                </AccordionContent>
                              </AccordionItem>
                            </Accordion>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </TabsContent>
                  <TabsContent value="activity" className="space-y-3 pt-3">
                    {activity.length === 0 && (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>No activity yet</EmptyTitle>
                        </EmptyHeader>
                        <EmptyDescription>Actions for this automation will appear here.</EmptyDescription>
                      </Empty>
                    )}
                    {activity.map((item) => (
                      <div
                        key={`${item.occurred_at}-${item.action}-${item.proposal_id ?? item.user_id}`}
                        className="flex gap-3 border-b pb-3"
                      >
                        <Bot className="h-4 w-4 mt-1 text-muted-foreground" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {ACTIVITY_LABELS[item.action] ?? 'Worked on this automation'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {humanizeActor(item.user_id)} ·{' '}
                            <time dateTime={item.occurred_at} title={new Date(item.occurred_at).toLocaleString()}>
                              {relativeTime(item.occurred_at)}
                            </time>
                          </p>
                        </div>
                        <Badge
                          variant={item.status === 'failure' ? 'destructive' : 'secondary'}
                          className={item.status === 'success' ? 'bg-success text-success-foreground' : ''}
                        >
                          {item.status === 'success' ? 'Succeeded' : 'Failed'}
                        </Badge>
                      </div>
                    ))}
                  </TabsContent>
                </Tabs>
              </aside>
            </div>
          )}
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New automation</DialogTitle>
                <DialogDescription>Set up a shared workflow for your team.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="automation-name">Name</Label>
                  <Input
                    id="automation-name"
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="Monthly receivables"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={createType} onValueChange={setCreateType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allocation_upsert">Receivables collection</SelectItem>
                      <SelectItem value="vendor_bank_update">Vendor bank details</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="ingest-enabled">This automation collects &amp; stores data</Label>
                  <Switch id="ingest-enabled" checked={ingestEnabled} onCheckedChange={setIngestEnabled} />
                </div>
                {ingestEnabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="target-schema">Target schema</Label>
                      <Input
                        id="target-schema"
                        value={targetSchema}
                        onChange={(event) => setTargetSchema(event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="target-table">Target table</Label>
                      <Input
                        id="target-table"
                        value={targetTable}
                        onChange={(event) => setTargetTable(event.target.value)}
                      />
                    </div>
                  </div>
                )}
                {createError && (
                  <Alert variant="destructive">
                    <AlertDescription>{createError}</AlertDescription>
                  </Alert>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={creating} onClick={() => void createTask()}>
                  {creating ? 'Creating…' : 'Create automation'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </TooltipProvider>
    </TaskContext.Provider>
  );
}
