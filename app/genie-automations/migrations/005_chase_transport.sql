-- Chase transport: human approval and Databricks SQL digest handoff.
-- Run with: psql -v admin_role=<role> -v obo_role=<request-user-role>
--                 -v scheduler_role=<dedicated-job-role> -v publisher_role=<projection-job-role>

ALTER TABLE genie_spike.chase_batch
  DROP CONSTRAINT IF EXISTS chase_batch_status_check;
ALTER TABLE genie_spike.chase_batch
  ADD CONSTRAINT chase_batch_status_check CHECK (status IN ('pending','approved','archived'));
ALTER TABLE genie_spike.chase_batch
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_note TEXT;

ALTER TABLE genie_spike.chase_delivery
  DROP CONSTRAINT IF EXISTS chase_delivery_status_check;
ALTER TABLE genie_spike.chase_delivery
  ADD CONSTRAINT chase_delivery_status_check CHECK (status IN ('pending','eligible','announced'));
ALTER TABLE genie_spike.chase_delivery
  ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS announced_window_id TEXT;

-- Upgrade existing no-op rows before restricting all new and existing rows to the native digest adapter.
ALTER TABLE genie_spike.chase_batch
  DROP CONSTRAINT IF EXISTS chase_batch_transport_adapter_check;
ALTER TABLE genie_spike.chase_batch ALTER COLUMN transport_adapter SET DEFAULT 'dbsql_digest';
UPDATE genie_spike.chase_batch SET transport_adapter='dbsql_digest' WHERE transport_adapter='noop';
ALTER TABLE genie_spike.chase_batch
  ADD CONSTRAINT chase_batch_transport_adapter_check CHECK (transport_adapter = 'dbsql_digest');
ALTER TABLE genie_spike.chase_delivery
  DROP CONSTRAINT IF EXISTS chase_delivery_transport_adapter_check;
ALTER TABLE genie_spike.chase_delivery ALTER COLUMN transport_adapter SET DEFAULT 'dbsql_digest';
UPDATE genie_spike.chase_delivery SET transport_adapter='dbsql_digest' WHERE transport_adapter='noop';
ALTER TABLE genie_spike.chase_delivery
  ADD CONSTRAINT chase_delivery_transport_adapter_check CHECK (transport_adapter = 'dbsql_digest');

CREATE INDEX IF NOT EXISTS chase_delivery_eligible_idx
  ON genie_spike.chase_delivery(status,batch_id,due_at);

