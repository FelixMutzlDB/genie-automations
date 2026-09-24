-- Additive config-governance registry. Legacy task target/config columns remain deprecated.
-- Run with: psql -v admin_role=<role> -v obo_role=<request-user-role>
--                 -v destination_catalog=<catalog> ...
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS genie_spike.destination_allowlist (
  dest_catalog TEXT NOT NULL, dest_schema TEXT NOT NULL, dest_table TEXT NOT NULL,
  PRIMARY KEY (dest_catalog, dest_schema, dest_table)
);
CREATE TABLE IF NOT EXISTS genie_spike.destination_binding (
  binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
  dest_catalog TEXT NOT NULL, dest_schema TEXT NOT NULL, dest_table TEXT NOT NULL,
  write_scope JSONB NOT NULL CHECK (jsonb_typeof(write_scope)='object' AND
    write_scope->'change_types' IN ('["allocation_upsert"]'::jsonb,'["vendor_bank_update"]'::jsonb)),
  identity_ref TEXT NOT NULL CHECK (identity_ref='obo_user'),
  status TEXT NOT NULL CHECK (status IN ('pending','active','retired')),
  proposed_by TEXT NOT NULL, approved_by TEXT,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(), approved_at TIMESTAMPTZ, retired_at TIMESTAMPTZ,
  CONSTRAINT destination_binding_allowlisted FOREIGN KEY (dest_catalog,dest_schema,dest_table)
    REFERENCES genie_spike.destination_allowlist(dest_catalog,dest_schema,dest_table),
  CONSTRAINT destination_binding_checker CHECK (approved_by IS DISTINCT FROM proposed_by),
  CONSTRAINT destination_binding_active_approved CHECK (status<>'active' OR approved_by IS NOT NULL),
  CONSTRAINT destination_binding_lifecycle CHECK (
    (status='pending' AND approved_at IS NULL AND retired_at IS NULL) OR
    (status='active' AND approved_at IS NOT NULL AND retired_at IS NULL) OR
    (status='retired' AND retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS destination_binding_one_active_per_task
  ON genie_spike.destination_binding(task_id) WHERE status='active';

CREATE OR REPLACE FUNCTION genie_spike.destination_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_change_type TEXT;
BEGIN
  SELECT CASE WHEN task_type IN ('receivables','allocation_upsert','reconciliation') THEN 'allocation_upsert'
              WHEN task_type IN ('vendor_bank','vendor_bank_update') THEN 'vendor_bank_update' END
    INTO expected_change_type FROM genie_spike.task WHERE task_id=NEW.task_id;
  IF expected_change_type IS NULL OR NEW.write_scope->'change_types'<>jsonb_build_array(expected_change_type) THEN
    RAISE EXCEPTION 'binding scope does not match task type' USING ERRCODE='GA022';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS destination_binding_guard_trigger ON genie_spike.destination_binding;
CREATE TRIGGER destination_binding_guard_trigger BEFORE INSERT OR UPDATE ON genie_spike.destination_binding
  FOR EACH ROW EXECUTE FUNCTION genie_spike.destination_binding_guard();

CREATE TABLE IF NOT EXISTS genie_spike.config_version (
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id), version_hash CHAR(64) NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')),
  created_by TEXT NOT NULL, approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ, retired_at TIMESTAMPTZ,
  PRIMARY KEY(task_id,version_hash),
  CONSTRAINT config_version_checker CHECK (approved_by IS DISTINCT FROM created_by),
  CONSTRAINT config_version_published_approved CHECK (status='draft' OR approved_by IS NOT NULL),
  CONSTRAINT config_version_lifecycle CHECK (
    (status='draft' AND published_at IS NULL AND retired_at IS NULL) OR
    (status='published' AND published_at IS NOT NULL AND retired_at IS NULL) OR
    (status='retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS genie_spike.task_config_state (
  task_id TEXT PRIMARY KEY REFERENCES genie_spike.task(task_id), active_version_hash CHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_config_state_version_fk FOREIGN KEY(task_id,active_version_hash)
    REFERENCES genie_spike.config_version(task_id,version_hash)
);

CREATE OR REPLACE FUNCTION genie_spike.binding_digest(
  p_task_id TEXT,p_dest_catalog TEXT,p_dest_schema TEXT,p_dest_table TEXT,p_write_scope JSONB,p_identity_ref TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(convert_to(jsonb_build_object('task_id',p_task_id,'dest_catalog',p_dest_catalog,
    'dest_schema',p_dest_schema,'dest_table',p_dest_table,'write_scope',p_write_scope,
    'identity_ref',p_identity_ref)::text,'UTF8'),'sha256'),'hex')
$$;

CREATE OR REPLACE FUNCTION genie_spike.config_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE computed_hash TEXT;
BEGIN
  computed_hash:=encode(digest(convert_to(NEW.payload::text,'UTF8'),'sha256'),'hex');
  IF TG_OP='INSERT' THEN NEW.version_hash:=computed_hash; RETURN NEW; END IF;
  IF OLD.status='retired' THEN
    RAISE EXCEPTION 'retired config is immutable' USING ERRCODE='GA020';
  END IF;
  IF OLD.status='published' THEN
    IF NEW.status<>'retired' OR NEW.retired_at IS NULL OR
       NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.version_hash IS DISTINCT FROM OLD.version_hash OR
       NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
       NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'published config is immutable except retirement' USING ERRCODE='GA020';
    END IF;
    RETURN NEW;
  END IF;
  NEW.version_hash:=computed_hash;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS config_version_guard_trigger ON genie_spike.config_version;
CREATE TRIGGER config_version_guard_trigger BEFORE INSERT OR UPDATE ON genie_spike.config_version
  FOR EACH ROW EXECUTE FUNCTION genie_spike.config_version_guard();

-- SECURITY DEFINER is the sole governance-write boundary. Actors come from session_user.
CREATE OR REPLACE FUNCTION genie_spike.propose_destination_binding(
  p_task_id TEXT,p_dest_catalog TEXT,p_dest_schema TEXT,p_dest_table TEXT
) RETURNS SETOF genie_spike.destination_binding
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
DECLARE scope JSONB;
BEGIN
  SELECT CASE WHEN task_type IN ('receivables','allocation_upsert','reconciliation') THEN '{"change_types":["allocation_upsert"]}'::jsonb
              WHEN task_type IN ('vendor_bank','vendor_bank_update') THEN '{"change_types":["vendor_bank_update"]}'::jsonb END
    INTO scope FROM genie_spike.task WHERE task_id=p_task_id AND status='active';
  IF scope IS NULL THEN RAISE EXCEPTION 'unsupported task type' USING ERRCODE='GA022'; END IF;
  RETURN QUERY WITH inserted AS (INSERT INTO genie_spike.destination_binding(
    task_id,dest_catalog,dest_schema,dest_table,write_scope,identity_ref,status,proposed_by)
    VALUES(p_task_id,p_dest_catalog,p_dest_schema,p_dest_table,scope,'obo_user','pending',session_user) RETURNING *),
  activity AS (INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
    SELECT inserted.task_id,session_user,'binding_proposed','success',jsonb_build_object('binding_id',inserted.binding_id)
    FROM inserted)
  SELECT * FROM inserted;
END $$;

CREATE OR REPLACE FUNCTION genie_spike.approve_destination_binding(p_task_id TEXT,p_binding_id UUID)
RETURNS SETOF genie_spike.destination_binding
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
  WITH approved AS (UPDATE genie_spike.destination_binding SET status='active',approved_by=session_user,approved_at=now()
    WHERE task_id=p_task_id AND binding_id=p_binding_id AND status='pending'
      AND lower(proposed_by)<>lower(session_user) RETURNING *),
  activity AS (INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
    SELECT approved.task_id,session_user,'binding_approved','success',jsonb_build_object('binding_id',approved.binding_id)
    FROM approved)
  SELECT * FROM approved
$$;

CREATE OR REPLACE FUNCTION genie_spike.save_config_draft(p_task_id TEXT,p_settings JSONB)
RETURNS SETOF genie_spike.config_version
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
DECLARE b genie_spike.destination_binding%ROWTYPE; config_payload JSONB;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM genie_spike.task_member WHERE task_id=p_task_id
                AND lower(user_id)=lower(session_user) AND role='owner') THEN
    RAISE EXCEPTION 'task owner required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO b FROM genie_spike.destination_binding WHERE task_id=p_task_id
    AND status IN ('pending','active') ORDER BY proposed_at DESC LIMIT 1;
  IF b.binding_id IS NULL THEN RAISE EXCEPTION 'binding required' USING ERRCODE='GA023'; END IF;
  config_payload:=jsonb_build_object(
    'binding_digest',genie_spike.binding_digest(b.task_id,b.dest_catalog,b.dest_schema,b.dest_table,b.write_scope,b.identity_ref),
    'platform_minimums',jsonb_build_object('money_column_presence',true,'money_parse_validity',true,
      'cross_foot_totals',true,'non_negative_allocations',true,'over_allocation_ceiling',1,
      'structural_confidence_floor',0.8),'settings',p_settings);
  RETURN QUERY INSERT INTO genie_spike.config_version(task_id,version_hash,payload,status,created_by)
    VALUES(p_task_id,repeat('0',64),config_payload,'draft',session_user)
    ON CONFLICT(task_id,version_hash) DO NOTHING RETURNING *;
END $$;

CREATE OR REPLACE FUNCTION genie_spike.submit_config_draft(p_task_id TEXT) RETURNS TABLE(version_hash CHAR(64))
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM genie_spike.task_member WHERE task_id=p_task_id
                AND lower(user_id)=lower(session_user) AND role='owner') THEN
    RAISE EXCEPTION 'task owner required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY WITH draft AS (
    SELECT cv.version_hash FROM genie_spike.config_version cv WHERE cv.task_id=p_task_id
      AND lower(cv.created_by)=lower(session_user) AND cv.status='draft' ORDER BY cv.created_at DESC LIMIT 1),
  activity AS (INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
    SELECT p_task_id,session_user,'config_submitted','success',jsonb_build_object('version_hash',draft.version_hash)
    FROM draft RETURNING 1)
  SELECT draft.version_hash FROM draft WHERE EXISTS(SELECT 1 FROM activity);
END $$;

CREATE OR REPLACE FUNCTION genie_spike.publish_config_version(p_task_id TEXT,p_version_hash CHAR(64))
RETURNS SETOF genie_spike.config_version
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
DECLARE b genie_spike.destination_binding%ROWTYPE; expected_digest TEXT;
BEGIN
  SELECT * INTO b FROM genie_spike.destination_binding WHERE task_id=p_task_id AND status='active';
  expected_digest:=genie_spike.binding_digest(b.task_id,b.dest_catalog,b.dest_schema,b.dest_table,b.write_scope,b.identity_ref);
  RETURN QUERY WITH published AS (
    UPDATE genie_spike.config_version cv SET status='published',approved_by=session_user,published_at=now()
      WHERE cv.task_id=p_task_id AND cv.version_hash=p_version_hash AND cv.status='draft'
        AND lower(cv.created_by)<>lower(session_user) AND cv.payload->>'binding_digest'=expected_digest
      RETURNING cv.*),
  state AS (INSERT INTO genie_spike.task_config_state(task_id,active_version_hash,updated_at)
    SELECT published.task_id,published.version_hash,now() FROM published
    ON CONFLICT(task_id) DO UPDATE SET active_version_hash=EXCLUDED.active_version_hash,updated_at=now()),
  activity AS (INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
    SELECT published.task_id,session_user,'config_published','success',jsonb_build_object('version_hash',published.version_hash)
    FROM published)
  SELECT * FROM published;
END $$;

CREATE OR REPLACE FUNCTION genie_spike.retire_config_version(p_task_id TEXT,p_version_hash CHAR(64))
RETURNS SETOF genie_spike.config_version
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,genie_spike AS $$
  WITH retired AS (UPDATE genie_spike.config_version cv SET status='retired',retired_at=now()
    WHERE cv.task_id=p_task_id AND cv.version_hash=p_version_hash AND cv.status='published' RETURNING cv.*),
  state AS (UPDATE genie_spike.task_config_state SET active_version_hash=NULL,updated_at=now()
    WHERE task_id=p_task_id AND active_version_hash=p_version_hash),
  activity AS (INSERT INTO genie_spike.task_activity(task_id,user_id,action,status,detail)
    SELECT retired.task_id,session_user,'config_retired','success',jsonb_build_object('version_hash',retired.version_hash)
    FROM retired)
  SELECT * FROM retired
$$;

-- Idempotent compatibility seed for both existing live task flows.
INSERT INTO genie_spike.destination_allowlist(dest_catalog,dest_schema,dest_table) VALUES
  (:'destination_catalog','genie_spike','allocation'),
  (:'destination_catalog','genie_spike','vendor_bank_detail') ON CONFLICT DO NOTHING;
INSERT INTO genie_spike.destination_binding(binding_id,task_id,dest_catalog,dest_schema,dest_table,
  write_scope,identity_ref,status,proposed_by,approved_by,approved_at)
SELECT seed.binding_id,seed.task_id,:'destination_catalog','genie_spike',seed.dest_table,seed.write_scope,
  'obo_user','active','migration_seed_proposer','migration_seed_approver',now()
FROM(VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid,'receivables-eu','allocation','{"change_types":["allocation_upsert"]}'::jsonb),
  ('00000000-0000-4000-8000-000000000002'::uuid,'vendor-bank-eu','vendor_bank_detail','{"change_types":["vendor_bank_update"]}'::jsonb)
)seed(binding_id,task_id,dest_table,write_scope)
WHERE EXISTS(SELECT 1 FROM genie_spike.task t WHERE t.task_id=seed.task_id)
  AND NOT EXISTS(SELECT 1 FROM genie_spike.destination_binding db WHERE db.task_id=seed.task_id AND db.status='active')
