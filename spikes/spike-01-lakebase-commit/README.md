# Spike 1 — serving-endpoint → Lakebase stored-proc atomic commit

Proves the commit contract (`../../docs/plan/01-mutation-contract.md`) against a
live Lakebase, and **measures** the contention that decides the period-lock
fork. Full spec: [`../../docs/plan/06-spike-specs.md`](../../docs/plan/06-spike-specs.md).

> **Hardened after the partner code review.** The proc is now `SECURITY DEFINER`
> with a pinned `search_path`; custom errors use a private `GA###` SQLSTATE
> class; identity is bound to `session_user`; the harness asserts exact
> SQLSTATEs and includes a **negative control** proving the concurrency test can
> actually detect a broken lock.

## What this scaffold contains

| File | Purpose |
|---|---|
| `sql/01_schema.sql` | roots (remittance, subsidiary_period+generation), allocation children, proposal state machine, nullable-result idempotency claim table, audit (payload hash + `prev_hash` laid down, `db_principal=session_user`), outbox, recon_findings |
| `sql/02_commit_change.sql` | the `commit_change` proc — `SECURITY DEFINER`, `search_path` pinned, identity-bound, idempotency-claim-first, root lock, ownership + mandatory version check, invariant recompute, period-open gate, atomic audit+outbox |
| `sql/02b_nolock_control.sql` | **test-control only** — `commit_change_nolock` (lock removed) for the negative control. Never deploy to prod. |
| `sql/03_grants.sql` | least-privilege: caller roles get `EXECUTE` + staging only, no direct financial DML |
| `harness/run_spike.py` | 10 checks (identity ok/forge, boundary, replay, over-alloc, SoD ×2, stale version, concurrency, negative control); stub for the contention sweep |
| `.env.example` | connection vars for the two identities (no secrets committed) |

## Identity model this spike SELECTS (open decision #3)

**Per-user role.** The caller logs in as its OWN Postgres role, so `session_user`
is preserved *through* the `SECURITY DEFINER` boundary; `commit_change` enforces
`p_actor_id == session_user` for `actor_type='user'` and rejects a forged actor
(`GA010`). `db_principal` records `session_user` (NOT `current_user` — inside a
definer function that is the definer). The batch/scheduled-chase path uses
`actor_type='service_principal'` (connects as an SP role, `actor_id='SP:batch:<job>'`,
equality check skipped). **Fallback** if per-user login is impractical on
Lakebase: SP connection + endpoint-attested `actor_id`, verified in the
serving-endpoint spike.

## Run it (choose a Databricks profile — none is auto-selected)

```bash
# 0. profile + a throwaway project/branch (see databricks-lakebase skill)
EP=projects/<PROJECT_ID>/branches/<BRANCH_ID>/endpoints/<ENDPOINT_ID>

# 1. OWNER connection values
export PGHOST=$(databricks postgres get-endpoint $EP --profile <PROFILE> -o json \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['status']['hosts']['host'])")
export PGOWNER=<your-databricks-username>          # token maps to this role
export PGOWNER_TOKEN=$(databricks postgres generate-database-credential $EP --profile <PROFILE> -o json \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

# 2. create the owner + restricted caller roles (native login) as the owner:
PGPASSWORD="$PGOWNER_TOKEN" psql "host=$PGHOST user=$PGOWNER dbname=databricks_postgres sslmode=require" <<'SQL'
  CREATE ROLE alice LOGIN PASSWORD 'spike-alice-pw';
  CREATE ROLE bob   LOGIN PASSWORD 'spike-bob-pw';
SQL
export PGCALLER=alice PGCALLER_PW='spike-alice-pw'

# 3. apply schema + procs + grants AS THE OWNER (so the owner owns the DEFINER proc)
for f in sql/01_schema.sql sql/02_commit_change.sql sql/02b_nolock_control.sql sql/03_grants.sql; do
  PGPASSWORD="$PGOWNER_TOKEN" psql "host=$PGHOST user=$PGOWNER dbname=databricks_postgres sslmode=require" -v ON_ERROR_STOP=1 -f "$f"
done

# 4. run the harness
python3 -m venv .venv && . .venv/bin/activate && pip install -r harness/requirements.txt
python harness/run_spike.py
```

> **Native login note:** creating LOGIN roles with passwords requires the
> project to allow PG native login (`enable_pg_native_login`). If your Lakebase
> project has it disabled, either enable it or map `alice`/`bob` to Databricks
> identities and connect with per-user OAuth tokens instead (same session_user
> semantics).

## Exit criteria (measurable)

- identity: actor==session_user==caller (≠ owner) 100%; forged actor rejected (GA010)
- boundary: restricted caller cannot write financial state directly (42501)
- replay effect count = 1; idempotency race safe
- over-allocation blocked (GA005), nothing persists
- SoD: null approver AND proposer==approver both rejected (GA003)
- stale expected_version rejected (GA004)
- concurrency (locked): Σ never exceeds total
- **negative control (no lock): leak detected** — proves the test discriminates
- **seal-miss = 0** for remittance-only+generation-gate (contention sweep)
- kill-mid-txn: zero partial commits (TODO)

## Forces a design change if

OBO/per-user login can't propagate (→ scoped SP + endpoint-attested actor); any
partial commit (→ commit fully in Postgres); negative control does NOT leak (→
the concurrency test is invalid, fix it before trusting the locked result);
seal-miss > 0 (→ lock-both fallback); lock-both p99 > ratified budget AND
remittance-only unsafe (→ async seal with explicit period-freeze).

## Still TODO in the harness (kept honest, not hidden)

- `contention_sweep()` — parametrize proc for lock-both vs remittance-only+gate;
  record p50/p95/p99 lock-wait + txn-duration + seal-miss at 1/5/20/50 concurrency.
- kill-connection-mid-txn atomicity check.
- wire the actual serving endpoint in front of the proc (databricks-model-serving)
  to prove OBO end-to-end rather than via a direct psql connection.
- guarded staging/approval procedures (callers must not set `state='approved'`
  directly — GPT loose-grant finding; deferred for the spike).
