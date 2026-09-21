-- Spike 1 — commit_change stored procedure (PL/pgSQL).
-- Implements docs/plan/01-mutation-contract.md §2. The proc is the SOLE
-- mutation boundary; direct DML on remittance/allocation/subsidiary_period/
-- audit_event/outbox/committed_idempotency is revoked from callers (03_grants).
--
-- SECURITY DEFINER (review fix #1): the function runs with the OWNER's
-- privileges (which hold the writes), while callers have only EXECUTE. This is
-- what makes the sole-mutation-boundary real AND testable — the harness runs as
-- a restricted login and can prove it cannot write directly.
--
-- SET search_path (review fix #2/#3): pinned on the function so object refs
-- resolve at call time regardless of the caller's search_path, and to prevent
-- search-path hijack (mandatory for SECURITY DEFINER).
--
-- Isolation: READ COMMITTED (the aggregate-root FOR UPDATE lock, not the
-- isolation level, protects cross-row invariants).
--
-- Custom SQLSTATEs use a private GA### class (review fix: P0003/P0004 collide
-- with reserved too_many_rows/assert_failure). GA001 not-approved, GA002
-- unknown-proposal, GA003 SoD, GA004 stale/missing-version, GA005 over-
-- allocation, GA006 unknown-remittance, GA007 period-not-open, GA008
-- allocation-ownership, GA009 commit-in-progress, GA010 identity-mismatch,
-- GA011 unsupported-change-type.

SET search_path TO genie_spike;

CREATE OR REPLACE FUNCTION commit_change(
    p_proposal_id  TEXT,
    p_actor_id     TEXT,
    p_actor_type   TEXT DEFAULT 'user'   -- 'user' (OBO, session_user-bound) | 'service_principal' (batch)
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = genie_spike, pg_temp
AS $$
DECLARE
    v_prop         proposed_changes%ROWTYPE;
    v_prior        committed_idempotency%ROWTYPE;
    v_remittance   remittance%ROWTYPE;
    v_existing     allocation%ROWTYPE;
    v_alloc_sum    NUMERIC(18,2);
    v_seq          BIGINT;
    v_result       JSONB;
    v_diff_row     JSONB;
    v_payload      JSONB;
    v_claimed      INT;
    v_period_rows  INT;
BEGIN
    -- Identity binding (review fix #4; open decision #3 = per-user-role model).
    -- session_user is the authoritative login, preserved through DEFINER. For
    -- an OBO user call the attested actor MUST equal it — a forged actor_id is
    -- rejected (closes confused-deputy C-01). Batch/SP calls skip the equality.
    IF p_actor_type = 'user' AND p_actor_id IS DISTINCT FROM session_user THEN
        RAISE EXCEPTION 'identity: attested actor % != session_user %', p_actor_id, session_user
            USING ERRCODE = 'GA010';
    END IF;

    SELECT * INTO v_prop FROM proposed_changes WHERE proposal_id = p_proposal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown proposal %', p_proposal_id USING ERRCODE = 'GA002';
    END IF;

    -- Fast-path replay: a finalized result is returned verbatim, no 2nd effect.
    SELECT * INTO v_prior FROM committed_idempotency WHERE idempotency_key = v_prop.idempotency_key;
    IF FOUND THEN
        IF v_prior.result IS NOT NULL THEN
            RETURN v_prior.result;
        END IF;
        RAISE EXCEPTION 'commit in progress for key %', v_prop.idempotency_key USING ERRCODE = 'GA009';
    END IF;

    -- Lock proposal; re-check approved + SoD (non-null approver AND != proposer).
    SELECT * INTO v_prop FROM proposed_changes WHERE proposal_id = p_proposal_id FOR UPDATE;
    IF v_prop.state <> 'approved' THEN
        RAISE EXCEPTION 'proposal % not approved (state=%)', p_proposal_id, v_prop.state USING ERRCODE = 'GA001';
    END IF;
    IF v_prop.approver_id IS NULL OR v_prop.approver_id = v_prop.proposer_id THEN
        RAISE EXCEPTION 'segregation-of-duties: approver must be present and differ from proposer'
            USING ERRCODE = 'GA003';
    END IF;
    IF v_prop.change_type <> 'allocation_upsert' THEN
        RAISE EXCEPTION 'unsupported change_type %', v_prop.change_type USING ERRCODE = 'GA011';
    END IF;

    -- Claim the idempotency key atomically (result NULL = pending). A concurrent
    -- same-key call blocks on the unique index until this txn commits, then gets
    -- 0 rows here and returns our finalized result (review fix: idempotency race).
    INSERT INTO committed_idempotency(idempotency_key, proposal_id, result)
    VALUES (v_prop.idempotency_key, p_proposal_id, NULL)
    ON CONFLICT (idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
        SELECT * INTO v_prior FROM committed_idempotency WHERE idempotency_key = v_prop.idempotency_key;
        IF v_prior.result IS NOT NULL THEN
            RETURN v_prior.result;
        END IF;
        RAISE EXCEPTION 'commit in progress for key %', v_prop.idempotency_key USING ERRCODE = 'GA009';
    END IF;

    -- Resolve + lock the aggregate root (trusted mapping, not user config):
    -- allocation_upsert -> the remittance in the diff. Missing root => reject
    -- with a clean error (review fix: FOR UPDATE on nonexistent silently no-ops).
    SELECT * INTO v_remittance FROM remittance
        WHERE remittance_id = (v_prop.diff ->> 'remittance_id') FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown remittance %', v_prop.diff ->> 'remittance_id' USING ERRCODE = 'GA006';
    END IF;

    -- Apply allocations. UPDATE path: mandatory expected_version + ownership
    -- check; INSERT path: create. Parent-lock-before-child makes the later SUM
    -- phantom-safe under READ COMMITTED.
    FOR v_diff_row IN SELECT * FROM jsonb_array_elements(v_prop.diff -> 'allocations')
    LOOP
        SELECT * INTO v_existing FROM allocation WHERE allocation_id = v_diff_row ->> 'allocation_id';
        IF FOUND THEN
            -- Ownership: an allocation cannot be moved across remittances (review fix).
            IF v_existing.remittance_id <> v_remittance.remittance_id THEN
                RAISE EXCEPTION 'allocation % belongs to remittance %, not %',
                    v_existing.allocation_id, v_existing.remittance_id, v_remittance.remittance_id
                    USING ERRCODE = 'GA008';
            END IF;
            -- Mandatory version check on UPDATE (absence is rejected, not skipped).
            IF NOT (v_diff_row ? 'expected_version') THEN
                RAISE EXCEPTION 'missing expected_version for update of %', v_existing.allocation_id
                    USING ERRCODE = 'GA004';
            END IF;
            IF v_existing.entity_version <> (v_diff_row ->> 'expected_version')::BIGINT THEN
                RAISE EXCEPTION 'stale row % (have %, expected %)',
                    v_existing.allocation_id, v_existing.entity_version, v_diff_row ->> 'expected_version'
                    USING ERRCODE = 'GA004';
            END IF;
            UPDATE allocation
                SET amount = (v_diff_row ->> 'amount')::NUMERIC,
                    entity_version = entity_version + 1   -- invoice_id/remittance_id immutable
                WHERE allocation_id = v_existing.allocation_id;
        ELSE
            INSERT INTO allocation(allocation_id, remittance_id, invoice_id, amount, entity_version)
            VALUES (v_diff_row ->> 'allocation_id', v_remittance.remittance_id,
                    v_diff_row ->> 'invoice_id', (v_diff_row ->> 'amount')::NUMERIC, 1);
        END IF;
    END LOOP;

    -- Recompute the over-allocation invariant UNDER the root lock.
    SELECT COALESCE(SUM(amount),0) INTO v_alloc_sum
        FROM allocation WHERE remittance_id = v_remittance.remittance_id;
    IF v_alloc_sum > v_remittance.total_amount THEN
        RAISE EXCEPTION 'over-allocation: sum % > remittance total %', v_alloc_sum, v_remittance.total_amount
            USING ERRCODE = 'GA005';
    END IF;

    -- Advance the (subsidiary, period) generation; the period MUST be open, and
    -- exactly one row must update (review fix: assert rowcount). NOTE: doing this
    -- on the line-item path means remittance-only commits still take a period
    -- row lock — contention_sweep() measures that cost to settle open decision #1.
    UPDATE subsidiary_period
        SET generation = generation + 1, entity_version = entity_version + 1
        WHERE subsidiary_id = v_remittance.subsidiary_id
          AND period = v_remittance.period
          AND status = 'open';
    GET DIAGNOSTICS v_period_rows = ROW_COUNT;
    IF v_period_rows <> 1 THEN
        RAISE EXCEPTION 'period %/% not open or missing (rows=%)',
            v_remittance.subsidiary_id, v_remittance.period, v_period_rows USING ERRCODE = 'GA007';
    END IF;

    -- (9) audit + outbox in the SAME transaction.
    v_seq := nextval('commit_seq_seq');
    v_payload := jsonb_build_object('proposal_id', p_proposal_id, 'remittance_id', v_remittance.remittance_id,
        'alloc_sum', v_alloc_sum, 'commit_seq', v_seq);

    INSERT INTO audit_event(proposal_id, actor_id, actor_type, change_type, payload, payload_sha256)
    VALUES (p_proposal_id, p_actor_id, p_actor_type, v_prop.change_type, v_payload,
            encode(sha256(v_payload::text::bytea), 'hex'));

    INSERT INTO outbox(commit_seq, idempotency_key, payload, payload_sha256)
    VALUES (v_seq, v_prop.idempotency_key, v_payload, encode(sha256(v_payload::text::bytea), 'hex'));

    UPDATE proposed_changes SET state = 'committed', commit_seq = v_seq WHERE proposal_id = p_proposal_id;

    v_result := jsonb_build_object('status','committed','commit_seq',v_seq,'alloc_sum',v_alloc_sum);

    -- Finalize the idempotency claim with the result (same txn).
    UPDATE committed_idempotency SET result = v_result WHERE idempotency_key = v_prop.idempotency_key;

    RETURN v_result;
END;
$$;

-- Ownership: the function must be owned by the write-holding role (genie_owner).
-- The deploy runs this file AS genie_owner; if deployed as a superuser, reassign:
--   ALTER FUNCTION genie_spike.commit_change(TEXT,TEXT,TEXT) OWNER TO genie_owner;
