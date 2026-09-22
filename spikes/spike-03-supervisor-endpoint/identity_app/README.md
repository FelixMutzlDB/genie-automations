# Spike-03 Step 0 — OBO identity micro-test (Databricks App)

**No LLM. No financial tools.** One question: when a real human hits this App via their
browser/SSO session, does the forwarded user token let the App mint a Lakebase credential
**as the caller**, so Postgres `session_user == the human` (**L0**) — or only the App's
service principal (**L1**, which forces a trusted-broker design)? This is the load-bearing
fact the whole App/Agent-Server pivot rests on (see `../PIVOT.md`).

The App exposes `GET /whoami`, which returns, side by side:
`sp_identity` (App SP) · `sp_pg_session_user` (default injected PG creds = L1 baseline) ·
`obo_identity` (who the forwarded token resolves to) · `pg_session_user` (**the answer**) ·
plus a `verdict` (`L0_full_obo` / `L1_*` / `FAIL_CLOSED_no_user_token`).

## Prerequisites (workspace-admin gated — verify before deploy)
1. **User authorization (Public Preview) must be enabled** on the workspace, else the
   `x-forwarded-access-token` header is never populated and the app fail-closes with
   `FAIL_CLOSED_no_user_token`. (Error at deploy if scopes set without it:
   `user token passthrough not enabled`.)
2. **User API scopes** granting the app the right to act for the user against Lakebase —
   set on the app (UI: *Edit app → Authorization*, or `databricks.yml` `user_api_scopes`).
   The exact Lakebase/database scope name is part of what this spike verifies.
3. **The human must have a Databricks-identity Postgres LOGIN role.** `felix.mutzl@databricks.com`
   already does (proven in the walkthrough: `session_user=felix`). Without it the mint
   succeeds but the connection fails / maps to a shared role — the likeliest silent L1.

## Deploy (profile: fevm-felix-demo)
```bash
cd spikes/spike-03-supervisor-endpoint/identity_app
databricks apps create genie-auto-obo-test --profile fevm-felix-demo        # once
databricks sync . /Workspace/Users/felix.mutzl@databricks.com/genie-auto-obo-test \
  --profile fevm-felix-demo
databricks apps deploy genie-auto-obo-test \
  --source-code-path /Workspace/Users/felix.mutzl@databricks.com/genie-auto-obo-test \
  --profile fevm-felix-demo
databricks apps get genie-auto-obo-test --profile fevm-felix-demo -o json    # -> url, RUNNING
```
Then, in a **browser logged in as the human**, open `<app-url>/whoami` and read `verdict`.
`curl` with a PAT will NOT prove OBO — the forwarded token comes from the SSO session.

## Reading the result
- `L0_full_obo` → `session_user == human`. The App can hold the identity-bearing commit; the
  earlier "endpoint now / app later" question collapses cleanly in the App's favour.
- `L1_session_user_is_sp` / `L1_cannot_mint_lakebase_cred_obo` → the App backend becomes a
  trusted identity broker; record the exact error/`mint_method` — that's the real finding.
- `FAIL_CLOSED_no_user_token` → prerequisite (1)/(2) not yet in place; the app correctly
  refuses to fall back to the SP rather than laundering identity.

## Live findings — 2026-09-22 (fevm-felix-demo, deployed & tested)
App deployed and RUNNING at `https://genie-auto-obo-test-7474658643170817.aws.databricksapps.com`.
Probed `/whoami` with a forwarded user token. Empirical results:

- ✅ **OBO identity propagation WORKS.** `obo_identity = felix.mutzl@databricks.com` (the real
  human), cleanly distinct from `sp_identity` (the app SP). The App backend can act as the caller.
- ✅ **Exact Lakebase scope identified:** the forwarded token needs the **`postgres`** user API
  scope to mint a Lakebase credential (error: `required scopes: postgres`). Now granted on the app
  (`effective_user_api_scopes = [iam.access-control:read, iam.current-user:read, postgres]`).
- ⏳ **Final mint → `session_user == human` step needs a real browser SSO session.** A programmatic
  `Authorization: Bearer <cli-token>` call forwards a generic CLI token that does NOT carry the
  app-scoped `postgres` grant, so the mint still returns `PermissionDenied: postgres`. The Apps
  proxy only mints a correctly-scoped forwarded token during the interactive OAuth consent flow.
  **To finish the proof: open `<app-url>/whoami` in a browser logged in as the human and read
  `verdict` — expect `L0_full_obo`** (session_user == felix.mutzl@databricks.com). felix already
  has a matching Postgres LOGIN role (walkthrough), so the last prerequisite is met.
- ⚠️ **This workspace is AWS eu-central-1 (Frankfurt)**, not Azure — the app URL is
  `*.aws.databricksapps.com`. Live DBU consumption here bills at AWS rates; the Azure West Europe
  budget is a separate list-price question (see the turn notes).
- 💡 **Compute bills from creation:** `compute_status=ACTIVE` immediately on `apps create`
  (MEDIUM = 0.5 DBU/hr), before any deploy. Stop when idle.

## Cost note
Running this app is the cheapest possible way to also get a **live DBU-consumption data
point** for the pilot cost estimate (Medium = 0.5 DBU/hr). Stop it when idle:
`databricks apps stop genie-auto-obo-test --profile fevm-felix-demo`.
