#!/usr/bin/env python3
"""Spike 1 harness — proves the commit_change contract against a live Lakebase.

Covers docs/plan/06-spike-specs.md Spike 1. Rebuilt after the partner code
review; every check asserts an EXACT SQLSTATE (review fix #5) so a permission /
undefined-relation error can't masquerade as an expected rejection.

TWO IDENTITIES (review fix #1 — the boundary is only proven if the caller is
restricted):
  * OWNER  connection — Databricks OAuth token (schema owner). Seeds fixtures
    and holds the writes behind the SECURITY DEFINER proc.
  * CALLER connection — a per-user LOGIN role ('alice') with EXECUTE-only grants.
    All commit/stage calls go through this restricted role, so session_user is
    'alice' INSIDE the definer proc and the identity binding is real.

IDENTITY MODEL (open decision #3): per-user role. commit_change enforces
p_actor_id == session_user for actor_type='user'; a forged actor is rejected
(check_identity_forge). If per-user login proves impractical on Lakebase, the
fallback is SP-connection + endpoint-attested actor — verified in the
serving-endpoint spike, not here.

Env (see .env.example):
  PGHOST, PGDATABASE(=databricks_postgres),
  PGOWNER, PGOWNER_TOKEN         (OAuth token as password),
  PGCALLER(=alice), PGCALLER_PW  (native-login password for the restricted role).
"""
from __future__ import annotations
import os, json, hashlib, uuid, threading
import concurrent.futures as cf
import psycopg

DB = os.environ.get("PGDATABASE", "databricks_postgres")
HOST = os.environ["PGHOST"]

OWNER_DSN = (f"host={HOST} user={os.environ['PGOWNER']} password={os.environ['PGOWNER_TOKEN']} "
             f"dbname={DB} sslmode=require")
CALLER_DSN = (f"host={HOST} user={os.environ.get('PGCALLER','alice')} password={os.environ['PGCALLER_PW']} "
              f"dbname={DB} sslmode=require")


def idem_key(task_id: str, entity_key: str, diff: dict, cfg_hash: str) -> str:
    """Deterministic key = hash(task_id, entity_key, diff, config_version_hash)."""
    blob = json.dumps([task_id, entity_key, diff, cfg_hash], sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def connect(dsn):
    return psycopg.connect(dsn, autocommit=True)


def seed(owner):
    """Reset all transactional state so each check is deterministic. Owner-only."""
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        for t in ("allocation", "proposed_changes", "committed_idempotency", "audit_event", "outbox"):
            cur.execute(f"DELETE FROM {t}")
        cur.execute("INSERT INTO subsidiary_period(subsidiary_id, period, status, generation) "
                    "VALUES ('SUB1','2026-Q1','open',0) "
                    "ON CONFLICT (subsidiary_id, period) DO UPDATE SET status='open'")
        cur.execute("INSERT INTO remittance(remittance_id, subsidiary_id, period, total_amount) "
                    "VALUES ('R1','SUB1','2026-Q1',100.00) "
                    "ON CONFLICT (remittance_id) DO UPDATE SET total_amount=100.00")


def stage_approved(caller, proposal_id, allocations, proposer='alice', approver='bob'):
    diff = {"remittance_id": "R1", "allocations": allocations}
    key = idem_key("recv-recon", "R1", diff, "cfg_v1")
    with caller.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute(
            "INSERT INTO proposed_changes(proposal_id, task_id, change_type, config_version_hash, "
            "state, proposer_id, approver_id, diff, idempotency_key) "
            "VALUES (%s,'recv-recon','allocation_upsert','cfg_v1','approved',%s,%s,%s,%s) "
            "ON CONFLICT (proposal_id) DO NOTHING",
            (proposal_id, proposer, approver, json.dumps(diff), key))
    return key


def commit(caller, proposal_id, actor_id='alice', actor_type='user', fn='commit_change'):
    with caller.cursor() as cur:
        cur.execute(f"SELECT genie_spike.{fn}(%s,%s,%s)", (proposal_id, actor_id, actor_type))
        return cur.fetchone()[0]


def sqlstate_of(exc) -> str | None:
    return getattr(exc, "sqlstate", None)


def expect_sqlstate(fn, code) -> tuple[bool, str]:
    """Run fn; PASS only if it raises with EXACTLY the given SQLSTATE."""
    try:
        fn()
        return False, "no exception raised"
    except psycopg.Error as e:
        got = sqlstate_of(e)
        return (got == code), f"sqlstate={got} (want {code})"


# --- checks (each returns (name, passed, detail)) ---------------------------

def check_identity_ok(owner, caller):
    seed(owner)
    pid = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, pid, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 60}])
    commit(caller, pid, actor_id='alice', actor_type='user')
    with caller.cursor() as cur:
        cur.execute("SELECT actor_id, actor_type, db_principal FROM genie_spike.audit_event WHERE proposal_id=%s", (pid,))
        actor, atype, db_principal = cur.fetchone()
    # session_user (db_principal) must be the RESTRICTED caller role, not owner.
    ok = actor == 'alice' and db_principal == os.environ.get('PGCALLER', 'alice') and db_principal != os.environ['PGOWNER']
    return ("identity(ok): actor==session_user==caller, != owner", ok,
            f"actor={actor} db_principal={db_principal} owner={os.environ['PGOWNER']}")


