# Hands-on walkthrough — the ingest → write spine

A narrated, runnable console for the safety/determinism core. It calls the **same**
deterministic parser (spike-02) and the **same** guarded stored procs (spike-01) —
no duplicated logic — so what you see is exactly what the serving endpoint will do.
Two-person segregation of duties is **real** here: `alice` and `bob` are distinct
Postgres LOGIN roles, not one notebook identity.

It walks the happy path with a real spreadsheet, then trips every guardrail:

1. deterministic parse of a real `.xlsx` (no LLM in the money path)
2. `alice` **stages** a proposal (`stage_change`)
3. `alice` tries to **self-approve** → `GA003` (segregation of duties)
4. `bob` **approves** (`approve_change`)
5. `alice` **commits** (`commit_change`) → ledger + immutable audit + outbox
6. guardrail gallery: direct DML (`42501`), over-allocation (`GA005`),
   stale version (`GA004`), forged identity (`GA010`), idempotent replay

## Run it (choose a Databricks profile — none is auto-selected)

```bash
cd spikes
source spike-01-lakebase-commit/.venv/bin/activate     # or: python3 -m venv … && pip install psycopg[binary] openpyxl
EP="projects/genie-automations/branches/production/endpoints/primary"

export PGHOST=$(databricks postgres get-endpoint $EP --profile <PROFILE> -o json \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['status']['hosts']['host'])")
export PGOWNER=$(databricks current-user me --profile <PROFILE> -o json \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['userName'])")
export PGOWNER_TOKEN=$(databricks postgres generate-database-credential $EP --profile <PROFILE> -o json \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

# ephemeral caller passwords (alice/bob login roles created by spike-01 deploy):
export ALICE_PW="wt-alice-$(openssl rand -hex 6)"; export BOB_PW="wt-bob-$(openssl rand -hex 6)"
python - <<'PY'  # reset the two caller-role passwords for this session
import os, psycopg
dsn=f"host={os.environ['PGHOST']} user={os.environ['PGOWNER']} password={os.environ['PGOWNER_TOKEN']} dbname=databricks_postgres sslmode=require"
with psycopg.connect(dsn, autocommit=True) as c:
    for r,pw in (("alice",os.environ["ALICE_PW"]),("bob",os.environ["BOB_PW"])):
        c.execute(f"ALTER ROLE {r} LOGIN PASSWORD '{pw}'")
PY

python walkthrough/walkthrough.py                # straight run
python walkthrough/walkthrough.py --interactive  # pause before each step
python walkthrough/walkthrough.py --file <your-own.xlsx>   # drop in your own file
```

> Prereq: the `genie-automations` Lakebase project must have the spike-01 SQL
> deployed (schema + `commit_change` + guarded `stage_change`/`approve_change` +
> grants). See `../spike-01-lakebase-commit/README.md`. This is a synthetic-data
> demo — do not point it at real financial data.

## What you cannot test here yet

The **agentic** experience — natural language → tool routing, the agent's
preview/refuse/approve dialogue, OBO through the supervisor, and the formless
API — needs the **stub supervisor serving endpoint** (not built yet). This
walkthrough drives the same procs the agent will call, so it de-risks everything
*below* the endpoint. The probabilistic image/chat path is exercised separately
by `../spike-02-ingest/image/run_bakeoff.py`.
