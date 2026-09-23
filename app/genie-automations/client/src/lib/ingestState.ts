export type IngestPhase = 'idle' | 'uploading' | 'parsing' | 'preview' | 'confirming' | 'staged' | 'error';

export interface IngestUiState {
  phase: IngestPhase;
  parseId?: string;
  runId?: number;
  message?: string;
}

export type PollStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type IngestEvent =
  | { type: 'START' }
  | { type: 'ACCEPTED'; parseId: string; runId: number }
  | { type: 'POLL'; status: PollStatus }
  | { type: 'PREVIEW_READY' }
  | { type: 'CONFIRM' }
  | { type: 'STAGED' }
  | { type: 'FAIL'; message: string }
  | { type: 'RESET' };

export function reduceIngest(state: IngestUiState, event: IngestEvent): IngestUiState {
  switch (event.type) {
    case 'START':
      return { phase: 'uploading' };
    case 'ACCEPTED':
      return { phase: 'parsing', parseId: event.parseId, runId: event.runId };
    case 'POLL':
      if (event.status === 'failed') {
        return { ...state, phase: 'error', message: 'The parser could not finish safely.' };
      }
      return state;
    case 'PREVIEW_READY':
      return { ...state, phase: 'preview' };
    case 'CONFIRM':
      return { ...state, phase: 'confirming' };
    case 'STAGED':
      return { ...state, phase: 'staged' };
    case 'FAIL':
      return { ...state, phase: 'error', message: event.message };
    case 'RESET':
      return { phase: 'idle' };
  }
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ActiveIngest {
  controller: AbortController;
  taskId: string;
  parseId?: string;
}

export interface CloseIngestActions {
  closeDialog(): void;
  resetState(): void;
  clearPreview(): void;
}

export function closeIngestSession(active: ActiveIngest | null, actions: CloseIngestActions): null {
  active?.controller.abort();
  actions.closeDialog();
  actions.resetState();
  actions.clearPreview();
  return null;
}

export function isCurrentIngest(
  active: ActiveIngest | null,
  controller: AbortController,
  taskId: string,
  parseId?: string
): boolean {
  return Boolean(
    active &&
      active.controller === controller &&
      !controller.signal.aborted &&
      active.taskId === taskId &&
      (parseId === undefined || active.parseId === parseId)
  );
}

const REJECTION_GUIDANCE: Record<string, { title: string; guidance: string }> = {
  IG001: { title: 'This file format could not be verified', guidance: 'Choose a genuine CSV or XLSX file.' },
  IG002: { title: 'Macro-enabled workbooks are not accepted', guidance: 'Save a copy as a standard XLSX file.' },
  IG003: { title: 'Encrypted files are not accepted', guidance: 'Remove password protection and upload a new copy.' },
  IG004: { title: 'This file is too large', guidance: 'Reduce the file size and try again.' },
  IG005: {
    title: 'This workbook is not safe to open',
    guidance: 'Export a fresh XLSX or CSV copy from the source system.',
  },
  IG006: { title: 'This file contains too much data', guidance: 'Split it into smaller files and try again.' },
  IG007: {
    title: 'Required columns were not found',
    guidance: 'Check the column headings and upload a corrected file.',
  },
  IG008: { title: 'The amount column is unclear', guidance: 'Use one clearly labelled amount column.' },
  IG009: {
    title: 'A value could not be read safely',
    guidance: 'Check the highlighted source row and its number or date formatting.',
  },
  IG010: { title: 'Formulas are not accepted', guidance: 'Replace formulas with their final values before uploading.' },
  IG011: {
    title: 'The workbook has multiple possible sheets',
    guidance: 'Keep one relevant visible sheet and try again.',
  },
  IG012: { title: 'Two fields point to the same column', guidance: 'Give each required field its own column.' },
  IG013: { title: 'The text encoding is not supported', guidance: 'Save the file as UTF-8 CSV or XLSX.' },
  IG014: { title: 'The file could not be opened', guidance: 'Export a fresh copy and try again.' },
  IG015: { title: 'This spreadsheet type is not supported', guidance: 'Use CSV or XLSX.' },
  IG016: { title: 'The uploaded file changed unexpectedly', guidance: 'Upload the original file again.' },
};

export function humanizeIngestReject(code: string): { title: string; guidance: string } {
  return (
    REJECTION_GUIDANCE[code] ?? {
      title: 'This file could not be parsed safely',
      guidance: 'Review the source file and try again.',
    }
  );
}