def check_identity_forge(owner, caller):
    """Caller 'alice' passes a forged actor 'mallory' -> must be rejected GA010."""
    seed(owner)
    pid = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, pid, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 10}])
    ok, detail = expect_sqlstate(lambda: commit(caller, pid, actor_id='mallory', actor_type='user'), 'GA010')
    return ("identity(forge): actor!=session_user rejected", ok, detail)


def check_boundary_direct_dml(caller):
    """Restricted caller must NOT be able to write financial state directly (42501)."""
    def direct_insert():
        with caller.cursor() as cur:
            cur.execute("INSERT INTO genie_spike.allocation(allocation_id, remittance_id, invoice_id, amount) "
                        "VALUES ('HACK','R1','INV9',1.00)")
    ok, detail = expect_sqlstate(direct_insert, '42501')  # insufficient_privilege
    return ("boundary: caller direct DML denied (sole-mutation-boundary)", ok, detail)


def check_idempotent_replay(owner, caller):
    seed(owner)
    pid = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, pid, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 60}])
    r1 = commit(caller, pid)
    r2 = commit(caller, pid)  # replay
    with caller.cursor() as cur:
        cur.execute("SELECT count(*) FROM genie_spike.audit_event WHERE proposal_id=%s", (pid,))
        n = cur.fetchone()[0]
    ok = r1 == r2 and n == 1
    return ("idempotency: replay -> single effect", ok, f"events={n} r1==r2={r1==r2}")


def check_over_allocation(owner, caller):
    """ONE proposal, A1=60 + A2=60 on total 100 -> GA005, and nothing persists."""
    seed(owner)
    pid = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, pid, [
        {"allocation_id": "A1", "invoice_id": "INV1", "amount": 60},
        {"allocation_id": "A2", "invoice_id": "INV2", "amount": 60}])
    ok, detail = expect_sqlstate(lambda: commit(caller, pid), 'GA005')
    with caller.cursor() as cur:
        cur.execute("SELECT COALESCE(SUM(amount),0) FROM genie_spike.allocation WHERE remittance_id='R1'")
        persisted = cur.fetchone()[0]
    ok = ok and persisted == 0
    return ("over-allocation blocked (GA005), rolled back", ok, f"{detail} persisted_sum={persisted}")


def check_sod_equal(owner, caller):
    seed(owner)
    pid = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, pid, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 10}],
                   proposer='alice', approver='alice')
    ok, detail = expect_sqlstate(lambda: commit(caller, pid), 'GA003')
    return ("SoD: proposer==approver rejected (GA003)", ok, detail)


def check_sod_null(owner, caller):
    seed(owner)
    pid = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, pid, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 10}],
                   proposer='alice', approver=None)
    ok, detail = expect_sqlstate(lambda: commit(caller, pid), 'GA003')
    return ("SoD: null approver rejected (GA003)", ok, detail)


