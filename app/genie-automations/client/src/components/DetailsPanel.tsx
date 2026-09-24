import { Tabs, TabsContent, TabsList, TabsTrigger } from '@databricks/appkit-ui/react';
import type { Activity, Outcome, Proposal, Task } from '../types';
import { shouldShowAdminSurface } from '../lib/governanceState';
import { ActivityPanel } from './ActivityPanel';
import { AdminConfigPanel } from './AdminConfigPanel';
import { AutomationSettings } from './AutomationSettings';
import { ProposalsPanel } from './ProposalsPanel';

interface DetailsPanelProps {
  proposals: Proposal[];
  activity: Activity[];
  identity: string | null;
  outcomes: Record<string, Outcome>;
  onAction: (kind: 'approve' | 'commit', proposal: Proposal) => void;
  selectedTask: Task;
  tasks: Task[];
  isAdmin: boolean;
  onIngestCapabilityChange: (enabled: boolean) => void;
  onGovernanceChanged: () => void;
}

export function DetailsPanel(props: DetailsPanelProps) {
  return (
    <aside className="min-h-0 overflow-auto p-4" aria-label="Automation details">
      <Tabs defaultValue="proposals">
        <TabsList className="w-full">
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          {props.selectedTask.role === 'owner' && <TabsTrigger value="settings">Settings</TabsTrigger>}
          {shouldShowAdminSurface(props.isAdmin) && <TabsTrigger value="admin">Admin</TabsTrigger>}
        </TabsList>
        <TabsContent value="proposals" className="space-y-3 pt-3">
          <ProposalsPanel
            proposals={props.proposals}
            identity={props.identity}
            outcomes={props.outcomes}
            onAction={props.onAction}
          />
        </TabsContent>
        <TabsContent value="activity" className="space-y-3 pt-3">
          <ActivityPanel activity={props.activity} />
        </TabsContent>
        {props.selectedTask.role === 'owner' && (
          <TabsContent value="settings" className="space-y-3 pt-3">
            <AutomationSettings
              task={props.selectedTask}
              onIngestCapabilityChange={props.onIngestCapabilityChange}
              onChanged={props.onGovernanceChanged}
            />
          </TabsContent>
        )}
        {shouldShowAdminSurface(props.isAdmin) && (
          <TabsContent value="admin" className="space-y-3 pt-3">
            <AdminConfigPanel tasks={props.tasks} onChanged={props.onGovernanceChanged} />
          </TabsContent>
        )}
      </Tabs>
    </aside>
  );
}
