import { describe, expect, it } from 'vitest';
import { INITIAL_TAB_ERROR_STATE, tabErrorReducer, visibleCoWorkerError } from './tabErrorState';

describe('workspace tab error state', () => {
  it('keeps a Co-worker error out of Ask data and clears it on a tab switch', () => {
    const failed = tabErrorReducer(INITIAL_TAB_ERROR_STATE, {
      type: 'co-worker-error',
      message: "I couldn't complete that — could you rephrase?",
    });
    expect(visibleCoWorkerError(failed)).toContain("couldn't complete");

    const askData = tabErrorReducer(failed, { type: 'switch-tab', tab: 'ask-data' });
    expect(askData).toEqual({ activeTab: 'ask-data', coWorkerError: null });
    expect(visibleCoWorkerError(askData)).toBeNull();
  });

  it('clears a stale Co-worker error when a new Co-worker question is submitted', () => {
    const failed = tabErrorReducer(INITIAL_TAB_ERROR_STATE, {
      type: 'co-worker-error',
      message: 'stale error',
    });

    expect(tabErrorReducer(failed, { type: 'submit-co-worker' }).coWorkerError).toBeNull();
  });
});