CREATE OR REPLACE FUNCTION genie_spike.get_pending_chase_batches()
RETURNS TABLE(
  batch_id UUID,task_id TEXT,task_name TEXT,owner_email TEXT,evaluated_at TIMESTAMPTZ,
  item_count BIGINT,offset_kinds TEXT[],due_dates TIMESTAMPTZ[],item_preview TEXT[],reviewer_role TEXT
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,genie_spike AS $$
  SELECT b.batch_id,b.task_id,t.name,t.owner_id,b.evaluated_at,count(DISTINCT d.item_reference),
    array_agg(DISTINCT d.offset_kind ORDER BY d.offset_kind),
    array_agg(DISTINCT d.due_at ORDER BY d.due_at),
    (array_agg(DISTINCT d.item_reference ORDER BY d.item_reference))[1:5],
    CASE WHEN has_table_privilege(session_user,'genie_spike.destination_allowlist','DELETE')
      THEN 'collections_approver'::TEXT ELSE 'owner'::TEXT END
  FROM genie_spike.chase_batch b
  JOIN genie_spike.task t ON t.task_id=b.task_id
  JOIN genie_spike.task_member owner_member ON owner_member.task_id=t.task_id
    AND lower(owner_member.user_id)=lower(t.owner_id) AND owner_member.role='owner'
  JOIN genie_spike.chase_delivery d ON d.batch_id=b.batch_id AND d.status='pending'
  WHERE b.status='pending' AND (
    EXISTS(SELECT 1 FROM genie_spike.task_member caller WHERE caller.task_id=b.task_id
      AND lower(caller.user_id)=lower(session_user) AND caller.role='owner')
    OR has_table_privilege(session_user,'genie_spike.destination_allowlist','DELETE'))
  GROUP BY b.batch_id,b.task_id,t.name,t.owner_id,b.evaluated_at
  ORDER BY b.evaluated_at DESC
$$;

CREATE OR REPLACE FUNCTION genie_spike.approve_chase_batch(p_batch_id UUID,p_note TEXT)
RETURNS TABLE(batch_id UUID,task_id TEXT,old_status TEXT,new_status TEXT,item_count BIGINT,actor TEXT,changed_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
DECLARE selected genie_spike.chase_batch%ROWTYPE;
DECLARE affected BIGINT;
DECLARE changed TIMESTAMPTZ:=now();
BEGIN
  SELECT * INTO selected FROM genie_spike.chase_batch b WHERE b.batch_id=p_batch_id FOR UPDATE;
  IF selected.batch_id IS NULL THEN RETURN; END IF;
  IF NOT (
    EXISTS(SELECT 1 FROM genie_spike.task_member tm WHERE tm.task_id=selected.task_id
      AND lower(tm.user_id)=lower(session_user) AND tm.role='owner')
    OR has_table_privilege(session_user,'genie_spike.destination_allowlist','DELETE')) THEN
    RAISE EXCEPTION 'chase batch approval requires an owner or collections approver' USING ERRCODE='42501';
  END IF;
  IF selected.status<>'pending' THEN RETURN; END IF;

  SELECT count(DISTINCT d.item_reference) INTO affected
    FROM genie_spike.chase_delivery d WHERE d.batch_id=p_batch_id AND d.status='pending';
  UPDATE genie_spike.chase_batch SET status='approved',approved_by=session_user,
    approved_at=changed,approval_note=nullif(left(trim(p_note),1000),'') WHERE chase_batch.batch_id=p_batch_id;
  UPDATE genie_spike.chase_delivery SET status='eligible'
    WHERE chase_delivery.batch_id=p_batch_id AND status='pending';
  INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
  VALUES(selected.task_id,session_user,'chase_batch_approved','success',
    jsonb_build_object('batch_id',p_batch_id,'old_status','pending','new_status','approved','item_count',affected));
  RETURN QUERY SELECT p_batch_id,selected.task_id,'pending'::TEXT,'approved'::TEXT,affected,session_user::TEXT,changed;
END;
$$;

CREATE OR REPLACE FUNCTION genie_spike.archive_chase_batch(p_batch_id UUID,p_note TEXT)
RETURNS TABLE(batch_id UUID,task_id TEXT,old_status TEXT,new_status TEXT,item_count BIGINT,actor TEXT,changed_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
DECLARE selected genie_spike.chase_batch%ROWTYPE;
DECLARE affected BIGINT;
DECLARE changed TIMESTAMPTZ:=now();
BEGIN
  SELECT * INTO selected FROM genie_spike.chase_batch b WHERE b.batch_id=p_batch_id FOR UPDATE;
  IF selected.batch_id IS NULL THEN RETURN; END IF;
  IF NOT (
    EXISTS(SELECT 1 FROM genie_spike.task_member tm WHERE tm.task_id=selected.task_id
      AND lower(tm.user_id)=lower(session_user) AND tm.role='owner')
    OR has_table_privilege(session_user,'genie_spike.destination_allowlist','DELETE')) THEN
    RAISE EXCEPTION 'chase batch archive requires an owner or collections approver' USING ERRCODE='42501';
  END IF;
  IF selected.status<>'pending' THEN RETURN; END IF;
  SELECT count(DISTINCT d.item_reference) INTO affected
    FROM genie_spike.chase_delivery d WHERE d.batch_id=p_batch_id AND d.status='pending';
  UPDATE genie_spike.chase_batch SET status='archived',approval_note=nullif(left(trim(p_note),1000),'')
    WHERE chase_batch.batch_id=p_batch_id;
  INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
  VALUES(selected.task_id,session_user,'chase_batch_archived','success',
    jsonb_build_object('batch_id',p_batch_id,'old_status','pending','new_status','archived','item_count',affected));
  RETURN QUERY SELECT p_batch_id,selected.task_id,'pending'::TEXT,'archived'::TEXT,affected,session_user::TEXT,changed;
END;
$$;

CREATE OR REPLACE VIEW genie_spike.approved_chase_reminder_projection AS
SELECT t.task_id,t.name AS task_name,t.owner_id AS owner_email,d.item_reference,d.due_at,
  d.offset_kind,d.offset_days,b.approved_at
FROM genie_spike.chase_delivery d
JOIN genie_spike.chase_batch b ON b.batch_id=d.batch_id
JOIN genie_spike.task t ON t.task_id=b.task_id
JOIN genie_spike.task_member owner_member ON owner_member.task_id=t.task_id
  AND lower(owner_member.user_id)=lower(t.owner_id) AND owner_member.role='owner'
WHERE b.status='approved' AND d.status='eligible';

REVOKE ALL ON genie_spike.approved_chase_reminder_projection FROM PUBLIC;

CREATE OR REPLACE FUNCTION genie_spike.get_approved_chase_reminders(p_window_id TEXT)
RETURNS TABLE(
  task_id TEXT,task_name TEXT,owner_email TEXT,item_reference TEXT,due_at TIMESTAMPTZ,
  offset_kind TEXT,offset_days INTEGER,approved_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
BEGIN
  IF p_window_id IS NULL OR length(trim(p_window_id))=0 THEN
    RAISE EXCEPTION 'announcement window is required' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH announced AS (
    UPDATE genie_spike.chase_delivery d
       SET status='announced',announced_at=now(),announced_window_id=left(p_window_id,100)
      FROM genie_spike.chase_batch b,genie_spike.task t,genie_spike.task_member owner_member
     WHERE b.batch_id=d.batch_id AND b.status='approved' AND d.status='eligible'
       AND t.task_id=b.task_id AND owner_member.task_id=t.task_id
       AND lower(owner_member.user_id)=lower(t.owner_id) AND owner_member.role='owner'
     RETURNING d.task_id,t.name,t.owner_id,d.item_reference,d.due_at,d.offset_kind,d.offset_days,b.approved_at)
  SELECT a.* FROM announced a
   ORDER BY a.due_at,a.item_reference;
END;
$$;

COMMENT ON COLUMN genie_spike.chase_delivery.announced_at IS
  'Announcement means included in a SQL Alert projection, not confirmed email delivery. Retain announced batches for 90 days by default.';

REVOKE ALL ON genie_spike.chase_batch,genie_spike.chase_delivery FROM PUBLIC, :"obo_role", :"scheduler_role", :"publisher_role";
GRANT SELECT,INSERT,UPDATE,DELETE ON genie_spike.chase_batch,genie_spike.chase_delivery TO :"admin_role";
REVOKE ALL ON FUNCTION genie_spike.get_pending_chase_batches(),
  genie_spike.approve_chase_batch(UUID,TEXT),genie_spike.archive_chase_batch(UUID,TEXT),
  genie_spike.get_approved_chase_reminders(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION genie_spike.get_pending_chase_batches(),
  genie_spike.approve_chase_batch(UUID,TEXT),genie_spike.archive_chase_batch(UUID,TEXT) TO :"obo_role";
GRANT EXECUTE ON FUNCTION genie_spike.get_approved_chase_reminders(TEXT) TO :"publisher_role";
