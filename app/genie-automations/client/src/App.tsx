import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertDescription,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  TooltipProvider,
} from '@databricks/appkit-ui/react';
import { Plus } from 'lucide-react';
import { AppHeader } from './components/AppHeader';
import { ChatView } from './components/ChatView';
import { CreateTaskDialog } from './components/CreateTaskDialog';
import { DetailsPanel } from './components/DetailsPanel';
import { IngestDialog } from './components/IngestDialog';
import { TaskContext } from './TaskContext';
import { loadCanonicalIdentity } from './lib/identity';
import { joinAndReloadTasks } from './lib/joinTask';
import {
  abortableDelay,
  claimConfirmation,
  closeIngestSession,
  isCurrentIngest,
  reduceIngest,
  type ActiveIngest,
  type IngestUiState,
  type PollStatus,
} from './lib/ingestState';
import type { ActionResponse, Activity, ChatResponse, Msg, Outcome, ParsePreview, Proposal, Task } from './types';

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
const FRIENDLY_CHAT_ERROR = "I couldn't complete that — could you rephrase?";

function appliedMessage(proposal: Proposal): string {
  const target =
    typeof proposal.diff.vendor_id === 'string'
      ? `${proposal.diff.vendor_id} bank details updated`
      : typeof proposal.diff.remittance_id === 'string'
        ? `${proposal.diff.remittance_id} allocation updated`
        : 'change completed';
  return `Applied — ${target}, recorded under your name.`;
}

