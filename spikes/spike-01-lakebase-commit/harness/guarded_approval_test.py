#!/usr/bin/env python3
"""Prove red-team follow-up (i): callers cannot self-approve or write state directly.

Deploys sql/05_guarded_approval.sql, resets alice/bob passwords, then asserts:
  1. alice can stage_change (proposer bound to session_user 'alice')
  2. alice CANNOT approve her own proposal            -> GA003 (SoD)
  3. alice CANNOT UPDATE proposed_changes.state directly -> 42501 (revoked)
  4. bob CAN approve                                   -> approved, approver='bob'
  5. commit_change then succeeds (proposer alice != approver bob)

Env: PGHOST, PGOWNER, PGOWNER_TOKEN, ALICE_PW, BOB_PW.
"""
from __future__ import annotations
import os, json, pathlib
import psycopg
from psycopg import pq

HOST, DB = os.environ["PGHOST"], "databricks_postgres"
OWNER = f"host={HOST} user={os.environ['PGOWNER']} password={os.environ['PGOWNER_TOKEN']} dbname={DB} sslmode=require"
ALICE = f"host={HOST} user=alice password={os.environ['ALICE_PW']} dbname={DB} sslmode=require"
BOB = f"host={HOST} user=bob password={os.environ['BOB_PW']} dbname={DB} sslmode=require"
SQL05 = pathlib.Path(__file__).resolve().parent.parent / "sql" / "05_guarded_approval.sql"


def sqlstate(fn, code):
    try:
        fn(); return False, "no exception"
    except psycopg.Error as e:
        return e.sqlstate == code, f"sqlstate={e.sqlstate} want {code}"


def main():
    with psycopg.connect(OWNER, autocommit=True) as o:
        res = o.pgconn.exec_(SQL05.read_text().encode())
        if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
            raise RuntimeError(res.error_message.decode())
        with o.cursor() as cur:
            cur.execute("SET search_path TO genie_spike")
            cur.execute(f"ALTER ROLE alice PASSWORD '{os.environ['ALICE_PW']}'")
            cur.execute(f"ALTER ROLE bob PASSWORD '{os.environ['BOB_PW']}'")
            for t in ("allocation", "proposed_changes", "committed_idempotency", "audit_event", "outbox"):
                cur.execute(f"DELETE FROM {t}")
            cur.execute("INSERT INTO subsidiary_period(subsidiary_id,period,status) VALUES ('SUB1','2026-Q1','open') "
                        "ON CONFLICT (subsidiary_id,period) DO UPDATE SET status='open'")
            cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) "
                        "VALUES ('R1','SUB1','2026-Q1',1000.00) ON CONFLICT (remittance_id) DO UPDATE SET total_amount=1000.00")

    diff = {"remittance_id": "R1", "allocations": [{"allocation_id": "A1", "invoice_id": "INV1", "amount": "100.00"}]}
    results = []
    alice = psycopg.connect(ALICE, autocommit=True)
    bob = psycopg.connect(BOB, autocommit=True)

    # 1. alice stages
    pid = alice.execute("SELECT genie_spike.stage_change('recv-recon','allocation_upsert','cfg_v1',%s)",
                        (json.dumps(diff),)).fetchone()[0]
    row = alice.execute("SELECT state, proposer_id FROM genie_spike.proposed_changes WHERE proposal_id=%s", (pid,)).fetchone()
    results.append(("alice stages (proposer=alice, staged)", row == ("staged", "alice"), str(row)))

    # 2. alice cannot self-approve
    ok, d = sqlstate(lambda: alice.execute("SELECT genie_spike.approve_change(%s)", (pid,)), "GA003")
    results.append(("alice self-approve blocked (GA003)", ok, d))

    # 3. alice cannot write state directly
    ok, d = sqlstate(lambda: alice.execute(
        "UPDATE genie_spike.proposed_changes SET state='approved' WHERE proposal_id=%s", (pid,)), "42501")
    results.append(("alice direct state UPDATE blocked (42501)", ok, d))

    # 4. bob approves
    appr = bob.execute("SELECT genie_spike.approve_change(%s)", (pid,)).fetchone()[0]
    results.append(("bob approves (approver=bob)", appr.get("approver") == "bob", str(appr)))

    # 5. commit now succeeds (proposer alice != approver bob)
    out = bob.execute("SELECT genie_spike.commit_change(%s,%s,%s)", (pid, "bob", "user")).fetchone()[0]
    n = bob.execute("SELECT count(*) FROM genie_spike.audit_event WHERE proposal_id=%s", (pid,)).fetchone()[0]
    results.append(("commit after guarded approval", out.get("status") == "committed" and n == 1, f"{out} audit={n}"))

    alice.close(); bob.close()
    print(f"{'CHECK':<44} RESULT   DETAIL")
    for name, ok, d in results:
        print(f"{name:<44} {'PASS' if ok else 'FAIL':<8} {d}")
    if not all(ok for _, ok, _ in results):
        raise SystemExit(1)
    print("Guarded approval (blocker i): PASS — no self-approve, no direct state writes.")


if __name__ == "__main__":
    main()
