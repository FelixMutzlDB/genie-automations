import { useEffect, useState } from 'react';
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
  Input,
  Label,
  Skeleton,
  Switch,
} from '@databricks/appkit-ui/react';
import { loadTaskConfig, saveConfigDraft, submitConfigDraft } from '../lib/configGovernance';
import { canUseIngest, governanceLabel } from '../lib/governanceState';
import type { OwnerSettings, Task, TaskConfig } from '../types';

const DEFAULT_SETTINGS: OwnerSettings = {
  ingest_enabled: false,
  validation_thresholds: { over_allocation_ceiling: 1, structural_confidence_floor: 0.8 },
  header_aliases: {},
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'We could not update these settings. Nothing was changed.';
}

interface AutomationSettingsProps {
  task: Task;
  onIngestCapabilityChange: (enabled: boolean) => void;
  onChanged: () => void;
}

export function AutomationSettings({ task, onIngestCapabilityChange, onChanged }: AutomationSettingsProps) {
  const [config, setConfig] = useState<TaskConfig | null>(null);
  const [settings, setSettings] = useState<OwnerSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadTaskConfig(task.task_id);
      setConfig(next);
      setSettings(next.settings ?? DEFAULT_SETTINGS);
      onIngestCapabilityChange(canUseIngest(task, next));
    } catch (loadError) {
      setError(messageOf(loadError));
      onIngestCapabilityChange(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [task.task_id, task.governance_status]); // eslint-disable-line react-hooks/exhaustive-deps

  const aliases = Object.entries(settings.header_aliases);
  const updateAlias = (index: number, key: string, values: string) => {
    const entries = [...aliases];
    entries[index] = [
      key.trim(),
      values
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ];
    setSettings({ ...settings, header_aliases: Object.fromEntries(entries.filter(([name]) => name)) });
  };

  const save = async () => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await saveConfigDraft(task.task_id, settings);
      setNotice('Draft saved. Submit it when it is ready for admin review.');
      await load();
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setWorking(false);
    }
  };

  const submit = async () => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await submitConfigDraft(task.task_id);
      setNotice('Submitted for admin review. A different administrator will publish it after the destination is active.');
      onChanged();
      await load();
    } catch (submitError) {
      setError(messageOf(submitError));
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <Skeleton className="h-48 w-full" />;

  const destination = [config?.dest_catalog, config?.dest_schema, config?.dest_table].filter(Boolean).join('.');
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Automation settings</CardTitle>
            <Badge variant={task.governance_status === 'active' ? 'default' : 'secondary'}>
              {governanceLabel(task.governance_status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label>Destination</Label>
            <p className="mt-1 rounded-md border bg-muted px-3 py-2 text-sm break-all">
              {destination || 'No destination has been bound yet.'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Only an administrator can bind or change this destination.</p>
          </div>

          {task.governance_status !== 'active' && (
            <Alert>
              <AlertDescription>
                Uploading and staging stay unavailable until an administrator approves a destination and publishes a configuration.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="settings-ingest">File ingest</Label>
              <p className="text-xs text-muted-foreground">Allow CSV or Excel files after governance is active.</p>
            </div>
            <Switch
              id="settings-ingest"
              checked={settings.ingest_enabled}
              onCheckedChange={(checked) => setSettings({ ...settings, ingest_enabled: checked })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="allocation-ceiling">Maximum allocation ratio</Label>
              <Input
                id="allocation-ceiling"
                type="number"
                min="0.01"
                max="1"
                step="0.01"
                value={settings.validation_thresholds.over_allocation_ceiling}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    validation_thresholds: {
                      ...settings.validation_thresholds,
                      over_allocation_ceiling: Number(event.target.value),
                    },
                  })
                }
              />
              <p className="text-xs text-muted-foreground">Up to 1.00; allocations may never exceed the source total.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confidence-floor">Minimum structure confidence</Label>
              <Input
                id="confidence-floor"
                type="number"
                min="0.8"
                max="1"
                step="0.01"
                value={settings.validation_thresholds.structural_confidence_floor}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    validation_thresholds: {
                      ...settings.validation_thresholds,
                      structural_confidence_floor: Number(event.target.value),
                    },
                  })
                }
              />
              <p className="text-xs text-muted-foreground">The platform minimum is 0.80.</p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Header aliases</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setSettings({ ...settings, header_aliases: { ...settings.header_aliases, '': [] } })
                }
              >
                Add alias
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Map a standard header to accepted source names, separated by commas.</p>
            {aliases.length === 0 && <p className="text-sm text-muted-foreground">No custom aliases.</p>}
            {aliases.map(([name, values], index) => (
              // The editable name cannot be a stable key; position preserves focus while it changes.
              // eslint-disable-next-line react/no-array-index-key
              <div key={index} className="grid grid-cols-[1fr_1.5fr_auto] gap-2">
                <Input
                  aria-label={`Standard header ${index + 1}`}
                  placeholder="Standard header"
                  value={name}
                  onChange={(event) => updateAlias(index, event.target.value, values.join(', '))}
                />
                <Input
                  aria-label={`Accepted aliases ${index + 1}`}
                  placeholder="Source header, another header"
                  value={values.join(', ')}
                  onChange={(event) => updateAlias(index, name, event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setSettings({
                      ...settings,
                      header_aliases: Object.fromEntries(aliases.filter((_, item) => item !== index)),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>

          {error && (
            <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
          )}
          {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
          <div className="flex gap-2">
            <Button variant="outline" disabled={working} onClick={() => void save()}>Save draft</Button>
            <Button disabled={working || config?.status !== 'draft'} onClick={() => void submit()}>Submit for review</Button>
          </div>

          {config?.active_version_hash && (
            <Accordion type="single" collapsible>
              <AccordionItem value="technical">
                <AccordionTrigger>Technical details</AccordionTrigger>
                <AccordionContent>
                  <p className="text-xs text-muted-foreground break-all">Active configuration fingerprint: {config.active_version_hash}</p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
