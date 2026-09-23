#!/usr/bin/env python3
"""
Seed the genie_spike schema with a hands-on demo state for the spike-03 supervisor.

Creates (idempotently):
  * subsidiary_period SUB1 / 2026-Q1 (open)
  * remittance RDEMO-1 (total 5000) with allocations A-1/A-2/A-3  -> Felix corrects one
    via the agent, then hits GA003 when he tries to self-approve (SoD fires).
  * remittance RDEMO-2 (total 3000) with allocations B-1/B-2, plus:
      - p_alice_ok   : alice-staged VALID correction (B-2 -> 1200)  -> Felix approves+commits
                       (proposer alice != approver felix, SoD passes; audit actor = felix).
      - p_alice_over : alice-staged OVER-allocation (B-2 -> 5000 on a 3000 remittance)
                       -> Felix approves, then commit -> GA005, nothing persists.

Baseline ledger rows are inserted as the OWNER (felix). The two proposals are staged
AS ALICE via the real stage_change proc (proposer bound to session_user=alice), so the
segregation-of-duties story is genuine, not faked.

Env: PGHOST, PGDATABASE, PGOWNER, PGOWNER_TOKEN, ALICE_PW  (see README).
"""
import json
import os

import psycopg

HOST = os.environ["PGHOST"]
DB = os.environ.get("PGDATABASE", "databricks_postgres")
OWNER = os.environ["PGOWNER"]
OWNER_TOKEN = os.environ["PGOWNER_TOKEN"]
ALICE_PW = os.environ["ALICE_PW"]
TASK, CT, CFG = "RECV-RECON", "allocation_upsert", "cfg-demo-v1"


def owner_conn():
    return psycopg.connect(host=HOST, dbname=DB, user=OWNER, password=OWNER_TOKEN,
                           sslmode="require", autocommit=True)


def alice_conn():
    return psycopg.connect(host=HOST, dbname=DB, user="alice", password=ALICE_PW,
                           sslmode="require", autocommit=True)


def seed_baseline(c):
    c.execute("SET search_path TO genie_spike")
    c.execute("INSERT INTO subsidiary_period(subsidiary_id,period,status) VALUES('SUB1','2026-Q1','open') "
              "ON CONFLICT (subsidiary_id,period) DO UPDATE SET status='open'")
    for rid, total in (("RDEMO-1", 5000.00), ("RDEMO-2", 3000.00), ("RDEMO-3", 1000.00)):
        c.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) "
                  "VALUES(%s,'SUB1','2026-Q1',%s) ON CONFLICT (remittance_id) "
                  "DO UPDATE SET total_amount=EXCLUDED.total_amount", (rid, total))
    allocs = [("A-1", "RDEMO-1", "INV-1001", 1500.00), ("A-2", "RDEMO-1", "INV-1002", 900.00),
              ("A-3", "RDEMO-1", "INV-1003", 1200.00), ("B-1", "RDEMO-2", "INV-2001", 1000.00),
              ("B-2", "RDEMO-2", "INV-2002", 800.00), ("C-1", "RDEMO-3", "INV-3001", 400.00)]
    for aid, rid, inv, amt in allocs:
        # baseline seeding as owner (setup, not a demo action)
        c.execute("INSERT INTO allocation(allocation_id,remittance_id,invoice_id,amount,entity_version) "
                  "VALUES(%s,%s,%s,%s,1) ON CONFLICT (allocation_id) "
                  "DO UPDATE SET amount=EXCLUDED.amount, entity_version=1", (aid, rid, inv, amt))
    print("  baseline: RDEMO-1 (5000; A-1/A-2/A-3), RDEMO-2 (3000; B-1/B-2), RDEMO-3 (1000; C-1)")


def clear_demo_proposals(c):
    c.execute("SET search_path TO genie_spike")
    # remove prior non-committed demo proposals so re-seeding is clean (owner can delete)
    c.execute("DELETE FROM committed_idempotency WHERE proposal_id IN "
              "(SELECT proposal_id FROM proposed_changes WHERE task_id=%s AND state<>'committed')", (TASK,))
    c.execute("DELETE FROM proposed_changes WHERE task_id=%s AND state IN ('staged','validated','approved')", (TASK,))


def stage_as_alice(c, remittance_id, allocs):
    """allocs: [{allocation_id, amount, expected_version}] -> stage via the real proc as alice."""
    c.execute("SET search_path TO genie_spike")
    diff = {"remittance_id": remittance_id, "allocations": allocs}
    pid = c.execute("SELECT stage_change(%s,%s,%s,%s::jsonb)",
                    (TASK, CT, CFG, json.dumps(diff))).fetchone()[0]
    return pid


def main():
    with owner_conn() as oc, oc.cursor() as c:
        seed_baseline(c)
        clear_demo_proposals(c)
    with alice_conn() as ac, ac.cursor() as a:
        p_ok = stage_as_alice(a, "RDEMO-2",
                              [{"allocation_id": "B-2", "invoice_id": "INV-2002", "amount": 1150.00,
                                "expected_version": 1}])
        # Over-allocation lives on its OWN remittance (RDEMO-3) so it is independent
        # of the green-commit path -> GA005 fires cleanly (no version collision).
        p_over = stage_as_alice(a, "RDEMO-3",
                                [{"allocation_id": "C-1", "invoice_id": "INV-3001", "amount": 5000.00,
                                  "expected_version": 1}])
    print(f"  staged (as alice) VALID correction : {p_ok}   (RDEMO-2 B-2 -> 1150; Felix approves+commits)")
    print(f"  staged (as alice) OVER-allocation  : {p_over} (RDEMO-3 C-1 -> 5000 on 1000; commit -> GA005)")
    print("SEED_OK")


if __name__ == "__main__":
    main()
