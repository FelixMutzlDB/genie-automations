-- Spike 1 — least-privilege grants (review fixes #1/#3).
--
-- Model: commit_change is SECURITY DEFINER owned by genie_owner (holds all
-- financial writes). Caller LOGIN roles (per-user: alice, bob) get EXECUTE +
-- staging on proposed_changes only — NO direct DML on financial state or audit.
-- This is the "stored proc is the sole mutation boundary" guarantee, enforced.
--
-- Prereq: roles genie_owner, alice, bob exist (the deploy creates them; see
-- README). Run this file AS genie_owner (or a superuser) after 01/02/02b.
--
-- search_path is set so the unqualified fixups below resolve (review fix #3);
-- object refs are ALSO schema-qualified for safety.

SET search_path TO genie_spike;

-- Remove any ambient PUBLIC access.
REVOKE INSERT, UPDATE, DELETE ON
    genie_spike.remittance, genie_spike.allocation, genie_spike.subsidiary_period,
    genie_spike.audit_event, genie_spike.outbox, genie_spike.committed_idempotency,
    genie_spike.vendor_master, genie_spike.vendor_bank_detail
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION genie_spike.commit_change(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION genie_spike.commit_change_nolock(TEXT, TEXT, TEXT) FROM PUBLIC;
-- Additive per-type handlers are INTERNAL: callers reach them only THROUGH
-- commit_change's shared guardrails, never directly (sole-mutation-boundary).
REVOKE EXECUTE ON FUNCTION genie_spike._apply_allocation_upsert(genie_spike.proposed_changes) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION genie_spike._apply_vendor_bank_update(genie_spike.proposed_changes) FROM PUBLIC;

-- Grant the restricted caller roles EXECUTE + staging + read only.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['alice','bob'] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA genie_spike TO %I', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION genie_spike.commit_change(TEXT,TEXT,TEXT) TO %I', r);
    -- control twin, EXECUTE only, for the negative-control test:
    EXECUTE format('GRANT EXECUTE ON FUNCTION genie_spike.commit_change_nolock(TEXT,TEXT,TEXT) TO %I', r);
    EXECUTE format('GRANT SELECT ON genie_spike.remittance, genie_spike.allocation, '
                   'genie_spike.subsidiary_period, genie_spike.proposed_changes, '
                   'genie_spike.audit_event, genie_spike.outbox, '
                   'genie_spike.vendor_master, genie_spike.vendor_bank_detail TO %I', r);
    -- Staging/approval: for the spike the harness plays the app/endpoint. In
    -- prod this is a GUARDED procedure (callers must not set state='approved'
    -- directly) — documented follow-up (GPT loose-grant finding).
    EXECUTE format('GRANT INSERT, UPDATE ON genie_spike.proposed_changes TO %I', r);
  END LOOP;
END $$;

-- Reconciler principal (illustrative): read-only on ledger/audit, may write
-- findings, never UPDATE/DELETE audit or ledger (C-21).
-- GRANT SELECT ON genie_spike.audit_event, genie_spike.outbox, genie_spike.remittance,
--     genie_spike.allocation TO "<RECON_ROLE>";
-- GRANT INSERT ON genie_spike.recon_findings TO "<RECON_ROLE>";
