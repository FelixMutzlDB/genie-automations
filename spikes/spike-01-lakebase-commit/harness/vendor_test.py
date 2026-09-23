#!/usr/bin/env python3
"""Automation #2 — vendor bank-detail governance test harness.

Proves the generalized commit engine handles a MATERIALLY DIFFERENT automation
type (no aggregate invariant; algorithmic/referential/uniqueness validation)
through the SAME shared guardrails (guarded stage/approve, SoD, idempotency,
audit). Drives the guarded procs as two distinct native logins (alice=proposer,
bob=approver) so SoD is real, not simulated.

Env: PGHOST, PGOWNER, PGOWNER_TOKEN, ALICE_PW, BOB_PW  (same as run_spike.py).
"""
import os, json, psycopg

HOST, DB = os.environ["PGHOST"], "databricks_postgres"
OWNER = f"host={HOST} user={os.environ['PGOWNER']} password={os.environ['PGOWNER_TOKEN']} dbname={DB} sslmode=require"
ALICE = f"host={HOST} user=alice password={os.environ['ALICE_PW']} dbname={DB} sslmode=require"
BOB   = f"host={HOST} user=bob password={os.environ['BOB_PW']} dbname={DB} sslmode=require"

TASK = "vendor-bank-eu"
CFG  = "cfghash-vendor-v1"
VALID_GB = "GB82WEST12345698765432"           # valid (MOD-97)
VEND1001_IBAN = "DE89370400440532013000"      # seeded current IBAN for VEND-1001
BAD_IBAN = "DE89370400440532013001"           # last digit altered -> fails checksum


def stage(dsn, diff):
    with psycopg.connect(dsn, autocommit=True) as c:
        return c.execute("SELECT genie_spike.stage_change(%s,%s,%s,%s::jsonb)",
                         (TASK, "vendor_bank_update", CFG, json.dumps(diff))).fetchone()[0]

def approve(dsn, pid):
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("SELECT genie_spike.approve_change(%s)", (pid,))

def commit_as(dsn, pid, actor):
    with psycopg.connect(dsn, autocommit=True) as c:
        return c.execute("SELECT genie_spike.commit_change(%s,%s,'user')", (pid, actor)).fetchone()[0]

def sqlstate(fn):
    try:
        return None, fn()
    except psycopg.Error as e:
        return e.sqlstate, None

def current_iban(vendor):
    with psycopg.connect(OWNER, autocommit=True) as c:
        r = c.execute("SELECT iban, entity_version FROM genie_spike.vendor_bank_detail "
                      "WHERE vendor_id=%s AND is_current", (vendor,)).fetchone()
        return r

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail)); 

# T1 — valid new bank detail for VEND-1002 (no prior current row) -----------
pid = stage(ALICE, {"vendor_id": "VEND-1002", "new_iban": VALID_GB,
                    "new_bic": "WESTGB2LXXX", "effective_date": "2027-01-01"})
approve(BOB, pid)
st, res = sqlstate(lambda: commit_as(ALICE, pid, "alice"))
cur = current_iban("VEND-1002")
check("T1 valid vendor_bank_update commits", st is None and cur and cur[0] == VALID_GB,
      f"sqlstate={st} current={cur}")

# audit attribution for T1
with psycopg.connect(OWNER, autocommit=True) as c:
    a = c.execute("SELECT actor_id, change_type FROM genie_spike.audit_event WHERE proposal_id=%s", (pid,)).fetchone()
check("T1 audit: actor=alice, change_type=vendor_bank_update",
      a and a[0] == "alice" and a[1] == "vendor_bank_update", f"audit={a}")

# T2 — bad IBAN checksum -> GA012 -------------------------------------------
pid = stage(ALICE, {"vendor_id": "VEND-1003", "new_iban": BAD_IBAN,
                    "new_bic": "COBADEFFXXX", "effective_date": "2027-01-01"})
approve(BOB, pid)
st, _ = sqlstate(lambda: commit_as(ALICE, pid, "alice"))
check("T2 bad IBAN rejected (GA012)", st == "GA012" and current_iban("VEND-1003") is None,
      f"sqlstate={st}")

# T3 — IBAN collision: assign VEND-1001's current IBAN to VEND-1002 -> GA013 -
#     (VEND-1002 now has a current row from T1 -> supply expected_version)
v2 = current_iban("VEND-1002")
pid = stage(ALICE, {"vendor_id": "VEND-1002", "new_iban": VEND1001_IBAN,
                    "new_bic": "COBADEFFXXX", "effective_date": "2027-02-01",
                    "expected_version": v2[1]})
approve(BOB, pid)
st, _ = sqlstate(lambda: commit_as(ALICE, pid, "alice"))
check("T3 IBAN collision rejected (GA013)", st == "GA013" and current_iban("VEND-1002")[0] == VALID_GB,
      f"sqlstate={st} (VEND-1002 unchanged)")

# T4 — self-approve on a vendor proposal -> GA003 (SoD holds for new type) ---
pid = stage(ALICE, {"vendor_id": "VEND-1003", "new_iban": VALID_GB.replace("82", "82"),
                    "new_bic": "WESTGB2LXXX", "effective_date": "2027-03-01"})
st, _ = sqlstate(lambda: approve(ALICE, pid))
check("T4 self-approve blocked (GA003)", st == "GA003", f"sqlstate={st}")

# T5 — stale expected_version on VEND-1001 update -> GA004 -------------------
pid = stage(ALICE, {"vendor_id": "VEND-1001", "new_iban": VALID_GB,
                    "new_bic": "WESTGB2LXXX", "effective_date": "2027-04-01",
                    "expected_version": 99})
approve(BOB, pid)
st, _ = sqlstate(lambda: commit_as(ALICE, pid, "alice"))
check("T5 stale version rejected (GA004)", st == "GA004", f"sqlstate={st}")

print(f"{'CHECK':<52}{'RESULT':<8}DETAIL")
allok = True
for name, ok, detail in results:
    allok = allok and ok
    print(f"{name:<52}{'PASS' if ok else 'FAIL':<8}{detail}")
print("\n" + ("All vendor checks PASS (automation #2 on the generalized engine)." if allok else "SOME CHECKS FAILED."))