ON CONFLICT DO NOTHING;
WITH seed_payload AS (
  SELECT db.task_id,jsonb_build_object(
    'binding_digest',genie_spike.binding_digest(db.task_id,db.dest_catalog,db.dest_schema,db.dest_table,db.write_scope,db.identity_ref),
    'platform_minimums',jsonb_build_object('money_column_presence',true,'money_parse_validity',true,
      'cross_foot_totals',true,'non_negative_allocations',true,'over_allocation_ceiling',1,'structural_confidence_floor',0.8),
    'settings',jsonb_build_object('ingest_enabled',db.task_id='receivables-eu','validation_thresholds',
      jsonb_build_object('over_allocation_ceiling',1,'structural_confidence_floor',0.8),'header_aliases','{}'::jsonb)) payload
  FROM genie_spike.destination_binding db WHERE db.task_id IN('receivables-eu','vendor-bank-eu') AND db.status='active')
INSERT INTO genie_spike.config_version(task_id,version_hash,payload,status,created_by,approved_by,published_at)
SELECT task_id,repeat('0',64),payload,'published','migration_seed_proposer','migration_seed_approver',now()
FROM seed_payload ON CONFLICT DO NOTHING;
INSERT INTO genie_spike.task_config_state(task_id,active_version_hash,updated_at)
SELECT cv.task_id,cv.version_hash,now() FROM genie_spike.config_version cv
WHERE cv.task_id IN('receivables-eu','vendor-bank-eu') AND cv.status='published'
  AND cv.created_by='migration_seed_proposer'
