#!/usr/bin/env python3
"""Deploy the Spike 1 SQL to Lakebase (no local psql required).

Runs each .sql file as a single libpq simple-query batch (handles DO blocks and
dollar-quoted function bodies that a naive splitter would break). Creates the
restricted per-user login roles. Connects as the OWNER (schema owner) so the
tables + SECURITY DEFINER functions are owned by the write-holding role.

Env: PGHOST, PGDATABASE(=databricks_postgres), PGOWNER, PGOWNER_TOKEN,
     ALICE_PW, BOB_PW, optional PGHOSTADDR.
"""
import os, pathlib, psycopg
from psycopg import pq

HOST = os.environ["PGHOST"]
DB = os.environ.get("PGDATABASE", "databricks_postgres")
ADDR = os.environ.get("PGHOSTADDR")
_a = f"hostaddr={ADDR} " if ADDR else ""
DSN = (f"host={HOST} {_a}user={os.environ['PGOWNER']} password={os.environ['PGOWNER_TOKEN']} "
       f"dbname={DB} sslmode=require")
SQLDIR = pathlib.Path(__file__).resolve().parent.parent / "sql"


def run_batch(conn, text):
    res = conn.pgconn.exec_(text.encode())
    if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
        raise RuntimeError(res.error_message.decode())


def main():
    with psycopg.connect(DSN, autocommit=True) as c:
        for role, pw in (("alice", os.environ["ALICE_PW"]), ("bob", os.environ["BOB_PW"])):
            exists = c.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone()
            # pw is a generated URL-safe token (no quotes) -> safe to inline.
            stmt = "ALTER" if exists else "CREATE"
            c.execute(f"{stmt} ROLE {role} LOGIN PASSWORD '{pw}'")
            print(f"role {role}: {'altered' if exists else 'created'}")
        for f in ("01_schema.sql", "06_vendor_automation.sql", "02_commit_change.sql",
                  "02b_nolock_control.sql", "03_grants.sql", "05_guarded_approval.sql"):
            run_batch(c, (SQLDIR / f).read_text())
            print(f"applied {f}")
    print("DEPLOY_OK")


if __name__ == "__main__":
    main()
