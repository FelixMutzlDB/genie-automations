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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@databricks/appkit-ui/react';
import { humanizeActor, summarizeChange } from '../lib/humanize';
import type { Outcome, Proposal } from '../types';

const STATE_LABELS: Record<string, string> = {
  staged: 'Awaiting review',
  validated: 'Checked',
  approved: 'Approved',
  committed: 'Applied',
  rejected: 'Rejected',
  expired: 'Expired',
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Details unavailable';
  }
}

interface ProposalsPanelProps {
  proposals: Proposal[];
  identity: string | null;
  outcomes: Record<string, Outcome>;
  onAction: (kind: 'approve' | 'commit', proposal: Proposal) => void;
}

export function ProposalsPanel({ proposals, identity, outcomes, onAction }: ProposalsPanelProps) {
  return (
    <>
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
                <CardTitle className="text-base">{summarizeChange(proposal.change_type, proposal.diff)}</CardTitle>
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
                        onClick={() => onAction('approve', proposal)}
                      >
                        Approve
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {isProposer && <TooltipContent>A second person must approve a change you proposed.</TooltipContent>}
                </Tooltip>
                <Button size="sm" disabled={!canApply} onClick={() => onAction('commit', proposal)}>
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
    </>
  );
}
