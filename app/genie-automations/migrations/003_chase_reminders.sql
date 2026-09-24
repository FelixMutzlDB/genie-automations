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

-- As in migration 002, the application performs the owner/config-admin check
-- before invoking these narrow SECURITY DEFINER write boundaries. session_user
-- remains the OBO human and is used for attribution; callers receive no generic
-- RLS bypass for either chase table.
CREATE OR REPLACE FUNCTION genie_spike.save_task_schedule_config(
  p_task_id TEXT,
  p_enabled BOOLEAN,
  p_cadence TEXT,
  p_due_offset_days INTEGER,
  p_default_due_at TIMESTAMPTZ,
  p_approach_offsets INTEGER[],
  p_post_due_offsets INTEGER[],
  p_quiet_hours_start TIME,
  p_quiet_hours_end TIME,
  p_timezone TEXT
) RETURNS SETOF genie_spike.task_schedule_config
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
  WITH saved AS (
    INSERT INTO genie_spike.task_schedule_config(
      task_id,enabled,cadence,due_offset_days,default_due_at,approach_offsets,post_due_offsets,
      quiet_hours_start,quiet_hours_end,timezone,updated_by,updated_at)
    VALUES(p_task_id,p_enabled,p_cadence,p_due_offset_days,p_default_due_at,p_approach_offsets,p_post_due_offsets,
      p_quiet_hours_start,p_quiet_hours_end,p_timezone,session_user,now())
    ON CONFLICT(task_id) DO UPDATE SET enabled=EXCLUDED.enabled,cadence=EXCLUDED.cadence,
      due_offset_days=EXCLUDED.due_offset_days,default_due_at=EXCLUDED.default_due_at,
      approach_offsets=EXCLUDED.approach_offsets,post_due_offsets=EXCLUDED.post_due_offsets,
      quiet_hours_start=EXCLUDED.quiet_hours_start,quiet_hours_end=EXCLUDED.quiet_hours_end,
      timezone=EXCLUDED.timezone,updated_by=session_user,updated_at=now()
    RETURNING *
  ), activity AS (
    -- Chase actions intentionally use the shared task_activity feed.
    INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
    SELECT task_id,session_user,'chase_schedule_saved','success',
      jsonb_build_object('enabled',enabled,'cadence',cadence) FROM saved
  )
  SELECT * FROM saved
$$;

CREATE OR REPLACE FUNCTION genie_spike.get_task_schedule_config(p_task_id TEXT)
RETURNS SETOF genie_spike.task_schedule_config
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,genie_spike AS $$
  SELECT * FROM genie_spike.task_schedule_config WHERE task_id=p_task_id
$$;

CREATE OR REPLACE FUNCTION genie_spike.save_chase_item_status(
  p_task_id TEXT,p_item_reference TEXT,p_due_at TIMESTAMPTZ,p_state TEXT,
  p_next_check_at TIMESTAMPTZ,p_outstanding_amount NUMERIC
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
  INSERT INTO genie_spike.chase_item_status(
    task_id,item_reference,due_at,state,next_check_at,outstanding_amount,updated_at)
  VALUES(p_task_id,p_item_reference,p_due_at,p_state,p_next_check_at,p_outstanding_amount,now())
  ON CONFLICT(task_id,item_reference) DO UPDATE SET
    due_at=EXCLUDED.due_at,state=EXCLUDED.state,next_check_at=EXCLUDED.next_check_at,
    outstanding_amount=EXCLUDED.outstanding_amount,updated_at=now()
$$;

CREATE OR REPLACE FUNCTION genie_spike.resolve_missing_chase_items(p_task_id TEXT,p_active_references TEXT[])
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
DECLARE resolved_count INTEGER;
BEGIN
  UPDATE genie_spike.chase_item_status
     SET state='resolved',outstanding_amount=0,next_check_at=NULL,updated_at=now()
   WHERE task_id=p_task_id AND state<>'resolved' AND NOT(item_reference=ANY(p_active_references));
  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  RETURN resolved_count;
END;
$$;

CREATE OR REPLACE FUNCTION genie_spike.get_chase_preview(p_task_id TEXT)
RETURNS TABLE(
  item_reference TEXT,due_at TIMESTAMPTZ,state TEXT,outstanding_amount NUMERIC,
  next_check_at TIMESTAMPTZ,enabled BOOLEAN,timezone TEXT
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,genie_spike AS $$
  SELECT cis.item_reference,cis.due_at,cis.state,cis.outstanding_amount,cis.next_check_at,
         tsc.enabled,tsc.timezone
    FROM genie_spike.chase_item_status cis
    JOIN genie_spike.task_schedule_config tsc ON tsc.task_id=cis.task_id
   WHERE cis.task_id=p_task_id AND tsc.enabled AND cis.state IN ('approaching_due','overdue')
   ORDER BY (cis.state='overdue') DESC,cis.due_at,cis.item_reference
$$;

REVOKE ALL ON genie_spike.task_schedule_config, genie_spike.chase_item_status FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON genie_spike.task_schedule_config, genie_spike.chase_item_status FROM :"obo_role";
GRANT SELECT ON genie_spike.task_schedule_config, genie_spike.chase_item_status TO :"obo_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON genie_spike.task_schedule_config, genie_spike.chase_item_status TO :"admin_role";
REVOKE ALL ON FUNCTION genie_spike.save_task_schedule_config(
  TEXT,BOOLEAN,TEXT,INTEGER,TIMESTAMPTZ,INTEGER[],INTEGER[],TIME,TIME,TEXT),
  genie_spike.get_task_schedule_config(TEXT),
  genie_spike.save_chase_item_status(TEXT,TEXT,TIMESTAMPTZ,TEXT,TIMESTAMPTZ,NUMERIC),
  genie_spike.resolve_missing_chase_items(TEXT,TEXT[]),genie_spike.get_chase_preview(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION genie_spike.save_task_schedule_config(
  TEXT,BOOLEAN,TEXT,INTEGER,TIMESTAMPTZ,INTEGER[],INTEGER[],TIME,TIME,TEXT),
  genie_spike.get_task_schedule_config(TEXT),
  genie_spike.save_chase_item_status(TEXT,TEXT,TIMESTAMPTZ,TEXT,TIMESTAMPTZ,NUMERIC),
  genie_spike.resolve_missing_chase_items(TEXT,TEXT[]),genie_spike.get_chase_preview(TEXT) TO :"obo_role";

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