function friendlyError(code: unknown, fallback: string): string {
  return typeof code === 'string' && GA_HELP[code] ? GA_HELP[code] : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export default function App() {
  const [identity, setIdentity] = useState<string | null>(null);
  const [identityResolved, setIdentityResolved] = useState(false);
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
  const [targetCatalog, setTargetCatalog] = useState('');
  const [targetSchema, setTargetSchema] = useState('');
  const [targetTable, setTargetTable] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestState, setIngestState] = useState<IngestUiState>({ phase: 'idle' });
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [selectedPreviewRows, setSelectedPreviewRows] = useState<Set<number>>(new Set());
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedTaskIdRef = useRef(selectedTaskId);
  const chatControllerRef = useRef<AbortController | null>(null);
  const ingestRequestRef = useRef<ActiveIngest | null>(null);
  const confirmSubmissionRef = useRef(false);
  const actionControllersRef = useRef(new Set<AbortController>());

  const selectedTask = tasks.find((task) => task.task_id === selectedTaskId) ?? null;
  const ownTasks = tasks.filter((task) => task.role !== null);
  const availableTasks = tasks.filter((task) => task.role === null);
  const messages = useMemo(
    () => (selectedTaskId ? (messagesByTask[selectedTaskId] ?? [START_MESSAGE]) : []),
    [messagesByTask, selectedTaskId]
  );

  const closeIngest = useCallback(() => {
    ingestRequestRef.current = closeIngestSession(ingestRequestRef.current, {
      closeDialog: () => setIngestOpen(false),
      resetState: () => setIngestState({ phase: 'idle' }),
      clearPreview: () => setPreview(null),
    });
    setSelectedPreviewRows(new Set());
    setConfirmSubmitting(false);
  }, []);

  const abortTaskRequests = useCallback(() => {
    chatControllerRef.current?.abort();
    chatControllerRef.current = null;
    for (const controller of actionControllersRef.current) controller.abort();
    actionControllersRef.current.clear();
  }, []);

  const selectTask = useCallback(
    (taskId: string) => {
      abortTaskRequests();
      closeIngest();
      selectedTaskIdRef.current = taskId;
      setSelectedTaskId(taskId);
      setBusy(false);
      localStorage.setItem(STORAGE_KEY, taskId);
      setPageError(null);
    },
    [abortTaskRequests, closeIngest]
  );

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
        else {
          abortTaskRequests();
          closeIngest();
          selectedTaskIdRef.current = null;
          setSelectedTaskId(null);
          setBusy(false);
        }
      } catch {
        setPageError("We couldn't load your automations. Please try again.");
      } finally {
        setTasksLoading(false);
      }
    },
    [abortTaskRequests, closeIngest, selectTask, selectedTaskId]
  );

  const refreshTaskViews = useCallback(async (taskId: string, signal?: AbortSignal) => {
    try {
      const [proposalResponse, activityResponse] = await Promise.all([
        fetch(`/api/proposals?task_id=${encodeURIComponent(taskId)}`, { signal }),
        fetch(`/api/tasks/${encodeURIComponent(taskId)}/activity`, { signal }),
      ]);
      if (!proposalResponse.ok || !activityResponse.ok) throw new Error('task views');
      const proposalData = (await proposalResponse.json()) as ChatResponse;
      const activityData = (await activityResponse.json()) as Activity[];
      if (signal?.aborted || selectedTaskIdRef.current !== taskId) return;
      setProposals(proposalData.proposals ?? []);
      setActivity(activityData);
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || selectedTaskIdRef.current !== taskId) return;
      setPageError("We couldn't refresh this automation. Please try again.");
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setIdentity(await loadCanonicalIdentity(fetch, controller.signal));
      } catch (error) {
        if (!isAbortError(error)) setIdentity(null);
      } finally {
        if (!controller.signal.aborted) setIdentityResolved(true);
      }
    })();
    return () => controller.abort();
  }, []);
  useEffect(
    () => () => {
      abortTaskRequests();
      ingestRequestRef.current?.controller.abort();
      ingestRequestRef.current = null;
    },
    [abortTaskRequests]
  );
  useEffect(() => {
    if (selectedTaskId) {
      const controller = new AbortController();
      void refreshTaskViews(selectedTaskId, controller.signal);
      return () => controller.abort();
    } else {
      setProposals([]);
      setActivity([]);
    }
    return undefined;
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
        setTasksLoading(true);
        const result = await joinAndReloadTasks<Task>(taskId);
        setTasks(result.tasks);
        if (result.joined) {
          selectTask(taskId);
          setPageError(null);
          setNotice('You joined the automation.');
        } else {
          setPageError("That automation couldn't be joined just now. Your access hasn't changed; please try again.");
        }
      } catch {
        setPageError("We couldn't confirm whether that automation was joined. Refresh the page to check your access.");
      } finally {
        setTasksLoading(false);
      }
    },
    [selectTask]
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
    if (ingestEnabled && (!targetCatalog.trim() || !targetSchema.trim() || !targetTable.trim())) {
      setCreateError('Add a target catalog, schema, and table.');
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
          target_catalog: ingestEnabled ? targetCatalog.trim() : null,
          target_schema: ingestEnabled ? targetSchema.trim() : null,
          target_table: ingestEnabled ? targetTable.trim() : null,
        }),
      });
      if (!response.ok) throw new Error('create');
      const task = (await response.json()) as Task;
      setCreateOpen(false);
      setCreateName('');
      setIngestEnabled(false);
      setTargetCatalog('');
      setTargetSchema('');
      setTargetTable('');
      await loadTasks(task.task_id);
      setNotice('Automation created.');
    } catch {
      setCreateError("We couldn't create that automation. Check the details and try again.");
    } finally {
      setCreating(false);
    }
  }, [createName, createType, ingestEnabled, loadTasks, targetCatalog, targetSchema, targetTable]);

  const canIngest = Boolean(
    selectedTask?.ingest_enabled &&
      selectedTask.target_catalog &&
      selectedTask.target_schema &&
      selectedTask.target_table
  );

  const uploadForPreview = useCallback(
    async (file: File) => {
      if (!selectedTask || !canIngest) return;
      const taskId = selectedTask.task_id;
      ingestRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const active: ActiveIngest = { controller, taskId };
      ingestRequestRef.current = active;
      const isCurrent = (parseId?: string) =>
        selectedTaskIdRef.current === taskId && isCurrentIngest(ingestRequestRef.current, controller, taskId, parseId);
      if (!isCurrent()) return;
      setPreview(null);
      setSelectedPreviewRows(new Set());
      setIngestState((state) => reduceIngest(state, { type: 'START' }));
      try {
        const upload = await fetch(`/api/ingest/${encodeURIComponent(taskId)}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'x-upload-filename': encodeURIComponent(file.name) },
          body: file,
          signal: controller.signal,
        });
        const accepted = (await upload.json()) as { parse_id?: string; run_id?: number; error?: string };
        if (!isCurrent()) return;
        if (!upload.ok || !accepted.parse_id || typeof accepted.run_id !== 'number') {
          throw new Error(accepted.error ?? 'We could not upload that file.');
        }
        const parseId = accepted.parse_id;
        active.parseId = parseId;
        if (!isCurrent(parseId)) return;
        setIngestState((state) => reduceIngest(state, { type: 'ACCEPTED', parseId, runId: accepted.run_id! }));

        const started = Date.now();
        while (Date.now() - started < 120_000) {
          await abortableDelay(1500, controller.signal);
          if (!isCurrent(parseId)) return;
          const poll = await fetch(`/api/ingest/${encodeURIComponent(parseId)}/poll`, { signal: controller.signal });
          const status = (await poll.json()) as { status?: PollStatus; message?: string; error?: string };
          if (!isCurrent(parseId)) return;
          if (!poll.ok || !status.status) throw new Error(status.error ?? 'We could not check the parser.');
          setIngestState((state) => reduceIngest(state, { type: 'POLL', status: status.status! }));
          if (status.status === 'succeeded') {
            const result = await fetch(`/api/ingest/${encodeURIComponent(parseId)}/preview`, {
              signal: controller.signal,
            });
            const parsed = (await result.json()) as ParsePreview & { error?: string };
            if (!isCurrent(parseId)) return;
            if (!result.ok) throw new Error(parsed.error ?? 'The preview is not ready.');
            setPreview(parsed);
            setIngestState((state) => reduceIngest(state, { type: 'PREVIEW_READY' }));
            return;
          }
          if (status.status === 'failed') {
            throw new Error(status.message ?? 'The parser could not finish safely. Nothing was changed.');
          }
        }
        throw new Error('Parsing is taking longer than expected. You can close this window and try again.');
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (!isCurrent(active.parseId)) return;
        const message = error instanceof Error ? error.message : 'We could not create a preview.';
        setIngestState((state) => reduceIngest(state, { type: 'FAIL', message }));
      } finally {
        if (ingestRequestRef.current?.controller === controller) ingestRequestRef.current = null;
      }
    },
    [canIngest, selectedTask]
  );

  const confirmPreview = useCallback(async () => {
    if (!selectedTask || !preview || !ingestState.parseId || selectedPreviewRows.size === 0) return;
    // TODO: stage_change must become task-type-aware before vendor-bank-detail ingest can be staged safely.
    if (!['reconciliation', 'allocation_upsert', 'receivables'].includes(selectedTask.task_type)) return;
    if (!claimConfirmation(confirmSubmissionRef)) return;
    setConfirmSubmitting(true);
    const taskId = selectedTask.task_id;
    const parseId = ingestState.parseId;
    const controller = new AbortController();
    ingestRequestRef.current?.controller.abort();
    ingestRequestRef.current = { controller, taskId, parseId };
    const isCurrent = () =>
      selectedTaskIdRef.current === taskId &&
      isCurrentIngest(ingestRequestRef.current, controller, taskId, parseId) &&
      preview.parse_id === parseId;
    setIngestState((state) => reduceIngest(state, { type: 'CONFIRM' }));
    try {
      const response = await fetch('/api/ingest/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parse_id: parseId, selected_row_ids: [...selectedPreviewRows].sort((a, b) => a - b) }),
        signal: controller.signal,
      });
      const result = (await response.json()) as { proposal_ids?: string[]; error?: string; message?: string };
      if (!isCurrent()) return;
      if (!response.ok || !result.proposal_ids?.length)
        throw new Error(result.error ?? 'We could not stage those rows.');
      setIngestState((state) => reduceIngest(state, { type: 'STAGED', message: result.message }));
      await refreshTaskViews(taskId, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error) || !isCurrent()) return;
      setIngestState((state) =>
        reduceIngest(state, {
          type: 'FAIL',
          message:
            error instanceof Error ? error.message : 'We could not safely stage those rows. Nothing was changed.',
        })
      );
    } finally {
      if (ingestRequestRef.current?.controller === controller) ingestRequestRef.current = null;
      confirmSubmissionRef.current = false;
      setConfirmSubmitting(false);
    }
  }, [ingestState.parseId, preview, refreshTaskViews, selectedPreviewRows, selectedTask]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy || !selectedTaskId) return;
      const taskId = selectedTaskId;
      const controller = new AbortController();
      chatControllerRef.current?.abort();
      chatControllerRef.current = controller;
      setInput('');
      setPageError(null);
      setBusy(true);
      setMessagesByTask((all) => ({ ...all, [taskId]: [...(all[taskId] ?? [START_MESSAGE]), { role: 'you', text }] }));
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, task_id: taskId }),
          signal: controller.signal,
        });
        const data = (await response.json()) as ChatResponse;
        if (controller.signal.aborted || selectedTaskIdRef.current !== taskId) return;
        if (!response.ok || data.error) {
          setPageError(friendlyError(data.sqlstate, FRIENDLY_CHAT_ERROR));
        } else {
          setMessagesByTask((all) => ({
            ...all,
            [taskId]: [
              ...(all[taskId] ?? [START_MESSAGE]),
              {
                role: 'co-worker',
                text: data.reply || FRIENDLY_CHAT_ERROR,
                events: data.tool_events,
              },
            ],
          }));
        }
        if (data.proposals) setProposals(data.proposals);
        if (!controller.signal.aborted && selectedTaskIdRef.current === taskId) {
          await refreshTaskViews(taskId, controller.signal);
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || selectedTaskIdRef.current !== taskId) return;
        setPageError(FRIENDLY_CHAT_ERROR);
      } finally {
        if (chatControllerRef.current === controller) {
          chatControllerRef.current = null;
          if (!controller.signal.aborted && selectedTaskIdRef.current === taskId) setBusy(false);
        }
      }
    },
    [busy, refreshTaskViews, selectedTaskId]
  );

  const act = useCallback(
    async (kind: 'approve' | 'commit', proposal: Proposal) => {
      if (!selectedTaskId) return;
      const taskId = selectedTaskId;
      const controller = new AbortController();
      actionControllersRef.current.add(controller);
      try {
        const response = await fetch(`/api/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposal_id: proposal.proposal_id, task_id: taskId }),
          signal: controller.signal,
        });
        const data = (await response.json()) as ActionResponse;
        if (controller.signal.aborted || selectedTaskIdRef.current !== taskId) return;
        const outcome: Outcome = data.ok
          ? {
              kind: 'success',
              message: kind === 'commit' ? appliedMessage(proposal) : 'Approved — this change is ready to apply.',
              technical: data.audit,
            }
          : { kind: 'error', message: friendlyError(data.sqlstate, FRIENDLY_ERROR) };
        setOutcomes((all) => ({ ...all, [proposal.proposal_id]: outcome }));
        if (!controller.signal.aborted && selectedTaskIdRef.current === taskId) {
          await refreshTaskViews(taskId, controller.signal);
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || selectedTaskIdRef.current !== taskId) return;
        setOutcomes((all) => ({ ...all, [proposal.proposal_id]: { kind: 'error', message: FRIENDLY_ERROR } }));
      } finally {
        actionControllersRef.current.delete(controller);
      }
    },
    [refreshTaskViews, selectedTaskId]
  );

  const taskContext = useMemo(() => ({ selectedTaskId }), [selectedTaskId]);

  return (
    <TaskContext.Provider value={taskContext}>
      <TooltipProvider>
        <div className="h-screen flex flex-col bg-background text-foreground">
          <AppHeader
            identity={identity}
            identityResolved={identityResolved}
            tasksLoading={tasksLoading}
            selectedTaskId={selectedTaskId}
            selectedTask={selectedTask}
            ownTasks={ownTasks}
            availableTasks={availableTasks}
            onTaskChoice={handleTaskChoice}
          />
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
              <ChatView
                messages={messages}
                busy={busy}
                input={input}
                canIngest={canIngest}
                scrollRef={scrollRef}
                fileInputRef={fileInputRef}
                onInputChange={setInput}
                onSend={(text) => void send(text)}
                onUpload={(file) => {
                  setIngestOpen(true);
                  void uploadForPreview(file);
                }}
              />
              <DetailsPanel
                proposals={proposals}
                activity={activity}
                identity={identity}
                outcomes={outcomes}
                onAction={(kind, proposal) => void act(kind, proposal)}
              />
            </div>
          )}
          <CreateTaskDialog
            open={createOpen}
            name={createName}
            type={createType}
            ingestEnabled={ingestEnabled}
            targetCatalog={targetCatalog}
            targetSchema={targetSchema}
            targetTable={targetTable}
            error={createError}
            creating={creating}
            onOpenChange={setCreateOpen}
            onNameChange={setCreateName}
            onTypeChange={setCreateType}
            onIngestEnabledChange={setIngestEnabled}
            onTargetCatalogChange={setTargetCatalog}
            onTargetSchemaChange={setTargetSchema}
            onTargetTableChange={setTargetTable}
            onCreate={() => void createTask()}
          />
          <IngestDialog
            open={ingestOpen}
            state={ingestState}
            preview={preview}
            selectedRows={selectedPreviewRows}
            selectedTask={selectedTask}
            confirmSubmitting={confirmSubmitting}
            onOpen={() => setIngestOpen(true)}
            onClose={closeIngest}
            onSelectedRowsChange={setSelectedPreviewRows}
            onConfirm={() => void confirmPreview()}
          />
        </div>
      </TooltipProvider>
    </TaskContext.Provider>
  );
}
