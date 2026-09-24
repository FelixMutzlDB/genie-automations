import type { Dispatch, SetStateAction } from 'react';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@databricks/appkit-ui/react';
import { humanizeIngestReject, type IngestUiState } from '../lib/ingestState';
import type { ParsePreview, Task } from '../types';

const INGEST_SUPPORTED_TASK_TYPES = ['reconciliation', 'allocation_upsert', 'receivables'];

interface IngestDialogProps {
  open: boolean;
  state: IngestUiState;
  preview: ParsePreview | null;
  selectedRows: Set<number>;
  selectedTask: Task | null;
  confirmSubmitting: boolean;
  humanReviewed: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelectedRowsChange: Dispatch<SetStateAction<Set<number>>>;
  onConfirm: () => void;
  onHumanReviewedChange: (reviewed: boolean) => void;
}

export function IngestDialog({
  open,
  state,
  preview,
  selectedRows,
  selectedTask,
  confirmSubmitting,
  humanReviewed,
  onOpen,
  onClose,
  onSelectedRowsChange,
  onConfirm,
  onHumanReviewedChange,
}: IngestDialogProps) {
  const supportsStaging = INGEST_SUPPORTED_TASK_TYPES.includes(selectedTask?.task_type ?? '');

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpen() : onClose())}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>File parse preview</DialogTitle>
          <DialogDescription>
            Review and select the rows you want to prepare for a separate human review.
          </DialogDescription>
        </DialogHeader>
        {state.phase === 'uploading' && <p>Uploading the original bytes and checking their fingerprint…</p>}
        {state.phase === 'parsing' && <p>Parsing safely in a separate job…</p>}
        {state.phase === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.phase === 'confirming' && <p>Preparing the selected rows for review…</p>}
        {state.phase === 'staged' && (
          <Alert>
            <AlertDescription>
              {state.message ??
                'Staged for review. The proposals are now available in the Proposals panel for another person to approve.'}
            </AlertDescription>
          </Alert>
        )}
        {state.phase === 'preview' && preview && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground break-all">SHA-256: {preview.sha256}</p>
            {preview.extraction_kind === 'probabilistic_image' && (
              <Alert>
                <AlertDescription>
                  This preview was read from an image by an AI model. It can be wrong. Check every identifier and amount against the image before staging.
                </AlertDescription>
              </Alert>
            )}
            {preview.warnings.map((warning) => (
              <Alert key={warning}>
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}
            {preview.rejected_rows.map((rejected) => (
              <Alert key={`${rejected.code}-${rejected.source_row}`} variant="destructive">
                <AlertDescription>
                  {(() => {
                    const friendly = humanizeIngestReject(rejected.code);
                    return `${friendly.title}. ${friendly.guidance}${rejected.source_row ? ` Source row ${rejected.source_row}.` : ''}`;
                  })()}
                </AlertDescription>
              </Alert>
            ))}
            {preview.rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No accepted rows</EmptyTitle>
                </EmptyHeader>
                <EmptyDescription>Review the guidance above.</EmptyDescription>
              </Empty>
            ) : (
              <div className="space-y-3">
                {!supportsStaging && (
                  <Alert>
                    <AlertDescription>
                      Staging from upload is currently available for receivables collection only
                    </AlertDescription>
                  </Alert>
                )}
                {supportsStaging && (
                  <p className="text-sm">
                    {selectedRows.size === 0
                      ? 'Select the rows to stage. Nothing is applied yet.'
                      : `${selectedRows.size} ${selectedRows.size === 1 ? 'row' : 'rows'} selected. Confirming will create proposals for human review.`}
                  </p>
                )}
                <div className="overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted">
                        <th className="p-2 text-left">Select</th>
                        <th className="p-2 text-left">Source row</th>
                        {Object.keys(preview.rows[0]?.values ?? {}).map((column) => (
                          <th key={column} className="p-2 text-left">
                            {column.replaceAll('_', ' ')}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.source_row} className="border-b">
                          <td className="p-2">
                            <input
                              type="checkbox"
                              aria-label={`Select source row ${row.source_row}`}
                              checked={selectedRows.has(row.source_row)}
                              onChange={(event) =>
                                onSelectedRowsChange((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked) next.add(row.source_row);
                                  else next.delete(row.source_row);
                                  return next;
                                })
                              }
                            />
                          </td>
                          <td className="p-2">{row.source_row}</td>
                          {Object.keys(preview.rows[0]?.values ?? {}).map((column) => (
                            <td key={column} className="p-2">
                              {row.values[column] ?? '—'}
                              {row.review?.[column] && (
                                <span className="ml-2 text-xs text-amber-700">Needs your review</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.requires_human_confirmation && (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={humanReviewed}
                      onChange={(event) => onHumanReviewedChange(event.target.checked)}
                    />
                    <span>I reviewed these values against the image, including every amount and identifier.</span>
                  </label>
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {state.phase === 'preview' && supportsStaging && (
            <Button
              disabled={
                selectedRows.size === 0 ||
                confirmSubmitting ||
                (Boolean(preview?.requires_human_confirmation) && !humanReviewed)
              }
              onClick={onConfirm}
            >
              Confirm selected rows
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
