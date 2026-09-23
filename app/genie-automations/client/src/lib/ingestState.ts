export type IngestPhase = 'idle' | 'uploading' | 'parsing' | 'preview' | 'error';

export interface IngestUiState {
  phase: IngestPhase;
  parseId?: string;
  runId?: number;
  message?: string;
}

export type IngestEvent =
  | { type: 'START' }
  | { type: 'ACCEPTED'; parseId: string; runId: number }
  | { type: 'POLL'; status: string }
  | { type: 'PREVIEW_READY' }
  | { type: 'FAIL'; message: string }
  | { type: 'RESET' };

export function reduceIngest(state: IngestUiState, event: IngestEvent): IngestUiState {
  switch (event.type) {
    case 'START': return { phase: 'uploading' };
    case 'ACCEPTED': return { phase: 'parsing', parseId: event.parseId, runId: event.runId };
    case 'POLL':
      if (['INTERNAL_ERROR', 'SKIPPED', 'TERMINATING'].includes(event.status)) {
        return { ...state, phase: 'error', message: 'The parser could not finish safely.' };
      }
      return state;
    case 'PREVIEW_READY': return { ...state, phase: 'preview' };
    case 'FAIL': return { ...state, phase: 'error', message: event.message };
    case 'RESET': return { phase: 'idle' };
  }
}
