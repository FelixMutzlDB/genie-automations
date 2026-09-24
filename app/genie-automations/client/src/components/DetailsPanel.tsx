import { Tabs, TabsContent, TabsList, TabsTrigger } from '@databricks/appkit-ui/react';
import type { Activity, Outcome, Proposal } from '../types';
import { ActivityPanel } from './ActivityPanel';
import { ProposalsPanel } from './ProposalsPanel';

interface DetailsPanelProps {
  proposals: Proposal[];
  activity: Activity[];
  identity: string | null;
  outcomes: Record<string, Outcome>;
  onAction: (kind: 'approve' | 'commit', proposal: Proposal) => void;
}

export function DetailsPanel(props: DetailsPanelProps) {
  return (
    <aside className="min-h-0 overflow-auto p-4" aria-label="Automation details">
      <Tabs defaultValue="proposals">
        <TabsList className="w-full">
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
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
      </Tabs>
    </aside>
  );
}
