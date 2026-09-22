#!/usr/bin/env python3
"""genie-automations — hands-on WALKTHROUGH of the ingest -> write spine.

A narrated, runnable console for the safety/determinism core. It calls the SAME
deterministic parser (spike-02) and the SAME guarded stored procs (spike-01) —
no duplicated logic — so what you see here is exactly what the endpoint will do.

It walks the happy path with a REAL corpus file, then deliberately trips every
guardrail so you can watch each rejection fire by identity:

  1. deterministic parse of a real xlsx (no LLM in the money path)
  2. alice STAGES a proposal (stage_change)         [proposer identity]
  3. alice tries to SELF-APPROVE   -> GA003          [segregation of duties]
  4. bob APPROVES (approve_change)                   [approver identity]
  5. alice COMMITS (commit_change) -> ledger + immutable audit + outbox
  6. guardrail gallery: direct DML (42501), over-allocation (GA005),
     stale version (GA004), forged identity (GA010), idempotent replay

Two-person SoD is REAL here: alice and bob are distinct Postgres LOGIN roles,
not one notebook identity. This is the "feel the co-worker safety model" test.

Env (same as spike-01 harness): PGHOST, PGOWNER, PGOWNER_TOKEN, ALICE_PW, BOB_PW.
Run:  python walkthrough.py [--interactive] [--file <path-to-xlsx>]
"""
from __future__ import annotations
import argparse, hashlib, json, os, pathlib, sys, uuid
import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "spike-02-ingest" / "parser"))
from parse import parse, IngestConfig  # noqa: E402

HOST, DB = os.environ["PGHOST"], "databricks_postgres"
OWNER = f"host={HOST} user={os.environ['PGOWNER']} password={os.environ['PGOWNER_TOKEN']} dbname={DB} sslmode=require"
ALICE = f"host={HOST} user=alice password={os.environ['ALICE_PW']} dbname={DB} sslmode=require"
BOB = f"host={HOST} user=bob password={os.environ['BOB_PW']} dbname={DB} sslmode=require"

CFG = IngestConfig(
    required_columns={
        "remittance_id": ["remittance", "remittance id"],
        "invoice_id": ["invoice", "invoice no", "invoice id"],
        "amount": ["amt", "betrag", "total", "payment amount"],
        "pay_date": ["payment date", "date", "pay date"],
    },
    money_columns={"amount"}, date_columns={"pay_date"},
)
DEFAULT_FILE = ROOT / "spike-02-ingest" / "corpus" / "clean.xlsx"
PAUSE = False


def c(dsn):
    return psycopg.connect(dsn, autocommit=True)


def idem(task, entity, diff):
    return hashlib.sha256(json.dumps([task, entity, diff, "cfg_v1"], sort_keys=True).encode()).hexdigest()


def banner(n, title):
    print(f"\n{'='*72}\n  STEP {n}: {title}\n{'='*72}")
    if PAUSE:
        input("  [Enter to run this step] ")


def expect_reject(fn, code, label):
    try:
        fn()
        print(f"  ✗ {label}: NO exception (expected {code}) — GUARDRAIL FAILED")
        return False
    except psycopg.Error as e:
        ok = e.sqlstate == code
        print(f"  {'✓' if ok else '✗'} {label}: rejected sqlstate={e.sqlstate} "
              f"(expected {code}){'' if ok else ' — MISMATCH'}")
        return ok


def stage(alice, diff):
    return alice.execute("SELECT genie_spike.stage_change('recv-recon','allocation_upsert','cfg_v1',%s)",
                         (json.dumps(diff),)).fetchone()[0]


def seed(owner):
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        for t in ("allocation", "proposed_changes", "committed_idempotency", "audit_event", "outbox"):
            cur.execute(f"DELETE FROM {t}")
        cur.execute("INSERT INTO subsidiary_period(subsidiary_id,period,status) VALUES ('SUB1','2026-Q1','open') "
                    "ON CONFLICT (subsidiary_id,period) DO UPDATE SET status='open'")