def check_stale_version(owner, caller):
    """Commit A1 (version->1); then a second proposal updates A1 with wrong expected_version -> GA004."""
    seed(owner)
    p1 = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, p1, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 40}])
    commit(caller, p1)
    p2 = f"p-{uuid.uuid4().hex[:8]}"
    stage_approved(caller, p2, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 50,
                                 "expected_version": 999}])
    ok, detail = expect_sqlstate(lambda: commit(caller, p2), 'GA004')
    return ("stale expected_version rejected (GA004)", ok, detail)


def _concurrent_run(fn_name, iterations=8):
    """Fire two concurrent proposals (A1=60 / A2=60 on total 100) released by a
    barrier. Returns (max_committed_sum, total_commits_over_runs)."""
    max_sum, total_commits = 0, 0
    for _ in range(iterations):
        with connect(OWNER_DSN) as owner:
            seed(owner)
        barrier = threading.Barrier(2)

        def one(alloc_id, invoice):
            with connect(CALLER_DSN) as c:
                pid = f"p-{uuid.uuid4().hex[:8]}"
                stage_approved(c, pid, [{"allocation_id": alloc_id, "invoice_id": invoice, "amount": 60}])
                barrier.wait()  # release both threads together (review fix: barrier)
                try:
                    commit(c, pid, fn=fn_name)
                    return True
                except psycopg.Error:
                    return False

        with cf.ThreadPoolExecutor(max_workers=2) as ex:
            results = list(ex.map(lambda a: one(*a), [("A1", "INV1"), ("A2", "INV2")]))
        total_commits += sum(results)
        with connect(OWNER_DSN) as owner, owner.cursor() as cur:
            cur.execute("SELECT COALESCE(SUM(amount),0) FROM genie_spike.allocation WHERE remittance_id='R1'")
            max_sum = max(max_sum, float(cur.fetchone()[0]))
    return max_sum, total_commits


def check_concurrent_write_skew():
    """LOCKED build: the invariant must hold — Σ never exceeds total (100)."""
    max_sum, _ = _concurrent_run("commit_change")
    ok = max_sum <= 100.0
    return ("concurrency(locked): Σ never exceeds total", ok, f"max_committed_sum={max_sum}")


def check_negative_control():
    """NO-LOCK build MUST leak (Σ>total) at least once — proves the test can
    detect a broken lock; otherwise the locked test above is meaningless."""
    max_sum, _ = _concurrent_run("commit_change_nolock")
    ok = max_sum > 100.0
    return ("negative-control(no lock): leak detected (proves test discriminates)", ok,
            f"max_committed_sum={max_sum} (want >100)")


def contention_sweep(design="remittance-only"):
    """Emit p50/p95/p99 lock-wait + txn-duration for 1/5/20/50 concurrent
    proposals on ONE (subsidiary,period), for lock-both vs remittance-only+gate,
    and record seal-miss count. Feeds open decision #1. Placeholder budget = 750
    ms p99. NOT part of the pass/fail suite. See README for the plan."""
    raise NotImplementedError("contention sweep — implement against a seeded period; see README")


def main():
    owner = connect(OWNER_DSN)
    caller = connect(CALLER_DSN)
    checks = [
        check_identity_ok(owner, caller),
        check_identity_forge(owner, caller),
        check_boundary_direct_dml(caller),
        check_idempotent_replay(owner, caller),
        check_over_allocation(owner, caller),
        check_sod_equal(owner, caller),
        check_sod_null(owner, caller),
        check_stale_version(owner, caller),
        check_concurrent_write_skew(),
        check_negative_control(),
    ]
    owner.close(); caller.close()
    print(f"{'CHECK':<58} RESULT   DETAIL")
    for name, ok, detail in checks:
        print(f"{name:<58} {'PASS' if ok else 'FAIL':<8} {detail}")
    if not all(ok for _, ok, _ in checks):
        raise SystemExit(1)
    print("\nAll checks PASS. Next: implement contention_sweep() to settle the period-lock fork.")


if __name__ == "__main__":
    main()
