export interface ToolEvent {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface Proposal {
  proposal_id: string;
  task_id: string;
  change_type: string;
  state: string;
  proposer_id: string | null;
  approver_id: string | null;
  diff: Record<string, unknown>;
}

export interface Task {
  task_id: string;
  name: string;
  task_type: string;
  ingest_enabled: boolean;
  target_catalog: string | null;
  target_schema: string | null;
  target_table: string | null;
  org_id: string;
  role: 'owner' | 'member' | null;
  member_count: number;
  governance_status: 'unbound' | 'awaiting_approval' | 'active' | 'retired';
}

export interface Whoami {
  identity: string | null;
  isAdmin: boolean;
}

export interface OwnerSettings {
  ingest_enabled: boolean;
  validation_thresholds: {
    over_allocation_ceiling: number;
    structural_confidence_floor: number;
  };
  header_aliases: Record<string, string[]>;
}

export interface TaskConfig {
  version_hash: string | null;
  active_version_hash: string | null;
  settings: OwnerSettings | null;
  active_settings: OwnerSettings | null;
  status: 'draft' | 'published' | 'retired' | null;
  dest_catalog: string | null;
  dest_schema: string | null;
  dest_table: string | null;
  binding_status: 'pending' | 'active' | 'retired' | null;
  active: boolean | null;
}

export interface ConfigRequest {
  task_id: string;
  name: string;
  task_type: string;
  binding_id: string | null;
  binding_status: 'pending' | 'active' | null;
  version_hash: string | null;
  config_status: 'draft' | 'published' | null;
  created_by: string | null;
}

export interface ReminderConfig {
  task_id?: string;
  enabled: boolean;
  cadence: 'daily' | 'weekly';
  due_offset_days: number;
  default_due_at: string | null;
  approach_offsets: number[];
  post_due_offsets: number[];
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
  updated_by?: string;
  updated_at?: string;
}

export interface ReminderPreviewItem {
  item_reference: string;
  due_at: string;
  state: 'approaching_due' | 'overdue';
  outstanding_amount: string | number;
  next_check_at: string | null;
  timezone: string;
}

export interface ReminderPreview {
  counts: { total: number; approaching: number; overdue: number };
  summary: string;
  items: ReminderPreviewItem[];
}

export interface ParsePreview {
  parse_id: string;
  sha256: string;
  status: 'ready' | 'rejected';
  extraction_kind?: 'deterministic' | 'probabilistic_image';
  modality?: 'image';
  requires_human_confirmation?: boolean;
  artifact_hash?: string;
  rows: Array<{
    values: Record<string, string | null>;
    source_row: number;
    review?: Record<string, 'human_review_required' | 'invalid'>;
    evidence_refs?: Record<string, string>;
  }>;
  rejected_rows: Array<{ code: string; guidance: string; source_row: number | null }>;
  warnings: string[];
}

export interface Activity {
  user_id: string;
  action: string;
  status: 'success' | 'failure';
  detail: unknown;
  proposal_id: string | null;
  occurred_at: string;
}

export interface ChatResponse {
  reply?: string;
  tool_events?: ToolEvent[];
  proposals?: Proposal[];
  error?: string;
  sqlstate?: string;
}

export interface ActionResponse {
  ok: boolean;
  result?: unknown;
  audit?: Record<string, unknown> | null;
  sqlstate?: string;
  error?: string;
}

export type Msg = { role: 'you' | 'co-worker'; text: string; events?: ToolEvent[] };
export type Outcome = { kind: 'success' | 'error'; message: string; technical?: unknown };
