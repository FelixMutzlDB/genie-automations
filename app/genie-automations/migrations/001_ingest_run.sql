-- Additive preview-only ingest metadata. This table contains no financial state.
CREATE TABLE IF NOT EXISTS genie_spike.ingest_run (
  parse_id UUID PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
  requested_by TEXT NOT NULL,
  volume_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  parser_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  run_id BIGINT,
  status TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Run with `psql -v ingest_app_role=<deployment-managed-app-role> ...`.
-- Request-user roles receive no direct ingest_run privileges. The application
-- identity owns immutable paths/digests/artifact references; it may update only
-- Job lifecycle fields after insertion.
GRANT USAGE ON SCHEMA genie_spike TO :"ingest_app_role";
REVOKE ALL ON genie_spike.ingest_run FROM PUBLIC;
GRANT SELECT ON genie_spike.ingest_run TO :"ingest_app_role";
GRANT INSERT (
  parse_id, task_id, requested_by, volume_path, sha256,
  parser_version, config_version, run_id, status, artifact_ref
) ON genie_spike.ingest_run TO :"ingest_app_role";
GRANT UPDATE (run_id, status, updated_at)
  ON genie_spike.ingest_run TO :"ingest_app_role";
