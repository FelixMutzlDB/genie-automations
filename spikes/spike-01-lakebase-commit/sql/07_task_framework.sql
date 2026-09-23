-- Additive, idempotent task/organization/user/activity framework.
-- Apply with psql using the Lakebase owner connection, in the same way as the
-- other files in this directory. Safe to re-run after the prerequisite schema
-- and caller roles from 01_schema.sql and 03_grants.sql exist.

CREATE SCHEMA IF NOT EXISTS genie_spike;
SET search_path TO genie_spike;

CREATE TABLE IF NOT EXISTS organization (
    org_id      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task (
    task_id         TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES genie_spike.organization(org_id),
    name            TEXT NOT NULL,
    task_type       TEXT NOT NULL,
    owner_id        TEXT NOT NULL,
    target_catalog  TEXT,
    target_schema   TEXT,
    target_table    TEXT,
    ingest_enabled  BOOLEAN NOT NULL DEFAULT false,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_member (
    task_id    TEXT NOT NULL REFERENCES genie_spike.task(task_id),
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    source     TEXT NOT NULL DEFAULT 'joined' CHECK (source IN ('prefilled', 'joined')),
    joined_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_activity (
    activity_id  BIGSERIAL PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES genie_spike.task(task_id),
    user_id      TEXT,
    action       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'info' CHECK (status IN ('success', 'failure', 'info')),
    detail       JSONB,
    proposal_id  TEXT,
    occurred_at  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO genie_spike.organization(org_id, name)
VALUES ('org-demo', 'Demo Group')
ON CONFLICT DO NOTHING;

INSERT INTO genie_spike.task(
    task_id, org_id, name, task_type, owner_id,
    target_schema, target_table, ingest_enabled
) VALUES
    ('receivables-eu', 'org-demo', 'Receivables collection', 'reconciliation',
     'ops.alice@example.com', 'genie_spike', 'allocation', true),
    ('vendor-bank-eu', 'org-demo', 'Vendor bank details', 'vendor_bank',
     'ops.alice@example.com', 'genie_spike', 'vendor_bank_detail', false)
ON CONFLICT DO NOTHING;

INSERT INTO genie_spike.task_member(task_id, user_id, role, source) VALUES
    ('receivables-eu', 'ops.alice@example.com', 'owner', 'prefilled'),
    ('vendor-bank-eu', 'ops.alice@example.com', 'owner', 'prefilled')
ON CONFLICT DO NOTHING;

-- Framework tables are non-money metadata, so the OBO caller roles may use
-- direct DML. Financial ledger writes remain restricted to guarded procedures.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['alice', 'bob'] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA genie_spike TO %I', r);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON genie_spike.organization, genie_spike.task, '
      'genie_spike.task_member, genie_spike.task_activity TO %I', r
    );
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE genie_spike.task_activity_activity_id_seq TO %I', r);
  END LOOP;
END $$;
