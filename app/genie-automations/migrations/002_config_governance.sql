-- Additive config-governance registry. Existing task target/config columns remain
-- in place for compatibility but are deprecated and are not used by the app.
-- Run with `psql -v admin_role=<deployment-managed-admin-role> ...`.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS genie_spike.destination_allowlist (
  dest_catalog TEXT NOT NULL,
  dest_schema TEXT NOT NULL,
  dest_table TEXT NOT NULL,
  PRIMARY KEY (dest_catalog, dest_schema, dest_table)
);

CREATE TABLE IF NOT EXISTS genie_spike.destination_binding (
  binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
  dest_catalog TEXT NOT NULL,
  dest_schema TEXT NOT NULL,
  dest_table TEXT NOT NULL,
  write_scope JSONB NOT NULL CHECK (jsonb_typeof(write_scope) = 'object'),
  identity_ref TEXT NOT NULL CHECK (identity_ref = 'obo_user'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'retired')),
  proposed_by TEXT NOT NULL,
  approved_by TEXT,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  CONSTRAINT destination_binding_allowlisted FOREIGN KEY (dest_catalog, dest_schema, dest_table)
    REFERENCES genie_spike.destination_allowlist(dest_catalog, dest_schema, dest_table),
  CONSTRAINT destination_binding_checker CHECK (approved_by IS DISTINCT FROM proposed_by),
  CONSTRAINT destination_binding_active_approved CHECK (status <> 'active' OR approved_by IS NOT NULL),
  CONSTRAINT destination_binding_lifecycle CHECK (
    (status = 'pending' AND approved_at IS NULL AND retired_at IS NULL) OR
    (status = 'active' AND approved_at IS NOT NULL AND retired_at IS NULL) OR
    (status = 'retired' AND retired_at IS NOT NULL)
  ),
  CONSTRAINT destination_binding_receivables_scope CHECK (
    write_scope -> 'change_types' = '["allocation_upsert"]'::jsonb
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS destination_binding_one_active_per_task
  ON genie_spike.destination_binding(task_id) WHERE status = 'active';

CREATE OR REPLACE FUNCTION genie_spike.destination_binding_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM genie_spike.task t WHERE t.task_id=NEW.task_id
                  AND t.task_type IN ('receivables','allocation_upsert','reconciliation')) THEN
    RAISE EXCEPTION 'MVP bindings are receivables-only' USING ERRCODE = 'GA022';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS destination_binding_guard_trigger ON genie_spike.destination_binding;
CREATE TRIGGER destination_binding_guard_trigger
BEFORE INSERT OR UPDATE ON genie_spike.destination_binding
FOR EACH ROW EXECUTE FUNCTION genie_spike.destination_binding_guard();

CREATE TABLE IF NOT EXISTS genie_spike.config_version (
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
  version_hash CHAR(64) NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, version_hash),
  CONSTRAINT config_version_checker CHECK (approved_by IS DISTINCT FROM created_by),
  CONSTRAINT config_version_published_approved CHECK (status = 'draft' OR approved_by IS NOT NULL),
  CONSTRAINT config_version_lifecycle CHECK (
    (status = 'draft' AND published_at IS NULL AND retired_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL AND retired_at IS NULL) OR
    (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS genie_spike.task_config_state (
  task_id TEXT PRIMARY KEY REFERENCES genie_spike.task(task_id),
  active_version_hash CHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_config_state_version_fk
    FOREIGN KEY (task_id, active_version_hash)
    REFERENCES genie_spike.config_version(task_id, version_hash)
);

CREATE OR REPLACE FUNCTION genie_spike.config_version_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE computed_hash TEXT;
BEGIN
  computed_hash := encode(digest(convert_to(NEW.payload::text, 'UTF8'), 'sha256'), 'hex');
  IF TG_OP = 'INSERT' THEN
    NEW.version_hash := computed_hash;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('published', 'retired') AND
     (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.version_hash IS DISTINCT FROM OLD.version_hash) THEN
    RAISE EXCEPTION 'published config payload and hash are immutable' USING ERRCODE = 'GA020';
  END IF;
  IF OLD.status = 'retired' OR (OLD.status = 'published' AND NEW.status NOT IN ('published', 'retired')) THEN
    RAISE EXCEPTION 'invalid config lifecycle transition' USING ERRCODE = 'GA021';
  END IF;
  IF OLD.status = 'draft' THEN
    NEW.version_hash := computed_hash;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS config_version_guard_trigger ON genie_spike.config_version;
CREATE TRIGGER config_version_guard_trigger
BEFORE INSERT OR UPDATE ON genie_spike.config_version
FOR EACH ROW EXECUTE FUNCTION genie_spike.config_version_guard();

GRANT USAGE ON SCHEMA genie_spike TO :"admin_role";
REVOKE ALL ON genie_spike.destination_allowlist, genie_spike.destination_binding, genie_spike.config_version,
  genie_spike.task_config_state FROM PUBLIC;
GRANT SELECT ON genie_spike.destination_binding, genie_spike.config_version,
  genie_spike.task_config_state TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON genie_spike.destination_allowlist TO :"admin_role";
GRANT SELECT, INSERT, UPDATE ON genie_spike.destination_binding,
  genie_spike.config_version, genie_spike.task_config_state TO :"admin_role";

ALTER TABLE genie_spike.destination_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_spike.config_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE genie_spike.task_config_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY destination_binding_member_read ON genie_spike.destination_binding FOR SELECT TO PUBLIC
  USING (EXISTS (SELECT 1 FROM genie_spike.task_member tm
                  WHERE tm.task_id=destination_binding.task_id AND lower(tm.user_id)=lower(session_user)));
CREATE POLICY config_version_member_read ON genie_spike.config_version FOR SELECT TO PUBLIC
  USING ((status='published' OR (status='draft' AND lower(created_by)=lower(session_user)))
         AND EXISTS (SELECT 1 FROM genie_spike.task_member tm
                      WHERE tm.task_id=config_version.task_id AND lower(tm.user_id)=lower(session_user)));
CREATE POLICY task_config_state_member_read ON genie_spike.task_config_state FOR SELECT TO PUBLIC
  USING (EXISTS (SELECT 1 FROM genie_spike.task_member tm
                  WHERE tm.task_id=task_config_state.task_id AND lower(tm.user_id)=lower(session_user)));
CREATE POLICY destination_binding_admin_all ON genie_spike.destination_binding TO :"admin_role" USING (true) WITH CHECK (true);
CREATE POLICY config_version_admin_all ON genie_spike.config_version TO :"admin_role" USING (true) WITH CHECK (true);
CREATE POLICY task_config_state_admin_all ON genie_spike.task_config_state TO :"admin_role" USING (true) WITH CHECK (true);
