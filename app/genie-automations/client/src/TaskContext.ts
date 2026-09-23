import { createContext, useContext } from 'react';

export interface TaskContextValue {
  selectedTaskId: string | null;
}

export const TaskContext = createContext<TaskContextValue>({ selectedTaskId: null });

export function useTask(): TaskContextValue {
  return useContext(TaskContext);
}
