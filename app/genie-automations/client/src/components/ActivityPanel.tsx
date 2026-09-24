import { Badge, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@databricks/appkit-ui/react';
import { Bot } from 'lucide-react';
import { humanizeActor } from '../lib/humanize';
import type { Activity } from '../types';

const ACTIVITY_LABELS: Record<string, string> = {
  chat: 'Asked the co-worker',
  approve: 'Approved a change',
  commit: 'Applied a change',
  ingest_confirm: 'Confirmed uploaded rows for review',
  task_created: 'Created this automation',
  joined: 'Joined this automation',
};

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return 'Recently';
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

export function ActivityPanel({ activity }: { activity: Activity[] }) {
  return (
    <>
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
            <p className="text-sm font-medium">{ACTIVITY_LABELS[item.action] ?? 'Worked on this automation'}</p>
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
    </>
  );
}
