import { useEffect, useState } from 'react';
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from '@databricks/appkit-ui/react';
import {
  evaluateReminders,
  loadChaseApprovalQueue,
  loadReminderConfig,
  loadReminderPreview,
  reviewChaseBatch,
  saveReminderConfig,
} from '../lib/reminders';
import type { ChaseApprovalBatch, ReminderConfig, ReminderPreview, Task } from '../types';

const DEFAULT_CONFIG: ReminderConfig = {
  enabled: true,
  cadence: 'daily',
  due_offset_days: 2,
  default_due_at: null,
  approach_offsets: [7, 2],
  post_due_offsets: [1, 7, 14],
  quiet_hours_start: '18:00',
  quiet_hours_end: '08:00',
  timezone: 'Europe/Berlin',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "We couldn't load reminders right now. Try again.";
}

function offsets(value: string): number[] {
  return [
    ...new Set(
      value
        .split(',')
        .map(Number)
        .filter((item) => Number.isInteger(item) && item > 0)
    ),
  ];
}

function money(value: string | number): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(value));
}

function dueDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(
    new Date(value)
  );
}

export function RemindersPanel({ task }: { task: Task }) {
  const [config, setConfig] = useState<ReminderConfig>(DEFAULT_CONFIG);
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<ChaseApprovalBatch[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, nextPreview, queue] = await Promise.all([
        loadReminderConfig(task.task_id),
        loadReminderPreview(task.task_id),
        loadChaseApprovalQueue(),
      ]);
      setConfig(settings.config ?? DEFAULT_CONFIG);
      setCanEdit(settings.can_edit);
      setPreview(nextPreview);
      setApprovalQueue(queue.batches);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  const reviewBatch = async (batch: ChaseApprovalBatch, action: 'approve' | 'archive') => {
    const verb = action === 'approve' ? 'approve' : 'archive';
    if (!window.confirm(`Confirm you want to ${verb} ${batch.item_count} reminder${batch.item_count === 1 ? '' : 's'} for ${batch.task_name}?`)) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const result = await reviewChaseBatch(batch.batch_id, action);
      setApprovalQueue((current) => current.filter((item) => item.batch_id !== batch.batch_id));
      setNotice(result.message);
    } catch (reviewError) {
      setError(errorMessage(reviewError));
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    void load();
  }, [task.task_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await saveReminderConfig(task.task_id, config);
      await evaluateReminders(task.task_id);
      setPreview(await loadReminderPreview(task.task_id));
      setNotice('Reminder schedule saved and preview refreshed. Nothing was sent.');
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setWorking(false);
    }
  };

  const refresh = async () => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await evaluateReminders(task.task_id);
      setPreview(await loadReminderPreview(task.task_id));
      setNotice('Dry-run refreshed. Nothing was sent.');
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      setWorking(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 overflow-auto p-5">
      <div>
        <h2 className="text-xl font-semibold">Internal reminders</h2>
        <p className="text-sm text-muted-foreground">
          Review approaching and overdue receivables before any notification transport is enabled.
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Approval queue</CardTitle>
          <CardDescription>
            Review each generated batch before it can enter the internal email digest.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {approvalQueue.length ? (
            approvalQueue.map((batch) => (
              <div key={batch.batch_id} className="space-y-3 rounded-md border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{batch.task_name}</p>
                    <p className="text-xs text-muted-foreground">Owner: {batch.owner_email}</p>
                  </div>
                  <Badge variant="outline">{batch.item_count} affected</Badge>
                </div>
                <p className="text-sm">
                  {batch.offset_kinds.join(', ').replaceAll('_', ' ')} · due{' '}
                  {batch.due_dates.map((value) => new Date(value).toLocaleDateString('en-GB')).join(', ')}
                </p>
                <p className="text-xs text-muted-foreground">
                  Preview: {batch.item_preview.join(', ')}
                  {batch.item_count > batch.item_preview.length ? ` and ${batch.item_count - batch.item_preview.length} more` : ''}
                </p>
                <div className="flex gap-2">
                  <Button disabled={working} onClick={() => void reviewBatch(batch, 'approve')}>Approve digest</Button>
                  <Button variant="outline" disabled={working} onClick={() => void reviewBatch(batch, 'archive')}>Reject and archive</Button>
                </div>
              </div>
            ))
          ) : (
            <Empty>
              <EmptyHeader><EmptyTitle>No batches awaiting approval</EmptyTitle></EmptyHeader>
              <EmptyDescription>New scheduler output will appear here for an owner or collections approver.</EmptyDescription>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule and due-date policy</CardTitle>
          <CardDescription>
            {canEdit
              ? 'Changes affect status calculation only.'
              : 'Only the owner or an administrator can edit this policy.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="reminders-enabled">Reminders enabled</Label>
              <p className="text-xs text-muted-foreground">Controls whether items appear in the dry-run.</p>
            </div>
            <Switch
              id="reminders-enabled"
              checked={config.enabled}
              disabled={!canEdit}
              onCheckedChange={(enabled) => setConfig({ ...config, enabled })}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Review cadence</Label>
              <Select
                value={config.cadence}
                disabled={!canEdit}
                onValueChange={(cadence) => setConfig({ ...config, cadence: cadence as ReminderConfig['cadence'] })}
              >
                <SelectTrigger aria-label="Review cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="due-offset">Days after period end</Label>
              <Input
                id="due-offset"
                type="number"
                min="-31"
                max="366"
                disabled={!canEdit}
                value={config.due_offset_days}
                onChange={(event) => setConfig({ ...config, due_offset_days: Number(event.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reminder-timezone">Timezone</Label>
              <Input
                id="reminder-timezone"
                disabled={!canEdit}
                value={config.timezone}
                onChange={(event) => setConfig({ ...config, timezone: event.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="approach-offsets">Approach days before due</Label>
              <Input
                id="approach-offsets"
                disabled={!canEdit}
                value={config.approach_offsets.join(', ')}
                onChange={(event) => setConfig({ ...config, approach_offsets: offsets(event.target.value) })}
              />
              <p className="text-xs text-muted-foreground">For example: 7, 2</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="post-offsets">Follow-up days after due</Label>
              <Input
                id="post-offsets"
                disabled={!canEdit}
                value={config.post_due_offsets.join(', ')}
                onChange={(event) => setConfig({ ...config, post_due_offsets: offsets(event.target.value) })}
              />
              <p className="text-xs text-muted-foreground">For example: 1, 7, 14</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="quiet-start">Quiet hours start</Label>
              <Input
                id="quiet-start"
                type="time"
                disabled={!canEdit}
                value={config.quiet_hours_start.slice(0, 5)}
                onChange={(event) => setConfig({ ...config, quiet_hours_start: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quiet-end">Quiet hours end</Label>
              <Input
                id="quiet-end"
                type="time"
                disabled={!canEdit}
                value={config.quiet_hours_end.slice(0, 5)}
                onChange={(event) => setConfig({ ...config, quiet_hours_end: event.target.value })}
              />
            </div>
          </div>
          {canEdit && (
            <Button
              disabled={working || config.approach_offsets.length === 0 || config.post_due_offsets.length === 0}
              onClick={() => void save()}
            >
              {working ? 'Saving…' : 'Save and refresh dry-run'}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Dry-run preview</CardTitle>
              <CardDescription>
                Internal recipients only; this preview never sends or marks an item notified.
              </CardDescription>
            </div>
            {canEdit && (
              <Button variant="outline" disabled={working} onClick={() => void refresh()}>
                Refresh
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {preview && (
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{preview.counts.total} total</Badge>
              <Badge variant="secondary">{preview.counts.approaching} approaching</Badge>
              <Badge variant={preview.counts.overdue ? 'destructive' : 'outline'}>
                {preview.counts.overdue} overdue
              </Badge>
            </div>
          )}
          {preview?.items.length ? (
            <>
              <p className="text-sm">{preview.summary}</p>
              <div className="space-y-2">
                {preview.items.map((item) => (
                  <div
                    key={item.item_reference}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div>
                      <p className="font-medium">{item.item_reference}</p>
                      <p className="text-xs text-muted-foreground">
                        Due {dueDate(item.due_at, item.timezone)} · {money(item.outstanding_amount)} outstanding
                      </p>
                    </div>
                    <Badge variant={item.state === 'overdue' ? 'destructive' : 'secondary'}>
                      {item.state === 'overdue' ? 'Overdue' : 'Approaching due'}
                    </Badge>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No reminders due now</EmptyTitle>
              </EmptyHeader>
              <EmptyDescription>
                {preview?.summary ?? 'Save a schedule to calculate the first dry-run.'}
              </EmptyDescription>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