def main():
    global PAUSE
    ap = argparse.ArgumentParser()
    ap.add_argument("--interactive", action="store_true", help="pause before each step")
    ap.add_argument("--file", default=str(DEFAULT_FILE))
    args = ap.parse_args()
    PAUSE = args.interactive
    owner, alice, bob = c(OWNER), c(ALICE), c(BOB)
    passed = []

    print("""
  genie-automations — ingest→write spine walkthrough
  identities:  OWNER (schema owner, holds writes behind DEFINER procs)
               alice (proposer role)   bob (approver role)   — real SoD by identity
""")

    # 1 — deterministic parse -------------------------------------------------
    banner(1, "Deterministic parse of a real spreadsheet (NO LLM in the money path)")
    raw = pathlib.Path(args.file).read_bytes()
    res = parse(raw, os.path.basename(args.file), CFG)
    rows = [r.values for r in res.rows]
    print(f"  parsed {len(rows)} canonical rows from {os.path.basename(args.file)} "
          f"(sha256 {res.source_sha256[:12]}…, sheet '{res.sheet}', header row {res.header_row})")
    for r in rows:
        print(f"    - {r['remittance_id']}  {r['invoice_id']}  {r['amount']:>10}  {r.get('pay_date')}")
    # pick the first remittance with >=1 row for the happy path
    target = sorted({r["remittance_id"] for r in rows})[0]
    allocs = [{"allocation_id": f"{target}-{r['invoice_id']}", "invoice_id": r["invoice_id"], "amount": r["amount"]}
              for r in rows if r["remittance_id"] == target]
    total = sum(float(a["amount"]) for a in allocs)
    print(f"  -> will reconcile remittance {target}: {len(allocs)} allocations summing to {total:.2f}")

    # 2 — seed roots + stage --------------------------------------------------
    banner(2, f"alice STAGES a proposal for {target} (stage_change)")
    seed(owner)
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) VALUES (%s,'SUB1','2026-Q1',%s) "
                    "ON CONFLICT (remittance_id) DO UPDATE SET total_amount=EXCLUDED.total_amount", (target, total))
    diff = {"remittance_id": target, "allocations": allocs}
    pid = stage(alice, diff)
    state = owner.execute("SELECT state, proposer_id FROM genie_spike.proposed_changes WHERE proposal_id=%s", (pid,)).fetchone()
    print(f"  ✓ staged proposal {pid}  state={state[0]}  proposer={state[1]} (bound to alice's session_user)")
    passed.append(("stage_change by alice", state[0] == "staged"))

    # 3 — self-approve blocked ------------------------------------------------
    banner(3, "alice tries to APPROVE HER OWN proposal (must be blocked)")
    passed.append(("alice cannot self-approve (GA003)",
                   expect_reject(lambda: alice.execute("SELECT genie_spike.approve_change(%s)", (pid,)),
                                 "GA003", "self-approval")))

    # 4 — bob approves --------------------------------------------------------
    banner(4, "bob APPROVES (approve_change) — a DIFFERENT identity")
    bob.execute("SELECT genie_spike.approve_change(%s)", (pid,))
    st, appr = owner.execute("SELECT state, approver_id FROM genie_spike.proposed_changes WHERE proposal_id=%s", (pid,)).fetchone()
    print(f"  ✓ approved by {appr}  state={st}")
    passed.append(("bob approves (approver != proposer)", st == "approved" and appr == "bob"))

    # 5 — commit + audit ------------------------------------------------------
    banner(5, "alice COMMITS (commit_change) — atomic ledger + immutable audit + outbox")
    out = alice.execute("SELECT genie_spike.commit_change(%s,%s,%s)", (pid, "alice", "user")).fetchone()[0]
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        n_alloc = cur.execute("SELECT count(*) FROM allocation WHERE remittance_id=%s", (target,)).fetchone()[0]
        summ = cur.execute("SELECT COALESCE(SUM(amount),0) FROM allocation WHERE remittance_id=%s", (target,)).fetchone()[0]
        actor, dbp, phash, prev = cur.execute(
            "SELECT actor_id, db_principal, payload_sha256, prev_hash FROM audit_event WHERE proposal_id=%s", (pid,)).fetchone()
        n_out = cur.execute("SELECT count(*) FROM outbox o JOIN proposed_changes p "
                            "ON o.idempotency_key=p.idempotency_key WHERE p.proposal_id=%s", (pid,)).fetchone()[0]
    print(f"  ✓ commit result: {out}")
    print(f"    ledger: {n_alloc} allocations, Σ={summ} (== remittance total {total:.2f})")
    print(f"    audit : actor={actor}  db_principal={dbp}  payload_sha256={phash[:16]}…  prev_hash={(prev or '∅')[:16]}")
    print(f"    outbox: {n_out} row queued for Delta publication")
    passed.append(("commit writes ledger+audit+outbox, actor=alice", n_alloc == len(allocs) and actor == "alice" and n_out == 1))

    # 6 — guardrail gallery ---------------------------------------------------
    banner(6, "Guardrail gallery — watch each abuse case get rejected")

    print("\n  (a) alice tries a DIRECT write to the ledger (bypassing the proc):")
    passed.append(("direct DML denied (42501)", expect_reject(
        lambda: alice.execute("INSERT INTO genie_spike.allocation(allocation_id,remittance_id,invoice_id,amount) "
                              "VALUES ('HACK',%s,'INVX',1)", (target,)), "42501", "direct INSERT")))

    print("\n  (b) over-allocation: stage 60+60 against a remittance whose total is 100:")
    seed(owner)
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) VALUES ('RSMALL','SUB1','2026-Q1',100.00) "
                    "ON CONFLICT (remittance_id) DO UPDATE SET total_amount=100.00")
    p_over = stage(alice, {"remittance_id": "RSMALL", "allocations": [
        {"allocation_id": "RSMALL-1", "invoice_id": "INV1", "amount": 60},
        {"allocation_id": "RSMALL-2", "invoice_id": "INV2", "amount": 60}]})
    bob.execute("SELECT genie_spike.approve_change(%s)", (p_over,))
    ok = expect_reject(lambda: alice.execute("SELECT genie_spike.commit_change(%s,'alice','user')", (p_over,)), "GA005", "over-allocation")
    persisted = owner.execute("SELECT COALESCE(SUM(amount),0) FROM genie_spike.allocation WHERE remittance_id='RSMALL'").fetchone()[0]
    print(f"      nothing persisted (rolled back): Σ RSMALL = {persisted}")
    passed.append(("over-allocation blocked + rolled back (GA005)", ok and persisted == 0))

    print("\n  (c) stale expected_version (someone else moved the row first):")
    seed(owner)
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) VALUES ('RV','SUB1','2026-Q1',100.00) "
                    "ON CONFLICT (remittance_id) DO UPDATE SET total_amount=100.00")
    p1 = stage(alice, {"remittance_id": "RV", "allocations": [{"allocation_id": "RV-1", "invoice_id": "INV1", "amount": 40}]})
    bob.execute("SELECT genie_spike.approve_change(%s)", (p1,)); alice.execute("SELECT genie_spike.commit_change(%s,'alice','user')", (p1,))
    p2 = stage(alice, {"remittance_id": "RV", "allocations": [{"allocation_id": "RV-1", "invoice_id": "INV1", "amount": 50, "expected_version": 999}]})
    bob.execute("SELECT genie_spike.approve_change(%s)", (p2,))
    passed.append(("stale version rejected (GA004)", expect_reject(
        lambda: alice.execute("SELECT genie_spike.commit_change(%s,'alice','user')", (p2,)), "GA004", "stale version")))

    print("\n  (d) forged identity (actor_id != the connected session_user):")
    seed(owner)
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) VALUES ('RF','SUB1','2026-Q1',100.00) "
                    "ON CONFLICT (remittance_id) DO UPDATE SET total_amount=100.00")
    pf = stage(alice, {"remittance_id": "RF", "allocations": [{"allocation_id": "RF-1", "invoice_id": "INV1", "amount": 10}]})
    bob.execute("SELECT genie_spike.approve_change(%s)", (pf,))
    passed.append(("forged identity rejected (GA010)", expect_reject(
        lambda: alice.execute("SELECT genie_spike.commit_change(%s,'mallory','user')", (pf,)), "GA010", "forged actor")))

    print("\n  (e) idempotent replay (network retry / double-click): commit the SAME proposal twice:")
    seed(owner)
    with owner.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) VALUES ('RI','SUB1','2026-Q1',100.00) "
                    "ON CONFLICT (remittance_id) DO UPDATE SET total_amount=100.00")
    pr = stage(alice, {"remittance_id": "RI", "allocations": [{"allocation_id": "RI-1", "invoice_id": "INV1", "amount": 30}]})
    bob.execute("SELECT genie_spike.approve_change(%s)", (pr,))
    r1 = alice.execute("SELECT genie_spike.commit_change(%s,'alice','user')", (pr,)).fetchone()[0]
    r2 = alice.execute("SELECT genie_spike.commit_change(%s,'alice','user')", (pr,)).fetchone()[0]
    n = owner.execute("SELECT count(*) FROM genie_spike.audit_event WHERE proposal_id=%s", (pr,)).fetchone()[0]
    print(f"      two commits -> {n} audit event (single effect), results equal: {r1 == r2}")
    passed.append(("idempotent replay -> single effect", n == 1 and r1 == r2))

    # summary -----------------------------------------------------------------
    owner.close(); alice.close(); bob.close()
    print(f"\n{'='*72}\n  SUMMARY\n{'='*72}")
    for name, ok in passed:
        print(f"  {'✓ PASS' if ok else '✗ FAIL'}  {name}")
    print("""
  Note on the probabilistic path (screenshots/chat): parse.py handles xlsx/csv
  deterministically (shown above). Images/chat go through the ALWAYS-human-confirm
  vision gate — see spike-02-ingest/image/BAKEOFF_RESULTS.md (100% clean-corpus
  accuracy; injected instruction ignored; cross-foot catches a dropped row).
""")
    if not all(ok for _, ok in passed):
        raise SystemExit(1)
    print("  All guardrails held. This is the safety core the agentic co-worker sits on.")


if __name__ == "__main__":
    main()
