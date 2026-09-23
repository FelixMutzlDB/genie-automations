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

GRANT SELECT, INSERT, UPDATE ON genie_spike.ingest_run TO alice, bob;
