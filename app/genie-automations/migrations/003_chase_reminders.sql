-- Additive Chase Part A state. No notification transport or money mutation is included.
-- Run with: psql -v admin_role=<role> -v obo_role=<request-user-role>

CREATE TABLE IF NOT EXISTS genie_spike.task_schedule_config (
  task_id TEXT PRIMARY KEY REFERENCES genie_spike.task(task_id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly')),
  due_base TEXT NOT NULL DEFAULT 'accounting_period' CHECK (due_base = 'accounting_period'),
  due_offset_days INTEGER NOT NULL DEFAULT 2 CHECK (due_offset_days BETWEEN -31 AND 366),
  default_due_at TIMESTAMPTZ,
  approach_offsets INTEGER[] NOT NULL DEFAULT ARRAY[7,2] CHECK (
    cardinality(approach_offsets) BETWEEN 1 AND 10 AND 0 < ALL(approach_offsets)
  ),
  post_due_offsets INTEGER[] NOT NULL DEFAULT ARRAY[1,7,14] CHECK (
    cardinality(post_due_offsets) BETWEEN 1 AND 10 AND 0 < ALL(post_due_offsets)
  ),
  quiet_hours_start TIME NOT NULL DEFAULT TIME '18:00',
  quiet_hours_end TIME NOT NULL DEFAULT TIME '08:00',
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 100),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS genie_spike.chase_item_status (
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
  item_reference TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'approaching_due', 'overdue', 'resolved')),
  last_notified_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  outstanding_amount NUMERIC(18,2) NOT NULL CHECK (outstanding_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, item_reference)
);

CREATE INDEX IF NOT EXISTS chase_item_status_due_idx
  ON genie_spike.chase_item_status(task_id, state, next_check_at);

REVOKE ALL ON genie_spike.task_schedule_config, genie_spike.chase_item_status FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON genie_spike.task_schedule_config, genie_spike.chase_item_status TO :"obo_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON genie_spike.task_schedule_config, genie_spike.chase_item_status TO :"admin_role";

ALTER TABLE genie_spike.task_schedule_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_spike.chase_item_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_schedule_config_member_read ON genie_spike.task_schedule_config;
DROP POLICY IF EXISTS task_schedule_config_owner_write ON genie_spike.task_schedule_config;
DROP POLICY IF EXISTS task_schedule_config_admin_all ON genie_spike.task_schedule_config;
DROP POLICY IF EXISTS chase_item_status_member_read ON genie_spike.chase_item_status;
DROP POLICY IF EXISTS chase_item_status_owner_write ON genie_spike.chase_item_status;
DROP POLICY IF EXISTS chase_item_status_admin_all ON genie_spike.chase_item_status;

CREATE POLICY task_schedule_config_member_read ON genie_spike.task_schedule_config FOR SELECT TO PUBLIC
  USING (EXISTS (
    SELECT 1 FROM genie_spike.task_member tm
    WHERE tm.task_id=task_schedule_config.task_id AND lower(tm.user_id)=lower(session_user)
  ));
CREATE POLICY task_schedule_config_owner_write ON genie_spike.task_schedule_config FOR ALL TO PUBLIC
  USING (EXISTS (
    SELECT 1 FROM genie_spike.task_member tm
    WHERE tm.task_id=task_schedule_config.task_id AND lower(tm.user_id)=lower(session_user) AND tm.role='owner'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM genie_spike.task_member tm
    WHERE tm.task_id=task_schedule_config.task_id AND lower(tm.user_id)=lower(session_user) AND tm.role='owner'
  ));
CREATE POLICY task_schedule_config_admin_all ON genie_spike.task_schedule_config TO :"admin_role"
  USING (true) WITH CHECK (true);

CREATE POLICY chase_item_status_member_read ON genie_spike.chase_item_status FOR SELECT TO PUBLIC
  USING (EXISTS (
    SELECT 1 FROM genie_spike.task_member tm
    WHERE tm.task_id=chase_item_status.task_id AND lower(tm.user_id)=lower(session_user)
  ));
CREATE POLICY chase_item_status_owner_write ON genie_spike.chase_item_status FOR ALL TO PUBLIC
  USING (EXISTS (
    SELECT 1 FROM genie_spike.task_member tm
    WHERE tm.task_id=chase_item_status.task_id AND lower(tm.user_id)=lower(session_user) AND tm.role='owner'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM genie_spike.task_member tm
    WHERE tm.task_id=chase_item_status.task_id AND lower(tm.user_id)=lower(session_user) AND tm.role='owner'
  ));
CREATE POLICY chase_item_status_admin_all ON genie_spike.chase_item_status TO :"admin_role"
  USING (true) WITH CHECK (true);
