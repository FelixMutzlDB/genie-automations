export interface JoinableTask {
  task_id: string;
  role: string | null;
}

interface JoinResponse {
  ok?: boolean;
  role?: string;
  error?: string;
}

export interface JoinResult<T extends JoinableTask> {
  joined: boolean;
  role?: string;
  tasks: T[];
}

async function responseBody(response: Response): Promise<JoinResponse | null> {
  try {
    return (await response.json()) as JoinResponse;
  } catch {
    return null;
  }
}

export async function joinAndReloadTasks<T extends JoinableTask>(
  taskId: string,
  fetcher: typeof fetch = fetch
): Promise<JoinResult<T>> {
  let joinAccepted = false;
  let joinedRole: string | undefined;
  try {
    const response = await fetcher(`/api/tasks/${encodeURIComponent(taskId)}/join`, { method: 'POST' });
    const body = await responseBody(response);
    joinAccepted = response.ok;
    joinedRole = typeof body?.role === 'string' ? body.role : undefined;
  } catch {
    // A transport failure can happen after the server committed the membership.
  }

  const tasksResponse = await fetcher('/api/tasks');
  if (!tasksResponse.ok) throw new Error('tasks');
  const tasks = (await tasksResponse.json()) as T[];
  const membership = tasks.find((task) => task.task_id === taskId && task.role !== null);
  return { joined: joinAccepted || Boolean(membership), role: joinedRole ?? membership?.role ?? undefined, tasks };
}
