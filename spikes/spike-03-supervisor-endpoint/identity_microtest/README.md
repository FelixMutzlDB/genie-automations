# Step 0 — OBO identity micro-test (NO LLM)

**This is the feasibility gate for the whole agentic-write path.** Build & prove this
*before* the agent. It answers one empirical question: inside a Model Serving endpoint, does
`ModelServingUserCredentials()` let us mint a **Lakebase** credential for the **caller** so
Postgres `session_user` == the calling human (**L0**) — or only the endpoint's service
principal (**L1**, forcing a trusted-broker / App-BFF commit leg)?

`probe_model.py` reports `sp_identity`, `obo_identity`, `pg_session_user` side by side and a
`verdict` (`L0_full_obo` / `L1_session_user_is_sp` / `L1_cannot_mint_lakebase_cred_obo`).

## Prereqs
- Profile: `fevm-felix-demo` (pass `--profile` explicitly).
- The `genie-automations` Lakebase project (autoscaling) from spike-01 — need its
  **endpoint resource path** and **host**:
  ```bash
  databricks postgres list-projects --profile fevm-felix-demo
  databricks postgres list-branches projects/<PID> --profile fevm-felix-demo
  databricks postgres list-endpoints projects/<PID>/branches/<BID> --profile fevm-felix-demo
  databricks postgres get-endpoint projects/<PID>/branches/<BID>/endpoints/<EID> --profile fevm-felix-demo -o json
  ```
- The **caller's** Databricks identity must have a matching Postgres **LOGIN role** in the
  branch (e.g. `CREATE ROLE "felix.mutzl@databricks.com" LOGIN;` + schema/table grants).
  For the SoD dimension a **second** real principal needs the same. (Native `alice`/`bob`
  logins from spike-01 prove the *procs*, not OBO — OBO needs real Databricks identities.)

## Deploy (job-based async — see databricks-model-serving/7-deployment.md)
1. `log_model.py` logs `OboIdentityProbe` with `pip_requirements=[psycopg[binary], databricks-sdk>=0.81.0]`.
2. Register to `felix_demo_catalog.genie-automations.obo_probe`.
3. Deploy with `agents.deploy(...)` **with on-behalf-of-user auth enabled** and the Lakebase
   host/endpoint as env vars (`LAKEBASE_HOST`, `LAKEBASE_ENDPOINT`).

## Invoke (the actual test)
Invoke the endpoint **with a user's U2M OAuth token in `Authorization`** (NOT an SP token):
```bash
curl -s -H "Authorization: Bearer $USER_OAUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"inputs":[{"probe":"identity"}]}' \
  https://<workspace>/serving-endpoints/obo-identity-probe/invocations | jq
```
Repeat with a **second** user's token for the SoD/two-`session_user` dimension.

## Acceptance
- Caller A token → `pg_session_user` == A. Caller B token → == B.
- Forged identity in the body → ignored (identity derives only from the token).
- Broken/absent delegation → **fail-closed** (surfaced as `pg_error`, never silently the SP).

## Decision rule
- `verdict == L0_full_obo` → **L0**: commit can live in the endpoint; App comes last.
- any `L1_*` → **L1**: keep the endpoint for reason/parse/stage/preview + reads; move the
  identity-bearing **commit** to a trusted broker / App-BFF. Record the exact error verbatim.
- **Never** resolve L1 by trusting a caller-supplied `actor_id` (reopens GA010).
