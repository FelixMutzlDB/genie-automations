import { describe, expect, it } from 'vitest';
import { reduceIngest, type IngestUiState } from './ingestState';

describe('ingest preview state machine', () => {
  it('moves from upload through async parsing to preview', () => {
    let state: IngestUiState = { phase: 'idle' };
    state = reduceIngest(state, { type: 'START' });
    state = reduceIngest(state, { type: 'ACCEPTED', parseId: 'p1', runId: 42 });
    state = reduceIngest(state, { type: 'POLL', status: 'RUNNING' });
    state = reduceIngest(state, { type: 'PREVIEW_READY' });
    expect(state).toEqual({ phase: 'preview', parseId: 'p1', runId: 42 });
  });

  it('turns terminal parser failures into friendly error state', () => {
    const state = reduceIngest({ phase: 'parsing', parseId: 'p1' }, { type: 'POLL', status: 'INTERNAL_ERROR' });
    expect(state.phase).toBe('error');
    expect(state.message).not.toContain('{');
  });
});
