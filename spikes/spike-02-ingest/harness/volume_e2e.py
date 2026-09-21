#!/usr/bin/env python3
"""Spike 2 live end-to-end: governed Volume -> deterministic parse -> Spike 1 commit.

Proves the whole untrusted-ingest -> governed-write loop on live infra:
  1. (shell) upload a corpus file to /Volumes/.../raw_uploads/ and download it back
  2. parse the DOWNLOADED-FROM-VOLUME bytes with the deterministic parser
  3. seed reconciliation roots on the live Lakebase (owner)
  4. stage an approved proposal from the parsed canonical rows
  5. commit_change via the SP/batch ingest identity (actor_type='service_principal')
  6. verify the audit row landed

This represents the BULK/SCHEDULED ingest Job path (SP identity), which is a
legitimate path in the plan (05 topology). The interactive OBO path is Spike 1's
per-user check. Env: PGHOST, PGOWNER, PGOWNER_TOKEN; argv[1] = local file path.
"""
from __future__ import annotations
import os, sys, json, uuid, hashlib, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "parser"))
from parse import parse, IngestConfig   # noqa: E402
import psycopg  # noqa: E402

CFG = IngestConfig(
    required_columns={
        "remittance_id": ["remittance", "remittance id"],
        "invoice_id": ["invoice", "invoice no", "invoice id"],
        "amount": ["amt", "betrag", "total", "payment amount"],
        "pay_date": ["payment date", "date", "pay date"],
    },
    money_columns={"amount"}, date_columns={"pay_date"},
)
DSN = (f"host={os.environ['PGHOST']} user={os.environ['PGOWNER']} "
       f"password={os.environ['PGOWNER_TOKEN']} dbname=databricks_postgres sslmode=require")


def idem_key(task, entity, diff):
    return hashlib.sha256(json.dumps([task, entity, diff, "cfg_v1"], sort_keys=True).encode()).hexdigest()


def main():
    path = sys.argv[1]
    raw = pathlib.Path(path).read_bytes()
    res = parse(raw, os.path.basename(path), CFG)
    rows = [r.values for r in res.rows]
    print(f"parsed {len(rows)} rows from VOLUME file {os.path.basename(path)} "
          f"(sha256 {res.source_sha256[:12]}…)")

    with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        # clean slate for a deterministic demo
        for t in ("allocation", "proposed_changes", "committed_idempotency", "audit_event", "outbox"):
            cur.execute(f"DELETE FROM {t}")
        cur.execute("INSERT INTO subsidiary_period(subsidiary_id, period, status) VALUES ('SUBX','2026-Q1','open') "
                    "ON CONFLICT (subsidiary_id, period) DO UPDATE SET status='open'")
        rem_ids = sorted({r["remittance_id"] for r in rows})
        for rid in rem_ids:
            cur.execute("INSERT INTO remittance(remittance_id, subsidiary_id, period, total_amount) "
                        "VALUES (%s,'SUBX','2026-Q1', 1000000.00) "
                        "ON CONFLICT (remittance_id) DO UPDATE SET total_amount=1000000.00", (rid,))
        committed = 0
        for rid in rem_ids:
            allocs = [{"allocation_id": f"{rid}-{r['invoice_id']}", "invoice_id": r["invoice_id"],
                       "amount": r["amount"]} for r in rows if r["remittance_id"] == rid]
            diff = {"remittance_id": rid, "allocations": allocs}
            pid = f"vol-{uuid.uuid4().hex[:8]}"
            cur.execute(
                "INSERT INTO proposed_changes(proposal_id, task_id, change_type, config_version_hash, "
                "state, proposer_id, approver_id, diff, idempotency_key) "
                "VALUES (%s,'recv-recon','allocation_upsert','cfg_v1','approved','ingest-job','approver-bot',%s,%s)",
                (pid, json.dumps(diff), idem_key("recv-recon", rid, diff)))
            out = cur.execute("SELECT genie_spike.commit_change(%s,%s,%s)",
                              (pid, "SP:batch:volume-e2e", "service_principal")).fetchone()[0]
            print(f"  committed {rid}: {out}")
            committed += 1
        n_audit = cur.execute("SELECT count(*) FROM audit_event WHERE actor_type='service_principal'").fetchone()[0]
        n_alloc = cur.execute("SELECT count(*) FROM allocation").fetchone()[0]
        print(f"E2E OK: {committed} proposals committed, {n_alloc} allocations written, {n_audit} SP audit rows")
        assert n_audit == committed, "audit rows != commits"


if __name__ == "__main__":
    main()
