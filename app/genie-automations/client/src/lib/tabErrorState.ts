export type WorkspaceTab = 'co-worker' | 'ask-data';

export interface TabErrorState {
  activeTab: WorkspaceTab;
  coWorkerError: string | null;
}

export type TabErrorAction =
  | { type: 'switch-tab'; tab: WorkspaceTab }
  | { type: 'submit-co-worker' }
  | { type: 'co-worker-error'; message: string };

export const INITIAL_TAB_ERROR_STATE: TabErrorState = {
  activeTab: 'co-worker',
  coWorkerError: null,
};

export function tabErrorReducer(state: TabErrorState, action: TabErrorAction): TabErrorState {
  switch (action.type) {
    case 'switch-tab':
      return { activeTab: action.tab, coWorkerError: null };
    case 'submit-co-worker':
      return { ...state, coWorkerError: null };
    case 'co-worker-error':
      return { ...state, coWorkerError: action.message };
  }
}

export function visibleCoWorkerError(state: TabErrorState): string | null {
  return state.activeTab === 'co-worker' ? state.coWorkerError : null;
}
