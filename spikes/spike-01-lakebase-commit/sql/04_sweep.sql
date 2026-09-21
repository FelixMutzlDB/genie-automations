-- Spike 1 — contention_sweep support (docs/plan/08). TEST/BENCH ONLY.
--
-- Three period-lock variants in ONE parameterized proc so the ONLY variable is
-- the period-row interaction (docs/plan/08 "kill the confound"):
--   B      : SELECT period FOR UPDATE, require open, bump generation under it
--   APRIME : SELECT period FOR SHARE (after remittance lock), require open, NO generation bump
--   ANAIVE : no period interaction at all (known-broken control for the seal-race detector)
-- All three keep the remittance FOR UPDATE + over-allocation + audit, so they
-- differ ONLY on the period. p_barrier_sec>0 holds locks and sleeps — the
-- deterministic window for the seal-race experiment.

SET search_path TO genie_spike;

CREATE TABLE IF NOT EXISTS seal_log (
    id            BIGSERIAL PRIMARY KEY,
    subsidiary_id TEXT NOT NULL,
    period        TEXT NOT NULL,
    sealed_sum    NUMERIC(18,2) NOT NULL,
    sealed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sweep_commit(
    p_proposal_id TEXT, p_actor_id TEXT, p_variant TEXT, p_barrier_sec DOUBLE PRECISION DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = genie_spike, pg_temp
AS $$
DECLARE
    v_prop      proposed_changes%ROWTYPE;
    v_rem       remittance%ROWTYPE;
    v_alloc_sum NUMERIC(18,2);
    v_seq       BIGINT;
    v_row       JSONB;
    v_status    TEXT;
    t0 TIMESTAMPTZ; t1 TIMESTAMPTZ; v_lockwait DOUBLE PRECISION;
BEGIN
    SELECT * INTO v_prop FROM proposed_changes WHERE proposal_id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown proposal' USING ERRCODE='GA002'; END IF;
    IF v_prop.state <> 'approved' THEN RAISE EXCEPTION 'not approved' USING ERRCODE='GA001'; END IF;

    SELECT * INTO v_rem FROM remittance WHERE remittance_id = (v_prop.diff->>'remittance_id') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown remittance' USING ERRCODE='GA006'; END IF;

    -- period interaction (the ONLY thing that varies) + lock-wait measurement
    t0 := clock_timestamp();
    IF p_variant = 'B' THEN
        PERFORM 1 FROM subsidiary_period
            WHERE subsidiary_id=v_rem.subsidiary_id AND period=v_rem.period FOR UPDATE;
    ELSIF p_variant = 'APRIME' THEN
        PERFORM 1 FROM subsidiary_period
            WHERE subsidiary_id=v_rem.subsidiary_id AND period=v_rem.period FOR SHARE;
    END IF;
    t1 := clock_timestamp();
    v_lockwait := EXTRACT(EPOCH FROM (t1 - t0)) * 1000.0;

    IF p_variant IN ('B','APRIME') THEN
        SELECT status INTO v_status FROM subsidiary_period
            WHERE subsidiary_id=v_rem.subsidiary_id AND period=v_rem.period;   -- checked AFTER the locking read
        IF v_status <> 'open' THEN RAISE EXCEPTION 'period not open' USING ERRCODE='GA007'; END IF;
    END IF;

    FOR v_row IN SELECT * FROM jsonb_array_elements(v_prop.diff->'allocations') LOOP
        INSERT INTO allocation(allocation_id, remittance_id, invoice_id, amount, entity_version)
        VALUES (v_row->>'allocation_id', v_rem.remittance_id, v_row->>'invoice_id', (v_row->>'amount')::NUMERIC, 1)
        ON CONFLICT (allocation_id) DO UPDATE SET amount=EXCLUDED.amount, entity_version=allocation.entity_version+1;
    END LOOP;
    SELECT COALESCE(SUM(amount),0) INTO v_alloc_sum FROM allocation WHERE remittance_id=v_rem.remittance_id;
    IF v_alloc_sum > v_rem.total_amount THEN RAISE EXCEPTION 'over-allocation' USING ERRCODE='GA005'; END IF;

    IF p_variant = 'B' THEN
        UPDATE subsidiary_period SET generation=generation+1
            WHERE subsidiary_id=v_rem.subsidiary_id AND period=v_rem.period;
    END IF;

    -- deterministic seal-race window: hold locks and pause (bench only)
    IF p_barrier_sec > 0 THEN PERFORM pg_sleep(p_barrier_sec); END IF;

    v_seq := nextval('commit_seq_seq');
    INSERT INTO audit_event(proposal_id, actor_id, actor_type, change_type, payload, payload_sha256)
    VALUES (p_proposal_id, p_actor_id, 'service_principal', v_prop.change_type,
            jsonb_build_object('seq', v_seq), encode(sha256(v_seq::text::bytea),'hex'));
    UPDATE proposed_changes SET state='committed', commit_seq=v_seq WHERE proposal_id=p_proposal_id;
    RETURN jsonb_build_object('status','committed','variant',p_variant,'lock_wait_ms',v_lockwait,'alloc_sum',v_alloc_sum);
END; $$;

CREATE OR REPLACE FUNCTION seal_period(p_sub TEXT, p_period TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = genie_spike, pg_temp
AS $$
DECLARE v_sum NUMERIC(18,2);
BEGIN
    PERFORM 1 FROM subsidiary_period WHERE subsidiary_id=p_sub AND period=p_period FOR UPDATE;  -- waits behind in-flight commits (B/A')
    UPDATE subsidiary_period SET status='sealing' WHERE subsidiary_id=p_sub AND period=p_period;
    SELECT COALESCE(SUM(a.amount),0) INTO v_sum FROM allocation a
        JOIN remittance r ON a.remittance_id=r.remittance_id
        WHERE r.subsidiary_id=p_sub AND r.period=p_period;
    INSERT INTO seal_log(subsidiary_id, period, sealed_sum) VALUES (p_sub, p_period, v_sum);
    UPDATE subsidiary_period SET status='sealed' WHERE subsidiary_id=p_sub AND period=p_period;
    RETURN jsonb_build_object('sealed_sum', v_sum);
END; $$;
