-- Spike 1 — guarded staging/approval (red-team follow-up (i), C-02 segregation of duties).
--
-- Closes the spike shortcut where a caller could INSERT/UPDATE proposed_changes
-- directly and self-set state='approved', bypassing the human-approval + SoD gate.
--
-- After this file: callers have NO direct DML on proposed_changes. The only path
-- to a staged/approved proposal is these SECURITY DEFINER procs, which bind
-- proposer_id and approver_id to session_user (the authenticated login — NOT a
-- caller-supplied string) and enforce approver != proposer.

SET search_path TO genie_spike;

CREATE OR REPLACE FUNCTION stage_change(
    p_task_id TEXT, p_change_type TEXT, p_cfg_hash TEXT, p_diff JSONB
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = genie_spike, pg_temp
AS $$
DECLARE v_pid TEXT; v_key TEXT; v_entity TEXT;
BEGIN
    v_pid := 'p-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
    v_entity := p_diff ->> 'remittance_id';
    v_key := encode(sha256(convert_to(
        p_task_id || '|' || COALESCE(v_entity,'') || '|' || p_diff::text || '|' || p_cfg_hash, 'UTF8')), 'hex');
    INSERT INTO proposed_changes(proposal_id, task_id, change_type, config_version_hash,
        state, proposer_id, approver_id, diff, idempotency_key)
    VALUES (v_pid, p_task_id, p_change_type, p_cfg_hash, 'staged', session_user, NULL, p_diff, v_key);
    RETURN v_pid;   -- proposer is the AUTHENTICATED login, not forgeable
END; $$;

CREATE OR REPLACE FUNCTION approve_change(p_proposal_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = genie_spike, pg_temp
AS $$
DECLARE v_prop proposed_changes%ROWTYPE;
BEGIN
    SELECT * INTO v_prop FROM proposed_changes WHERE proposal_id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown proposal %', p_proposal_id USING ERRCODE='GA002'; END IF;
    IF v_prop.state NOT IN ('staged','validated') THEN
        RAISE EXCEPTION 'proposal % not in an approvable state (%)', p_proposal_id, v_prop.state USING ERRCODE='GA001';
    END IF;
    IF session_user = v_prop.proposer_id THEN
        RAISE EXCEPTION 'segregation-of-duties: approver (%) must differ from proposer', session_user USING ERRCODE='GA003';
    END IF;
    UPDATE proposed_changes SET state='approved', approver_id=session_user WHERE proposal_id=p_proposal_id;
    RETURN jsonb_build_object('status','approved','approver',session_user);
END; $$;

-- Callers may NO LONGER write proposed_changes directly (sole path = the procs).
REVOKE INSERT, UPDATE ON genie_spike.proposed_changes FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION genie_spike.stage_change(TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION genie_spike.approve_change(TEXT) FROM PUBLIC;

DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['alice','bob'] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE ON genie_spike.proposed_changes FROM %I', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION genie_spike.stage_change(TEXT,TEXT,TEXT,JSONB) TO %I', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION genie_spike.approve_change(TEXT) TO %I', r);
  END LOOP;
END $$;
