#!/usr/bin/env python3
"""Spike 1 harness — commit_change contract, GUARDED-APPROVAL model.

After sql/05_guarded_approval.sql, callers have NO direct DML on proposed_changes:
staging/approval go through stage_change / approve_change (proposer & approver
bound to session_user; approver != proposer). This harness reflects that model.

Identities:
  OWNER  — schema owner (OAuth token). Seeds fixtures; holds writes behind the
           SECURITY DEFINER procs. Also used for the defense-in-depth commit-SoD
           check (owner retains direct DML to stage a deliberately-bad proposal).
  alice / bob — restricted per-user LOGIN roles (EXECUTE only). alice proposes,
           bob approves — real segregation of duties by identity.

Env: PGHOST, PGOWNER, PGOWNER_TOKEN, ALICE_PW, BOB_PW.
"""
from __future__ import annotations
import os, json, uuid, threading
import concurrent.futures as cf
import psycopg

HOST, DB = os.environ["PGHOST"], "databricks_postgres"
OWNER = f"host={HOST} user={os.environ['PGOWNER']} password={os.environ['PGOWNER_TOKEN']} dbname={DB} sslmode=require"
ALICE = f"host={HOST} user=alice password={os.environ['ALICE_PW']} dbname={DB} sslmode=require"
BOB = f"host={HOST} user=bob password={os.environ['BOB_PW']} dbname={DB} sslmode=require"


def c(dsn):
    return psycopg.connect(dsn, autocommit=True)


def sqlstate(fn, code):
    try:
        fn(); return False, "no exception"
    except psycopg.Error as e:
        return e.sqlstate == code, f"sqlstate={e.sqlstate} want {code}"


def seed(owner):
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        for t in ("allocation", "proposed_changes", "committed_idempotency", "audit_event", "outbox"):
            cur.execute(f"DELETE FROM {t}")
        cur.execute("INSERT INTO subsidiary_period(subsidiary_id,period,status) VALUES ('SUB1','2026-Q1','open') "
                    "ON CONFLICT (subsidiary_id,period) DO UPDATE SET status='open'")
        cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) "
                    "VALUES ('R1','SUB1','2026-Q1',100.00) ON CONFLICT (remittance_id) DO UPDATE SET total_amount=100.00")


def stage_and_approve(alice, bob, allocations):
    """alice proposes (stage_change), bob approves (approve_change). Guarded path."""
    diff = {"remittance_id": "R1", "allocations": allocations}
    pid = alice.execute("SELECT genie_spike.stage_change('recv-recon','allocation_upsert','cfg_v1',%s)",
                        (json.dumps(diff),)).fetchone()[0]
    bob.execute("SELECT genie_spike.approve_change(%s)", (pid,))
    return pid


def commit(conn, pid, actor_id="alice", actor_type="user", fn="commit_change"):
    return conn.execute(f"SELECT genie_spike.{fn}(%s,%s,%s)", (pid, actor_id, actor_type)).fetchone()[0]


# --- checks -----------------------------------------------------------------
def check_identity_ok(owner, alice, bob):
    seed(owner)
    pid = stage_and_approve(alice, bob, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 60}])
    commit(alice, pid, "alice", "user")
    a, dbp = owner.execute("SELECT actor_id, db_principal FROM genie_spike.audit_event WHERE proposal_id=%s", (pid,)).fetchone()
    ok = a == "alice" and dbp == "alice" and dbp != os.environ["PGOWNER"]
    return ("identity: actor==session_user==alice, != owner", ok, f"actor={a} db_principal={dbp}")


def check_identity_forge(owner, alice, bob):
    seed(owner)
    pid = stage_and_approve(alice, bob, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 10}])
    ok, d = sqlstate(lambda: commit(alice, pid, "mallory", "user"), "GA010")
    return ("identity(forge): actor!=session_user rejected", ok, d)


def check_boundary_direct_dml(alice):
    ok, d = sqlstate(lambda: alice.execute(
        "INSERT INTO genie_spike.allocation(allocation_id,remittance_id,invoice_id,amount) VALUES ('HACK','R1','INV9',1)"), "42501")
    return ("boundary: caller direct DML denied", ok, d)


def check_guarded_no_self_approve(owner, alice):
    seed(owner)
    diff = {"remittance_id": "R1", "allocations": [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 10}]}
    pid = alice.execute("SELECT genie_spike.stage_change('recv-recon','allocation_upsert','cfg_v1',%s)", (json.dumps(diff),)).fetchone()[0]
    ok, d = sqlstate(lambda: alice.execute("SELECT genie_spike.approve_change(%s)", (pid,)), "GA003")
    return ("guarded: alice cannot self-approve (GA003)", ok, d)