ON CONFLICT(task_id) DO NOTHING;

GRANT USAGE ON SCHEMA genie_spike TO :"admin_role";
GRANT USAGE ON SCHEMA genie_spike TO :"obo_role";
REVOKE ALL ON genie_spike.destination_allowlist,genie_spike.destination_binding,genie_spike.config_version,
  genie_spike.task_config_state FROM PUBLIC;
GRANT SELECT ON genie_spike.destination_binding,genie_spike.config_version,genie_spike.task_config_state TO PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON genie_spike.destination_allowlist TO :"admin_role";
REVOKE ALL ON FUNCTION genie_spike.propose_destination_binding(TEXT,TEXT,TEXT,TEXT),
  genie_spike.approve_destination_binding(TEXT,UUID),genie_spike.save_config_draft(TEXT,JSONB),
  genie_spike.submit_config_draft(TEXT),genie_spike.publish_config_version(TEXT,CHAR),
  genie_spike.retire_config_version(TEXT,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION genie_spike.propose_destination_binding(TEXT,TEXT,TEXT,TEXT),
  genie_spike.approve_destination_binding(TEXT,UUID),genie_spike.save_config_draft(TEXT,JSONB),
  genie_spike.submit_config_draft(TEXT),genie_spike.publish_config_version(TEXT,CHAR),
  genie_spike.retire_config_version(TEXT,CHAR) TO :"obo_role";

ALTER TABLE genie_spike.destination_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_spike.config_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_spike.task_config_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS destination_binding_member_read ON genie_spike.destination_binding;
DROP POLICY IF EXISTS config_version_member_read ON genie_spike.config_version;
DROP POLICY IF EXISTS task_config_state_member_read ON genie_spike.task_config_state;
DROP POLICY IF EXISTS destination_binding_admin_all ON genie_spike.destination_binding;
DROP POLICY IF EXISTS config_version_admin_all ON genie_spike.config_version;
DROP POLICY IF EXISTS task_config_state_admin_all ON genie_spike.task_config_state;
CREATE POLICY destination_binding_member_read ON genie_spike.destination_binding FOR SELECT TO PUBLIC
  USING(EXISTS(SELECT 1 FROM genie_spike.task_member tm WHERE tm.task_id=destination_binding.task_id AND lower(tm.user_id)=lower(session_user)));
CREATE POLICY config_version_member_read ON genie_spike.config_version FOR SELECT TO PUBLIC
  USING((status='published' OR(status='draft' AND lower(created_by)=lower(session_user))) AND
    EXISTS(SELECT 1 FROM genie_spike.task_member tm WHERE tm.task_id=config_version.task_id AND lower(tm.user_id)=lower(session_user)));
CREATE POLICY task_config_state_member_read ON genie_spike.task_config_state FOR SELECT TO PUBLIC
  USING(EXISTS(SELECT 1 FROM genie_spike.task_member tm WHERE tm.task_id=task_config_state.task_id AND lower(tm.user_id)=lower(session_user)));
CREATE POLICY destination_binding_admin_all ON genie_spike.destination_binding TO :"admin_role" USING(true) WITH CHECK(true);
CREATE POLICY config_version_admin_all ON genie_spike.config_version TO :"admin_role" USING(true) WITH CHECK(true);
CREATE POLICY task_config_state_admin_all ON genie_spike.task_config_state TO :"admin_role" USING(true) WITH CHECK(true);
