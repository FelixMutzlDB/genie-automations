import { describe, expect, it, vi } from 'vitest';
import {
  abortableDelay,
  claimConfirmation,
  closeIngestSession,
  humanizeIngestReject,
  isCurrentIngest,
  reduceIngest,
  type IngestUiState,
} from './ingestState';

describe('ingest preview state machine', () => {
  it('moves from upload through async parsing to preview', () => {
    let state: IngestUiState = { phase: 'idle' };
    state = reduceIngest(state, { type: 'START' });
    state = reduceIngest(state, { type: 'ACCEPTED', parseId: 'p1', runId: 42 });
    state = reduceIngest(state, { type: 'POLL', status: 'running' });
    state = reduceIngest(state, { type: 'PREVIEW_READY' });
    expect(state).toEqual({ phase: 'preview', parseId: 'p1', runId: 42 });
  });

  it('turns terminal parser failures into friendly error state', () => {
    const state = reduceIngest({ phase: 'parsing', parseId: 'p1' }, { type: 'POLL', status: 'failed' });
    expect(state.phase).toBe('error');
    expect(state.message).not.toContain('{');
  });

  it('rejects stale, aborted, and mismatched parse operations', () => {
    const controller = new AbortController();
    const active = { controller, taskId: 'task-a', parseId: 'parse-a' };
    expect(isCurrentIngest(active, controller, 'task-a', 'parse-a')).toBe(true);
    expect(isCurrentIngest(active, controller, 'task-b', 'parse-a')).toBe(false);
    expect(isCurrentIngest(active, controller, 'task-a', 'parse-b')).toBe(false);
    controller.abort();
    expect(isCurrentIngest(active, controller, 'task-a', 'parse-a')).toBe(false);
  });

  it('cancels the poll delay immediately when its operation is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableDelay(10_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['Close button', 'backdrop or Escape', 'programmatic task close'])(
    'aborts polling and clears state through the shared close session for %s',
    () => {
      const controller = new AbortController();
      const closeDialog = vi.fn();
      const resetState = vi.fn();
      const clearPreview = vi.fn();
      const current = closeIngestSession(
        { controller, taskId: 'task-a', parseId: 'parse-a' },
        { closeDialog, resetState, clearPreview }
      );
      expect(controller.signal.aborted).toBe(true);
      expect(current).toBeNull();
      expect(closeDialog).toHaveBeenCalledOnce();
      expect(resetState).toHaveBeenCalledOnce();
      expect(clearPreview).toHaveBeenCalledOnce();
    }
  );

  it('humanizes known and unknown parser codes without exposing the code', () => {
    const known = humanizeIngestReject('IG016');
    const unknown = humanizeIngestReject('IG999');
    expect(`${known.title} ${known.guidance}`).not.toContain('IG016');
    expect(`${unknown.title} ${unknown.guidance}`).not.toContain('IG999');
  });

  it('allows only one client request when confirm is double-submitted synchronously', () => {
    const lock = { current: false };
    const request = vi.fn();
    if (claimConfirmation(lock)) request();
    if (claimConfirmation(lock)) request();
    expect(request).toHaveBeenCalledOnce();
  });
});
