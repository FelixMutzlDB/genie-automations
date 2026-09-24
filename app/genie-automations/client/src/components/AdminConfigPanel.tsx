import { useEffect, useState } from 'react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@databricks/appkit-ui/react';
import {
  approveBinding,
  loadAllowedDestinations,
  loadConfigRequests,
  proposeBinding,
  publishConfig,
  retireConfig,
} from '../lib/configGovernance';
import type { ConfigRequest, Task } from '../types';

function calmError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.toLowerCase().includes('different admin')) {
    return 'A different administrator must complete this approval. This separation protects the destination and its data.';
  }
  if (message.toLowerCase().includes('active binding')) {
    return 'Approve the destination first, then have a different administrator publish this configuration.';
  }
  return message || 'That action could not be completed. Nothing was changed.';
}

interface AdminConfigPanelProps {
  tasks: Task[];
  onChanged: () => void;
}

export function AdminConfigPanel({ tasks, onChanged }: AdminConfigPanelProps) {
  const [requests, setRequests] = useState<ConfigRequest[]>([]);
  const [destinations, setDestinations] = useState<string[]>([]);
  const [taskId, setTaskId] = useState('');
  const [destination, setDestination] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRequests, nextDestinations] = await Promise.all([
        loadConfigRequests(),
        loadAllowedDestinations(),
      ]);
      setRequests(nextRequests);
      setDestinations(nextDestinations);
    } catch (loadError) {
      setError(calmError(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (key: string, action: () => Promise<unknown>, success: string) => {
    setWorking(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await load();
      onChanged();
    } catch (actionError) {
      setError(calmError(actionError));
    } finally {
      setWorking(null);
    }
  };

  if (loading) return <Skeleton className="h-52 w-full" />;

  const pending = requests.filter(
    (request) => request.binding_status === 'pending' || request.config_status === 'draft'
  );
  const published = requests.filter((request) => request.config_status === 'published');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Bind a destination</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Propose only a deployment-approved destination. A different administrator must approve it.
          </p>
          <Select value={taskId || undefined} onValueChange={setTaskId}>
            <SelectTrigger aria-label="Automation to bind"><SelectValue placeholder="Choose an automation" /></SelectTrigger>
            <SelectContent>
              {tasks.map((task) => <SelectItem key={task.task_id} value={task.task_id}>{task.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={destination || undefined} onValueChange={setDestination}>
            <SelectTrigger aria-label="Approved destination"><SelectValue placeholder="Choose an approved destination" /></SelectTrigger>
            <SelectContent>
              {destinations.map((allowed) => <SelectItem key={allowed} value={allowed}>{allowed}</SelectItem>)}
            </SelectContent>
          </Select>
          {destinations.length === 0 && (
            <Alert><AlertDescription>No deployment-approved destinations are configured.</AlertDescription></Alert>
          )}
          <Button
            disabled={!taskId || !destination || working !== null}
            onClick={() => void act('propose', () => proposeBinding(taskId, destination), 'Destination proposed for independent approval.')}
          >
            Propose binding
          </Button>
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="pending-config-title">
        <h3 id="pending-config-title" className="font-semibold">Pending configuration requests</h3>
        {pending.length === 0 ? (
          <Empty>
            <EmptyHeader><EmptyTitle>No pending requests</EmptyTitle></EmptyHeader>
            <EmptyDescription>New binding proposals and owner drafts will appear here.</EmptyDescription>
          </Empty>
        ) : pending.map((request) => (
          <Card key={`${request.task_id}-${request.binding_id}-${request.version_hash}`}>
            <CardContent className="space-y-3 pt-5">
              <div className="flex items-start justify-between gap-2">
                <div><p className="font-medium">{request.name}</p><p className="text-xs text-muted-foreground">{request.task_type.replaceAll('_', ' ')}</p></div>
                <div className="flex gap-1">
                  {request.binding_status === 'pending' && <Badge variant="secondary">Binding pending</Badge>}
                  {request.config_status === 'draft' && <Badge variant="secondary">Config draft</Badge>}
                </div>
              </div>
              {request.binding_id && request.binding_status === 'pending' && (
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working !== null}
                    onClick={() => void act(
                      `approve-${request.binding_id}`,
                      () => approveBinding(request.task_id, request.binding_id!),
                      'Destination approved.'
                    )}
                  >Approve binding</Button>
                  <p className="mt-1 text-xs text-muted-foreground">Must be approved by an admin other than the proposer.</p>
                </div>
              )}
              {request.version_hash && request.config_status === 'draft' && (
                <Button
                  size="sm"
                  disabled={working !== null}
                  onClick={() => void act(
                    `publish-${request.version_hash}`,
                    () => publishConfig(request.task_id, request.version_hash!),
                    'Configuration published. The automation is ready when ingest is enabled.'
                  )}
                >Publish configuration</Button>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {published.length > 0 && (
        <section className="space-y-3" aria-labelledby="published-config-title">
          <h3 id="published-config-title" className="font-semibold">Published configurations</h3>
          {published.map((request) => (
            <Card key={`${request.task_id}-${request.version_hash}`}>
              <CardContent className="flex items-center justify-between gap-3 pt-5">
                <div><p className="font-medium">{request.name}</p><p className="text-xs text-muted-foreground">Active configuration</p></div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working !== null}
                  onClick={() => void act(
                    `retire-${request.version_hash}`,
                    () => retireConfig(request.task_id, request.version_hash!),
                    'Configuration retired. New uploads and staging are now unavailable.'
                  )}
                >Retire</Button>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
    </div>
  );
}
