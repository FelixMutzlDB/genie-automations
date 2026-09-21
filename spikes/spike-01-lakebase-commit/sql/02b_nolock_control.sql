-- Spike 1 — TEST CONTROL ONLY. Do NOT deploy to prod.
--
-- commit_change_nolock is a deliberately-broken twin of commit_change with the
-- aggregate-root FOR UPDATE lock REMOVED. Its sole purpose is the negative
-- control (review fix #7 / Claude): the concurrency test must demonstrate that
-- WITHOUT the lock two concurrent disjoint allocations BOTH commit and leak past
-- the remittance total (Σ > total). If the control does NOT leak, the
-- concurrency test is non-discriminating and proves nothing about the lock.
--
-- It is otherwise identical to commit_change (same identity/SoD/idempotency/
-- audit path) so the ONLY variable is the lock.

SET search_path TO genie_spike;

CREATE OR REPLACE FUNCTION commit_change_nolock(
    p_proposal_id  TEXT,
    p_actor_id     TEXT,
    p_actor_type   TEXT DEFAULT 'user'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = genie_spike, pg_temp
AS $$
DECLARE
    v_prop         proposed_changes%ROWTYPE;
    v_prior        committed_idempotency%ROWTYPE;
    v_remittance   remittance%ROWTYPE;
    v_alloc_sum    NUMERIC(18,2);
    v_seq          BIGINT;
    v_result       JSONB;
    v_diff_row     JSONB;
    v_payload      JSONB;
    v_claimed      INT;
BEGIN
    IF p_actor_type = 'user' AND p_actor_id IS DISTINCT FROM session_user THEN
        RAISE EXCEPTION 'identity mismatch' USING ERRCODE = 'GA010';
    END IF;
    SELECT * INTO v_prop FROM proposed_changes WHERE proposal_id = p_proposal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown proposal' USING ERRCODE = 'GA002'; END IF;
    SELECT * INTO v_prior FROM committed_idempotency WHERE idempotency_key = v_prop.idempotency_key;
    IF FOUND AND v_prior.result IS NOT NULL THEN RETURN v_prior.result; END IF;

    INSERT INTO committed_idempotency(idempotency_key, proposal_id, result)
    VALUES (v_prop.idempotency_key, p_proposal_id, NULL) ON CONFLICT (idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN RAISE EXCEPTION 'dup key' USING ERRCODE = 'GA009'; END IF;

    -- >>> DELIBERATELY MISSING: SELECT ... FROM remittance ... FOR UPDATE <<<
    SELECT * INTO v_remittance FROM remittance WHERE remittance_id = (v_prop.diff ->> 'remittance_id');
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown remittance' USING ERRCODE = 'GA006'; END IF;

    FOR v_diff_row IN SELECT * FROM jsonb_array_elements(v_prop.diff -> 'allocations')
    LOOP
        INSERT INTO allocation(allocation_id, remittance_id, invoice_id, amount, entity_version)
        VALUES (v_diff_row ->> 'allocation_id', v_remittance.remittance_id,
                v_diff_row ->> 'invoice_id', (v_diff_row ->> 'amount')::NUMERIC, 1)
        ON CONFLICT (allocation_id) DO UPDATE SET amount = EXCLUDED.amount;
    END LOOP;

    SELECT COALESCE(SUM(amount),0) INTO v_alloc_sum FROM allocation WHERE remittance_id = v_remittance.remittance_id;
    IF v_alloc_sum > v_remittance.total_amount THEN
        RAISE EXCEPTION 'over-allocation' USING ERRCODE = 'GA005';
    END IF;

    v_seq := nextval('commit_seq_seq');
    v_payload := jsonb_build_object('proposal_id', p_proposal_id, 'alloc_sum', v_alloc_sum, 'commit_seq', v_seq);
    INSERT INTO audit_event(proposal_id, actor_id, actor_type, change_type, payload, payload_sha256)
    VALUES (p_proposal_id, p_actor_id, p_actor_type, v_prop.change_type, v_payload,
            encode(sha256(v_payload::text::bytea), 'hex'));
    INSERT INTO outbox(commit_seq, idempotency_key, payload, payload_sha256)
    VALUES (v_seq, v_prop.idempotency_key, v_payload, encode(sha256(v_payload::text::bytea), 'hex'));
    UPDATE proposed_changes SET state = 'committed', commit_seq = v_seq WHERE proposal_id = p_proposal_id;
    v_result := jsonb_build_object('status','committed','commit_seq',v_seq,'alloc_sum',v_alloc_sum);
    UPDATE committed_idempotency SET result = v_result WHERE idempotency_key = v_prop.idempotency_key;
    RETURN v_result;
END;
$$;
