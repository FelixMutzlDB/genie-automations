-- Spike 1 — commit_change stored procedure (PL/pgSQL).
-- Implements docs/plan/01-mutation-contract.md §2. The proc is the SOLE
-- mutation boundary; direct DML on the financial tables / audit / outbox /
-- committed_idempotency is revoked from callers (03_grants).
--
-- ── GENERALIZED FOR AUTOMATION #2 (framework-thesis test) ──────────────────
-- Previously this proc hardcoded `change_type = 'allocation_upsert'` (raising
-- GA011 otherwise) with the root/invariant/apply logic INLINE. That hardcode
-- WAS the over-fit-to-receivables leak. It is now a DISPATCHER: the shared
-- control flow (identity binding, replay, proposal-lock, approved+SoD check,
-- idempotency claim, audit + outbox, state, result finalize) is TYPE-AGNOSTIC
-- and unchanged; each automation type is an ADDITIVE handler function:
--   • _apply_allocation_upsert  (reconciliation #1: remittance root + GA005 over-alloc)
--   • _apply_vendor_bank_update (vendor bank-detail #2: per-record, NO aggregate
--                                invariant, algorithmic/referential validation)
-- Adding a new TYPE = one new _apply_<type> handler + one dispatch arm + config.
-- Adding a new INSTANCE of an existing type = pure config. See the honest
-- classification in docs/plan/13-automation2-changelog.md.
--
-- SECURITY DEFINER (review fix #1): the function runs with the OWNER's
-- privileges (which hold the writes), callers have only EXECUTE — the
-- sole-mutation-boundary guarantee, made real and testable. Handlers are also
-- DEFINER and REVOKEd from PUBLIC (03_grants) so callers can't invoke them
-- directly, only through commit_change's shared guardrails.
--
-- SET search_path (fix #2/#3): pinned on every function.
-- Isolation: READ COMMITTED (the aggregate-root FOR UPDATE lock protects
-- cross-row invariants where a type has one; vendor has none).
--
-- SQLSTATEs (private GA### class): GA001 not-approved, GA002 unknown-proposal,
-- GA003 SoD, GA004 stale/missing-version, GA005 over-allocation, GA006
-- unknown-remittance, GA007 period-not-open, GA008 allocation-ownership, GA009
-- commit-in-progress, GA010 identity-mismatch, GA011 unsupported-change-type,
-- GA012 iban-checksum-invalid, GA013 iban-already-assigned, GA014
-- unknown-or-inactive-vendor.

SET search_path TO genie_spike;

-- ===========================================================================
-- Handler: allocation_upsert (reconciliation #1) — logic UNCHANGED, relocated.
-- Root = the remittance in the diff; invariant = over-allocation ceiling (GA005);
-- advances the (subsidiary, period) generation. Returns a JSONB apply-summary.
-- ===========================================================================
CREATE OR REPLACE FUNCTION _apply_allocation_upsert(p_prop proposed_changes)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = genie_spike, pg_temp
AS $$
DECLARE
    v_remittance   remittance%ROWTYPE;
    v_existing     allocation%ROWTYPE;
    v_alloc_sum    NUMERIC(18,2);
    v_diff_row     JSONB;
    v_period_rows  INT;
BEGIN
    -- Resolve + lock the aggregate root. Missing root => reject (FOR UPDATE on a
    -- nonexistent row silently no-ops otherwise).
    SELECT * INTO v_remittance FROM remittance
        WHERE remittance_id = (p_prop.diff ->> 'remittance_id') FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown remittance %', p_prop.diff ->> 'remittance_id' USING ERRCODE = 'GA006';
    END IF;

    -- Apply allocations. UPDATE: mandatory expected_version + ownership check;
    -- INSERT: create. Parent-lock-before-child makes the later SUM phantom-safe.
    FOR v_diff_row IN SELECT * FROM jsonb_array_elements(p_prop.diff -> 'allocations')
    LOOP
        SELECT * INTO v_existing FROM allocation WHERE allocation_id = v_diff_row ->> 'allocation_id';
        IF FOUND THEN
            IF v_existing.remittance_id <> v_remittance.remittance_id THEN
                RAISE EXCEPTION 'allocation % belongs to remittance %, not %',
                    v_existing.allocation_id, v_existing.remittance_id, v_remittance.remittance_id
                    USING ERRCODE = 'GA008';
            END IF;
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
                    entity_version = entity_version + 1
                WHERE allocation_id = v_existing.allocation_id;
        ELSE
            INSERT INTO allocation(allocation_id, remittance_id, invoice_id, amount, entity_version)
            VALUES (v_diff_row ->> 'allocation_id', v_remittance.remittance_id,
                    v_diff_row ->> 'invoice_id', (v_diff_row ->> 'amount')::NUMERIC, 1);
        END IF;
    END LOOP;

    -- Over-allocation invariant UNDER the root lock.
    SELECT COALESCE(SUM(amount),0) INTO v_alloc_sum
        FROM allocation WHERE remittance_id = v_remittance.remittance_id;
    IF v_alloc_sum > v_remittance.total_amount THEN
        RAISE EXCEPTION 'over-allocation: sum % > remittance total %', v_alloc_sum, v_remittance.total_amount
            USING ERRCODE = 'GA005';
    END IF;

    -- Advance the (subsidiary, period) generation; period MUST be open.
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

    RETURN jsonb_build_object('remittance_id', v_remittance.remittance_id, 'alloc_sum', v_alloc_sum);
END;
$$;

-- ===========================================================================
-- Handler: vendor_bank_update (automation #2) — MATERIALLY DIFFERENT SHAPE.
-- No aggregate invariant. Per-record referential + algorithmic + uniqueness
-- validation, effective-dated (SCD-2) supersede-and-insert. The vendor_master
-- row is the per-vendor CONCURRENCY root (FOR UPDATE) — a reference root for
-- serialization, not an aggregate-sum root. Diff shape:
--   {vendor_id, new_iban, new_bic, effective_date, expected_version?}
-- ===========================================================================
CREATE OR REPLACE FUNCTION _apply_vendor_bank_update(p_prop proposed_changes)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = genie_spike, pg_temp
AS $$
DECLARE
    v_vendor    vendor_master%ROWTYPE;
    v_current   vendor_bank_detail%ROWTYPE;
    v_new_iban  TEXT := upper(regexp_replace(p_prop.diff ->> 'new_iban', '\s', '', 'g'));
    v_new_bic   TEXT := p_prop.diff ->> 'new_bic';
    v_eff       DATE := (p_prop.diff ->> 'effective_date')::DATE;
    v_new_ver   BIGINT;
BEGIN
    -- Referential: vendor must exist AND be active. Lock it as the per-vendor
    -- concurrency root (serializes concurrent changes to the same vendor).
    SELECT * INTO v_vendor FROM vendor_master
        WHERE vendor_id = (p_prop.diff ->> 'vendor_id') FOR UPDATE;
    IF NOT FOUND OR NOT v_vendor.active THEN
        RAISE EXCEPTION 'unknown or inactive vendor %', p_prop.diff ->> 'vendor_id' USING ERRCODE = 'GA014';
    END IF;

    -- Algorithmic: IBAN must pass ISO 7064 MOD-97-10 (additive capability).
    IF NOT iban_is_valid(v_new_iban) THEN
        RAISE EXCEPTION 'IBAN failed checksum/format validation' USING ERRCODE = 'GA012';
    END IF;
    IF v_new_bic !~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$' THEN
        RAISE EXCEPTION 'BIC failed format validation' USING ERRCODE = 'GA012';
    END IF;

    -- Lock the vendor's current bank detail (if any) for the version check.
    SELECT * INTO v_current FROM vendor_bank_detail
        WHERE vendor_id = v_vendor.vendor_id AND is_current FOR UPDATE;
    IF FOUND THEN
        -- Mandatory expected_version on an update (absence rejected, not skipped).
        IF NOT (p_prop.diff ? 'expected_version') THEN
            RAISE EXCEPTION 'missing expected_version for vendor % update', v_vendor.vendor_id
                USING ERRCODE = 'GA004';
        END IF;
        IF v_current.entity_version <> (p_prop.diff ->> 'expected_version')::BIGINT THEN
            RAISE EXCEPTION 'stale vendor-bank row % (have %, expected %)',
                v_vendor.vendor_id, v_current.entity_version, p_prop.diff ->> 'expected_version'
                USING ERRCODE = 'GA004';
        END IF;
        v_new_ver := v_current.entity_version + 1;
    ELSE
        v_new_ver := 1;
    END IF;

    -- Uniqueness / fraud invariant: the new IBAN must not already be CURRENT for a
    -- DIFFERENT vendor. Lock any candidate rows (PERFORM ... FOR UPDATE sets FOUND;
    -- COUNT/aggregate is illegal with FOR UPDATE). The partial-unique index
    -- ux_vbd_current_iban is the defense-in-depth backstop.
    PERFORM 1 FROM vendor_bank_detail
        WHERE iban = v_new_iban AND is_current AND vendor_id <> v_vendor.vendor_id
        FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION 'IBAN already assigned to a different vendor' USING ERRCODE = 'GA013';
    END IF;

    -- Effective-dated supersede-and-insert: retire the prior current row, add new.
    IF v_current.vbd_id IS NOT NULL THEN
        UPDATE vendor_bank_detail SET is_current = FALSE WHERE vbd_id = v_current.vbd_id;
    END IF;
    INSERT INTO vendor_bank_detail(vendor_id, iban, bic, effective_date, entity_version, is_current)
    VALUES (v_vendor.vendor_id, v_new_iban, v_new_bic, v_eff, v_new_ver, TRUE);

    RETURN jsonb_build_object('vendor_id', v_vendor.vendor_id,
        'iban_last4', right(v_new_iban, 4), 'new_version', v_new_ver, 'effective_date', v_eff);
END;
$$;

-- ===========================================================================
-- Parent: commit_change — TYPE-AGNOSTIC shared control flow + dispatch.
-- ===========================================================================
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
    v_prop     proposed_changes%ROWTYPE;
    v_prior    committed_idempotency%ROWTYPE;
    v_apply    JSONB;
    v_seq      BIGINT;
    v_result   JSONB;
    v_payload  JSONB;
    v_claimed  INT;
BEGIN
    -- Identity binding (fix #4; per-user-role model). session_user is the
    -- authoritative login, preserved through DEFINER. OBO user calls: attested
    -- actor MUST equal it (forged actor_id rejected). Batch/SP skip the equality.
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

    -- Claim the idempotency key atomically (result NULL = pending). A concurrent
    -- same-key call blocks on the unique index until this txn commits.
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

    -- ── DISPATCH to the additive per-type handler (the only type-aware line) ──
    IF v_prop.change_type = 'allocation_upsert' THEN
        v_apply := _apply_allocation_upsert(v_prop);
    ELSIF v_prop.change_type = 'vendor_bank_update' THEN
        v_apply := _apply_vendor_bank_update(v_prop);
    ELSE
        RAISE EXCEPTION 'unsupported change_type %', v_prop.change_type USING ERRCODE = 'GA011';
    END IF;

    -- Shared: audit + outbox in the SAME transaction; payload = apply-summary + meta.
    v_seq := nextval('commit_seq_seq');
    v_payload := v_apply || jsonb_build_object('proposal_id', p_proposal_id,
        'change_type', v_prop.change_type, 'commit_seq', v_seq);

    INSERT INTO audit_event(proposal_id, actor_id, actor_type, change_type, payload, payload_sha256)
    VALUES (p_proposal_id, p_actor_id, p_actor_type, v_prop.change_type, v_payload,
            encode(sha256(v_payload::text::bytea), 'hex'));

    INSERT INTO outbox(commit_seq, idempotency_key, payload, payload_sha256)
    VALUES (v_seq, v_prop.idempotency_key, v_payload, encode(sha256(v_payload::text::bytea), 'hex'));

    UPDATE proposed_changes SET state = 'committed', commit_seq = v_seq WHERE proposal_id = p_proposal_id;

    v_result := jsonb_build_object('status','committed','commit_seq',v_seq) || v_apply;

    UPDATE committed_idempotency SET result = v_result WHERE idempotency_key = v_prop.idempotency_key;

    RETURN v_result;
END;
$$;

-- Ownership: all three functions must be owned by the write-holding role
-- (genie_owner). The deploy runs this file AS genie_owner; if deployed as a
-- superuser, reassign each:
--   ALTER FUNCTION genie_spike.commit_change(TEXT,TEXT,TEXT) OWNER TO genie_owner;
--   ALTER FUNCTION genie_spike._apply_allocation_upsert(proposed_changes) OWNER TO genie_owner;
--   ALTER FUNCTION genie_spike._apply_vendor_bank_update(proposed_changes) OWNER TO genie_owner;
