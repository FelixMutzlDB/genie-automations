#!/usr/bin/env python3
"""contention_sweep() — measures the period-lock fork (docs/plan/08) on live Lakebase.

Produces the CURVE across fan-in N for B vs A' (throughput/latency/lock-wait) and
runs the seal-race experiment (deterministic barrier first — A-naive MUST leak,
proving the detector fires — then randomized jitter). The B-vs-A' VERDICT is
deferred to the pilot inputs (ratified commit SLO + realistic single-root fan-in).

Env: PGHOST, PGOWNER, PGOWNER_TOKEN. Optional SWEEP_LEVELS, SWEEP_ROUNDS.
Deploys sql/04_sweep.sql itself (owner). Bench only.
"""
from __future__ import annotations
import os, sys, json, uuid, time, random, statistics, pathlib, threading
import concurrent.futures as cf
import psycopg
from psycopg import pq

DSN = (f"host={os.environ['PGHOST']} user={os.environ['PGOWNER']} "
       f"password={os.environ['PGOWNER_TOKEN']} dbname=databricks_postgres sslmode=require")
SQL04 = pathlib.Path(__file__).resolve().parent.parent / "sql" / "04_sweep.sql"
LEVELS = [int(x) for x in os.environ.get("SWEEP_LEVELS", "1,5,20,50").split(",")]
ROUNDS = int(os.environ.get("SWEEP_ROUNDS", "4"))
SUB, PER = "SUBS", "2026-Q1"


def conn():
    return psycopg.connect(DSN, autocommit=True)


def pct(xs, p):
    if not xs:
        return 0.0
    xs = sorted(xs)
    k = max(0, min(len(xs) - 1, int(round((p / 100.0) * (len(xs) - 1)))))
    return xs[k]


def deploy(c):
    res = c.pgconn.exec_(SQL04.read_text().encode())
    if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
        raise RuntimeError(res.error_message.decode())


def reset(c, n_rem):
    with c.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        for t in ("allocation", "proposed_changes", "committed_idempotency", "audit_event", "outbox", "seal_log"):
            cur.execute(f"DELETE FROM {t}")
        cur.execute("INSERT INTO subsidiary_period(subsidiary_id,period,status,generation) VALUES (%s,%s,'open',0) "
                    "ON CONFLICT (subsidiary_id,period) DO UPDATE SET status='open', generation=0", (SUB, PER))
        for i in range(n_rem):
            cur.execute("INSERT INTO remittance(remittance_id,subsidiary_id,period,total_amount) "
                        "VALUES (%s,%s,%s,1000000000.00) ON CONFLICT (remittance_id) DO UPDATE SET total_amount=1000000000.00",
                        (f"R{i}", SUB, PER))


def stage(c, pid, rem, alloc):
    diff = {"remittance_id": rem, "allocations": [{"allocation_id": alloc, "invoice_id": alloc, "amount": "1.00"}]}
    with c.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("INSERT INTO proposed_changes(proposal_id,task_id,change_type,config_version_hash,state,"
                    "proposer_id,approver_id,diff,idempotency_key) VALUES (%s,'t','allocation_upsert','v','approved',"
                    "'p','a',%s,%s)", (pid, json.dumps(diff), uuid.uuid4().hex))


