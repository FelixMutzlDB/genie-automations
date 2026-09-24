import {
  Badge,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@databricks/appkit-ui/react';
import { Plus, ShieldCheck, User } from 'lucide-react';
import { humanizeActor } from '../lib/humanize';
import type { Task } from '../types';

function taskTypeLabel(type: string): string {
  if (type.includes('allocation') || type === 'receivables') return 'Receivables';
  if (type.includes('vendor_bank')) return 'Vendor bank';
  return 'Custom';
}

interface AppHeaderProps {
  identity: string | null;
  identityResolved: boolean;
  tasksLoading: boolean;
  selectedTaskId: string | null;
  selectedTask: Task | null;
  ownTasks: Task[];
  availableTasks: Task[];
  onTaskChoice: (value: string) => void;
}

export function AppHeader({
  identity,
  identityResolved,
  tasksLoading,
  selectedTaskId,
  selectedTask,
  ownTasks,
  availableTasks,
  onTaskChoice,
}: AppHeaderProps) {
  return (
    <header className="border-b px-5 py-3 flex flex-wrap items-center gap-3">
      <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
      <h1 className="text-base font-semibold">Genie automations</h1>
      <Select value={selectedTaskId ?? undefined} onValueChange={onTaskChoice}>
        <SelectTrigger className="w-[280px]" aria-label="Select automation">
          <SelectValue placeholder={tasksLoading ? 'Loading automations…' : 'Choose an automation'} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Your automations</SelectLabel>
            {ownTasks.map((task) => (
              <SelectItem key={task.task_id} value={task.task_id}>
                {task.name} · {taskTypeLabel(task.task_type)}
                {task.role === 'owner' ? ' · Owner' : ''}
              </SelectItem>
            ))}
          </SelectGroup>
          {availableTasks.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Available to join</SelectLabel>
                {availableTasks.map((task) => (
                  <SelectItem key={task.task_id} value={`__join__:${task.task_id}`}>
                    Join · {task.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
          <SelectSeparator />
          <SelectItem value="__new__">
            <Plus className="h-4 w-4" /> New automation…
          </SelectItem>
        </SelectContent>
      </Select>
      {selectedTask && <span className="text-xs text-muted-foreground">{taskTypeLabel(selectedTask.task_type)}</span>}
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className="ml-auto gap-1.5">
            <User className="h-3.5 w-3.5" />
            {!identityResolved ? 'Loading…' : identity ? humanizeActor(identity) : 'Unknown user'}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Actions you take are recorded under your own name.</TooltipContent>
      </Tooltip>
    </header>
  );
}