def check_idempotent_replay(owner, alice, bob):
    seed(owner)
    pid = stage_and_approve(alice, bob, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 60}])
    r1 = commit(alice, pid); r2 = commit(alice, pid)
    n = owner.execute("SELECT count(*) FROM genie_spike.audit_event WHERE proposal_id=%s", (pid,)).fetchone()[0]
    return ("idempotency: replay -> single effect", r1 == r2 and n == 1, f"events={n} r1==r2={r1==r2}")


def check_over_allocation(owner, alice, bob):
    seed(owner)
    pid = stage_and_approve(alice, bob, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 60},
                                         {"allocation_id": "A2", "invoice_id": "INV2", "amount": 60}])
    ok, d = sqlstate(lambda: commit(alice, pid), "GA005")
    persisted = owner.execute("SELECT COALESCE(SUM(amount),0) FROM genie_spike.allocation WHERE remittance_id='R1'").fetchone()[0]
    return ("over-allocation blocked (GA005), rolled back", ok and persisted == 0, f"{d} persisted={persisted}")


def check_stale_version(owner, alice, bob):
    seed(owner)
    p1 = stage_and_approve(alice, bob, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 40}])
    commit(alice, p1)
    p2 = stage_and_approve(alice, bob, [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 50, "expected_version": 999}])
    ok, d = sqlstate(lambda: commit(alice, p2), "GA004")
    return ("stale expected_version rejected (GA004)", ok, d)


def check_sod_commit_defense(owner):
    """Defense-in-depth: even a directly-inserted self-approved proposal (owner
    DML) is rejected by commit_change's own SoD guard."""
    seed(owner)
    pid = f"bad-{uuid.uuid4().hex[:6]}"
    diff = {"remittance_id": "R1", "allocations": [{"allocation_id": "A1", "invoice_id": "INV1", "amount": 10}]}
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("INSERT INTO proposed_changes(proposal_id,task_id,change_type,config_version_hash,state,"
                    "proposer_id,approver_id,diff,idempotency_key) VALUES (%s,'t','allocation_upsert','v','approved',"
                    "'same','same',%s,%s)", (pid, json.dumps(diff), uuid.uuid4().hex))
    ok, d = sqlstate(lambda: commit(owner, pid, os.environ["PGOWNER"], "service_principal"), "GA003")
    return ("commit_change SoD defense (proposer==approver)", ok, d)


def _concurrent_run(fn_name, iterations=6):
    max_sum = 0
    for _ in range(iterations):
        with c(OWNER) as o:
            seed(o)
        barrier = threading.Barrier(2)

        def one(alloc, inv):
            with c(ALICE) as a, c(BOB) as b:
                pid = stage_and_approve(a, b, [{"allocation_id": alloc, "invoice_id": inv, "amount": 60}])
                barrier.wait()
                try:
                    commit(a, pid, fn=fn_name); return True
                except psycopg.Error:
                    return False

        with cf.ThreadPoolExecutor(max_workers=2) as ex:
            list(ex.map(lambda t: one(*t), [("A1", "INV1"), ("A2", "INV2")]))
        with c(OWNER) as o:
            max_sum = max(max_sum, float(o.execute("SELECT COALESCE(SUM(amount),0) FROM genie_spike.allocation WHERE remittance_id='R1'").fetchone()[0]))
    return max_sum


def main():
    owner, alice, bob = c(OWNER), c(ALICE), c(BOB)
    checks = [
        check_identity_ok(owner, alice, bob),
        check_identity_forge(owner, alice, bob),
        check_boundary_direct_dml(alice),
        check_guarded_no_self_approve(owner, alice),
        check_idempotent_replay(owner, alice, bob),
        check_over_allocation(owner, alice, bob),
        check_stale_version(owner, alice, bob),
        check_sod_commit_defense(owner),
    ]
    owner.close(); alice.close(); bob.close()
    locked = _concurrent_run("commit_change")
    control = _concurrent_run("commit_change_nolock")
    checks.append(("concurrency(locked): Σ never exceeds total", locked <= 100.0, f"max={locked}"))
    checks.append(("negative-control(no lock): leak detected", control > 100.0, f"max={control} (want >100)"))

    print(f"{'CHECK':<50} RESULT   DETAIL")
    for name, ok, d in checks:
        print(f"{name:<50} {'PASS' if ok else 'FAIL':<8} {d}")
    if not all(ok for _, ok, _ in checks):
        raise SystemExit(1)
    print("\nAll checks PASS (guarded-approval model).")


if __name__ == "__main__":
    main()
