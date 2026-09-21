-- Spike 1 — minimal Lakebase (Postgres) schema for the commit contract.
-- Encodes docs/plan/01-mutation-contract.md. Deploy into a dedicated,
-- owner-owned schema on a throwaway project/branch (see README).
--
-- Postgres 16/17 (Lakebase default: PG 17).
--
-- IDENTITY MODEL (open decision #3 — Spike 1 SELECTS the per-user-role model):
-- callers log in as their OWN Postgres role (native login), so session_user is
-- preserved THROUGH the SECURITY DEFINER boundary. commit_change is owned by
-- genie_owner (holds all financial writes); callers have EXECUTE only. The proc
-- binds the attested actor to session_user for actor_type='user'. The batch /
-- scheduled-chase path uses actor_type='service_principal' (connects as an SP
-- role, actor_id='SP:batch:<job>', equality check skipped).

CREATE SCHEMA IF NOT EXISTS genie_spike;
SET search_path TO genie_spike;

-- ---------------------------------------------------------------------------
-- Aggregate roots. Headers exist by FK invariant so FOR UPDATE always has a
-- target. subsidiary_period carries a generation counter used by the
-- period-lock decision (open decision #1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remittance (
    remittance_id   TEXT PRIMARY KEY,
    subsidiary_id   TEXT NOT NULL,
    period          TEXT NOT NULL,
    total_amount    NUMERIC(18,2) NOT NULL CHECK (total_amount >= 0),
    entity_version  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subsidiary_period (
    subsidiary_id   TEXT NOT NULL,
    period          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open'      -- open | sealing | sealed
                    CHECK (status IN ('open','sealing','sealed')),
    generation      BIGINT NOT NULL DEFAULT 0,        -- bumped atomically by every allocation
    reconciled_sum  NUMERIC(18,2) NOT NULL DEFAULT 0, -- derived value (recomputed at seal)
    entity_version  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (subsidiary_id, period)
);

CREATE TABLE IF NOT EXISTS allocation (
    allocation_id   TEXT PRIMARY KEY,
    remittance_id   TEXT NOT NULL REFERENCES remittance(remittance_id),
    invoice_id      TEXT NOT NULL,
    amount          NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
    entity_version  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_allocation_remittance ON allocation(remittance_id);

-- ---------------------------------------------------------------------------
-- Proposal state machine (docs/plan/01 §1). Approval + commit are proposal-
-- level and atomic; quarantined rows form a NEW proposal. 'expired' fires when
-- the pinned config_version_hash is superseded before approval.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proposed_changes (
    proposal_id         TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    change_type         TEXT NOT NULL,               -- trusted code maps this -> roots + invariant policy
    config_version_hash TEXT NOT NULL,
    state               TEXT NOT NULL DEFAULT 'staged'
                        CHECK (state IN ('staged','validated','approved','committed','published','rejected','expired')),
    proposer_id         TEXT NOT NULL,
    approver_id         TEXT,                         -- must be non-null AND differ from proposer (SoD)
    diff                JSONB NOT NULL,               -- typed change set
    idempotency_key     TEXT NOT NULL,                -- = hash(task_id, entity_key, diff, config_version_hash)
    commit_seq          BIGINT,                       -- assigned at commit; NOT assumed contiguous
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: claimed atomically by the proc via a UNIQUE record (fix: race).
-- result is NULLABLE so the key can be CLAIMED (result NULL = pending) at the
-- start of the txn and finalized at the end; a concurrent same-key call blocks
-- on the unique index until we commit, then returns our result.
CREATE TABLE IF NOT EXISTS committed_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    proposal_id     TEXT NOT NULL,
    result          JSONB,                            -- NULL while pending; final result on success
    committed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable audit. Canonical payload hash now; prev_hash column laid down so a
-- signed hash-chain is a backfill not a migration (docs/plan/01 §6).
-- actor_id = attested end-user (OBO) or 'SP:batch:<job>'. db_principal defaults
-- to session_user — the AUTHORITATIVE connecting login, preserved through the
-- SECURITY DEFINER boundary (current_user inside a definer function is the
-- definer, so we must use session_user here — review fix #4).
CREATE TABLE IF NOT EXISTS audit_event (
    event_id      BIGSERIAL PRIMARY KEY,
    proposal_id   TEXT NOT NULL UNIQUE,               -- one commit per proposal (fix: nice-to-have)
    actor_id      TEXT NOT NULL,
    actor_type    TEXT NOT NULL,
    db_principal  TEXT NOT NULL DEFAULT session_user, -- authoritative connecting login
    change_type   TEXT NOT NULL,
    payload       JSONB NOT NULL,
    payload_sha256 TEXT NOT NULL,
    prev_hash     TEXT,                               -- NULL until hash-chain trigger fires
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transactional outbox. commit_seq via sequence (may gap / reorder — the
-- publisher uses a watermark + gap-tolerant reconciliation, fix #2).
CREATE SEQUENCE IF NOT EXISTS commit_seq_seq;
CREATE TABLE IF NOT EXISTS outbox (
    outbox_id       BIGSERIAL PRIMARY KEY,
    commit_seq      BIGINT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,             -- one outbox row per commit (fix: nice-to-have)
    payload         JSONB NOT NULL,
    payload_sha256  TEXT NOT NULL,
    published       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconciler may write findings but never mutates ledger/audit (C-21).
CREATE TABLE IF NOT EXISTS recon_findings (
    finding_id  BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,
    detail      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
