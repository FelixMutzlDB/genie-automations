-- Chase Part B: scheduled evaluation and pending outbox only. No transport sends.
-- Run with: psql -v admin_role=<role> -v scheduler_role=<dedicated-job-role>

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS genie_spike.chase_batch (
  batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
  evaluated_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending')),
  transport_adapter TEXT NOT NULL DEFAULT 'noop' CHECK (transport_adapter = 'noop'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS genie_spike.chase_delivery (
  delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES genie_spike.chase_batch(batch_id),
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
  item_reference TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  offset_kind TEXT NOT NULL CHECK (offset_kind IN ('approach','post_due')),
  offset_days INTEGER NOT NULL CHECK (offset_days > 0),
  checkpoint_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending')),
  transport_adapter TEXT NOT NULL DEFAULT 'noop' CHECK (transport_adapter = 'noop'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id,item_reference,due_at,offset_kind,offset_days)
);

CREATE INDEX IF NOT EXISTS chase_delivery_pending_idx
  ON genie_spike.chase_delivery(status,created_at);

CREATE OR REPLACE FUNCTION genie_spike.get_chase_scheduler_tasks()
RETURNS SETOF genie_spike.task_schedule_config
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,genie_spike AS $$
  SELECT config.* FROM genie_spike.task_schedule_config config
  JOIN genie_spike.task task USING(task_id)
  WHERE config.enabled AND task.status='active'
$$;

CREATE OR REPLACE FUNCTION genie_spike.get_chase_scheduler_items(p_task_id TEXT)
RETURNS TABLE(item_reference TEXT,accounting_period TEXT,outstanding_amount NUMERIC)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,genie_spike AS $$
  SELECT r.remittance_id,r.period,r.total_amount-COALESCE(SUM(a.amount),0)
  FROM genie_spike.remittance r LEFT JOIN genie_spike.allocation a USING(remittance_id)
  WHERE r.task_id=p_task_id
    AND EXISTS(SELECT 1 FROM genie_spike.task_schedule_config c WHERE c.task_id=p_task_id AND c.enabled)
  GROUP BY r.remittance_id,r.period,r.total_amount
  HAVING r.total_amount-COALESCE(SUM(a.amount),0)>0
  ORDER BY r.remittance_id
$$;

CREATE OR REPLACE FUNCTION genie_spike.apply_chase_scheduler_result(
  p_task_id TEXT,p_items JSONB,p_active_references TEXT[],p_evaluated_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
DECLARE batch UUID;
DECLARE inserted_count INTEGER;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM genie_spike.task_schedule_config WHERE task_id=p_task_id AND enabled) THEN
    RAISE EXCEPTION 'chase schedule is not enabled' USING ERRCODE='42501';
  END IF;
  INSERT INTO genie_spike.chase_batch(task_id,evaluated_at) VALUES(p_task_id,p_evaluated_at) RETURNING batch_id INTO batch;

  INSERT INTO genie_spike.chase_item_status(task_id,item_reference,due_at,state,next_check_at,outstanding_amount,updated_at)
  SELECT p_task_id,item->>'item_reference',(item->>'due_at')::timestamptz,item->>'state',
    (item->>'next_check_at')::timestamptz,(item->>'outstanding_amount')::numeric,p_evaluated_at
  FROM jsonb_array_elements(p_items) item
  ON CONFLICT(task_id,item_reference) DO UPDATE SET due_at=EXCLUDED.due_at,state=EXCLUDED.state,
    next_check_at=EXCLUDED.next_check_at,outstanding_amount=EXCLUDED.outstanding_amount,updated_at=p_evaluated_at;

  UPDATE genie_spike.chase_item_status SET state='resolved',outstanding_amount=0,next_check_at=NULL,updated_at=p_evaluated_at
  WHERE task_id=p_task_id AND state<>'resolved' AND NOT(item_reference=ANY(p_active_references));

  WITH inserted AS (
    INSERT INTO genie_spike.chase_delivery(
      batch_id,task_id,item_reference,due_at,offset_kind,offset_days,checkpoint_at)
    SELECT batch,p_task_id,item->>'item_reference',(item->>'due_at')::timestamptz,
      reminder->>'offset_kind',(reminder->>'offset_days')::integer,(reminder->>'checkpoint_at')::timestamptz
    FROM jsonb_array_elements(p_items) item
    CROSS JOIN LATERAL jsonb_array_elements(item->'reminders') reminder
    ON CONFLICT(task_id,item_reference,due_at,offset_kind,offset_days) DO NOTHING
    RETURNING item_reference
  ), notified AS (
    UPDATE genie_spike.chase_item_status status SET last_notified_at=p_evaluated_at
    WHERE status.task_id=p_task_id AND EXISTS(SELECT 1 FROM inserted WHERE inserted.item_reference=status.item_reference)
  ) SELECT count(*) INTO inserted_count FROM inserted;

  INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
  VALUES(p_task_id,session_user,'chase_scheduled_evaluation','success',
    jsonb_build_object('item_count',jsonb_array_length(p_items),'pending_delivery_count',inserted_count,'transport','noop'));
  RETURN inserted_count;
END;
$$;

CREATE OR REPLACE FUNCTION genie_spike.mark_chase_noop(p_task_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
BEGIN
  INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
  VALUES(p_task_id,session_user,'chase_transport_noop','success',jsonb_build_object('external_calls',0,'delivery_status','pending'));
END;
$$;

CREATE OR REPLACE FUNCTION genie_spike.log_chase_scheduler_failure(p_task_id TEXT,p_error_class TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
BEGIN
  INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
  VALUES(p_task_id,session_user,'chase_scheduled_evaluation','failure',jsonb_build_object('error_class',left(p_error_class,100)));
END;
$$;

REVOKE ALL ON genie_spike.chase_batch,genie_spike.chase_delivery FROM PUBLIC;
REVOKE ALL ON genie_spike.chase_batch,genie_spike.chase_delivery FROM :"scheduler_role";
GRANT SELECT,INSERT,UPDATE,DELETE ON genie_spike.chase_batch,genie_spike.chase_delivery TO :"admin_role";
REVOKE ALL ON FUNCTION genie_spike.get_chase_scheduler_tasks(),
  genie_spike.get_chase_scheduler_items(TEXT),
  genie_spike.apply_chase_scheduler_result(TEXT,JSONB,TEXT[],TIMESTAMPTZ),
  genie_spike.mark_chase_noop(TEXT),genie_spike.log_chase_scheduler_failure(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION genie_spike.get_chase_scheduler_tasks(),
  genie_spike.get_chase_scheduler_items(TEXT),
  genie_spike.apply_chase_scheduler_result(TEXT,JSONB,TEXT[],TIMESTAMPTZ),
  genie_spike.mark_chase_noop(TEXT),genie_spike.log_chase_scheduler_failure(TEXT,TEXT) TO :"scheduler_role";