# ---- throughput / latency sweep -------------------------------------------
def sweep_variant(variant):
    print(f"\n[{variant}]  N   commits  p50ms   p95ms   p99ms   lockwait_ms(mean)  commits/s  errors")
    rows = []
    for n in LEVELS:
        durs, waits, errors, ok = [], [], 0, 0
        for _ in range(ROUNDS):
            with conn() as c:
                reset(c, n)
                pids = [f"p{i}-{uuid.uuid4().hex[:6]}" for i in range(n)]
                for i, pid in enumerate(pids):
                    stage(c, pid, f"R{i}", f"A{i}-{pid}")
            barrier = threading.Barrier(n)

            def one(pid):
                with conn() as cc:
                    barrier.wait()
                    t = time.perf_counter()
                    try:
                        r = cc.execute("SELECT genie_spike.sweep_commit(%s,%s,%s)", (pid, "SP:bench", variant)).fetchone()[0]
                        return (time.perf_counter() - t) * 1000.0, r["lock_wait_ms"], None
                    except psycopg.Error as e:
                        return (time.perf_counter() - t) * 1000.0, None, e.sqlstate

            t0 = time.perf_counter()
            with cf.ThreadPoolExecutor(max_workers=n) as ex:
                for d, w, err in ex.map(one, pids):
                    durs.append(d)
                    if err:
                        errors += 1
                    else:
                        ok += 1
                        if w is not None:
                            waits.append(w)
            wall = time.perf_counter() - t0
        cps = ok / wall if wall else 0.0
        mw = statistics.mean(waits) if waits else 0.0
        print(f"       {n:>3} {ok:>8} {pct(durs,50):>7.1f} {pct(durs,95):>7.1f} {pct(durs,99):>7.1f} "
              f"{mw:>17.2f} {cps:>10.1f} {errors:>6}")
        rows.append((variant, n, pct(durs, 99), mw, cps, errors))
    return rows


# ---- seal-race experiment --------------------------------------------------
def seal_race(variant, barrier_sec=0.4, seal_after=0.12):
    """One commit races one seal. Returns True if a seal-MISS occurred."""
    with conn() as c:
        reset(c, 1)
    pid = f"race-{uuid.uuid4().hex[:6]}"
    with conn() as c:
        stage(c, pid, "R0", f"AX-{pid}")
    result = {}

    def committer():
        with conn() as cc:
            try:
                cc.execute("SELECT genie_spike.sweep_commit(%s,%s,%s,%s)", (pid, "SP:bench", variant, barrier_sec))
                result["commit"] = "ok"
            except psycopg.Error as e:
                result["commit"] = e.sqlstate

    th = threading.Thread(target=committer); th.start()
    time.sleep(seal_after)
    with conn() as c:
        c.execute("SET search_path TO genie_spike")
        c.execute("SELECT genie_spike.seal_period(%s,%s)", (SUB, PER))
    th.join()
    with conn() as c, c.cursor() as cur:
        cur.execute("SET search_path TO genie_spike")
        cur.execute("SELECT COALESCE(SUM(amount),0) FROM allocation WHERE remittance_id='R0'")
        cur_sum = float(cur.fetchone()[0])
        cur.execute("SELECT sealed_sum FROM seal_log ORDER BY id DESC LIMIT 1")
        sealed = float(cur.fetchone()[0])
    # MISS = the commit succeeded but its allocation is absent from the sealed sum
    return result.get("commit") == "ok" and cur_sum > sealed


def main():
    with conn() as c:
        deploy(c)
        c.execute("SELECT 1")  # warm
    print(f"=== throughput/latency sweep (levels={LEVELS}, rounds={ROUNDS}) ===")
    for v in ("B", "APRIME"):
        sweep_variant(v)

    print("\n=== seal-race: DETERMINISTIC barrier (detector validation) ===")
    det = {}
    for v in ("ANAIVE", "B", "APRIME"):
        misses = sum(seal_race(v) for _ in range(4))
        det[v] = misses
        print(f"  {v:<7} misses={misses}/4  (ANAIVE must be >0; B/APRIME must be 0)")
    detector_ok = det["ANAIVE"] > 0 and det["B"] == 0 and det["APRIME"] == 0

    print("\n=== seal-race: randomized jitter ===")
    K = int(os.environ.get("SWEEP_RACES", "40"))
    for v in ("B", "APRIME"):
        m = sum(seal_race(v, barrier_sec=random.uniform(0.05, 0.3), seal_after=random.uniform(0.0, 0.3)) for _ in range(K))
        print(f"  {v:<7} misses={m}/{K}")

    print(f"\ndetector validated (A-naive leaks, B/A' clean): {detector_ok}")
    if not detector_ok:
        raise SystemExit(1)
    print("Sweep complete. B-vs-A' verdict deferred to ratified SLO + pilot fan-in (docs/plan/08).")


if __name__ == "__main__":
    main()
