# Spike-03 PIVOT — supervisor surface is a Databricks App (Agent Server), not a Model Serving endpoint

**Date:** 2026-09-22. **Status:** adopted (both partners concur; decisive).

## Trigger — a documentation finding
While scaffolding the OBO identity micro-test we checked the authoritative Databricks docs:

1. The **Model Serving** "Deploy an agent" doc now states: *"For new use cases, Databricks
   recommends deploying agents on Databricks Apps for full control over agent code, server
   configuration, and deployment workflow."* It has **zero** on-behalf-of-user / OBO content.
2. The **user-authorization (OBO)** mechanism is a **first-class Databricks Apps / Agent
   Server** feature:
   - declare `user_api_scopes` (e.g. `sql`, `genie`, `serving`) + a Lakebase **`database`**
     resource (`CAN_CONNECT_AND_CREATE`);
   - Databricks **downscopes the user's credentials** to those scopes and **forwards the
     user's token to agent code via the `x-forwarded-access-token` header**; the MLflow Agent
     Server stores it per-request.

Betting the identity-bearing write path on `ModelServingUserCredentials()` — de-emphasized,
and whose ability to mint a **Lakebase** credential for the caller is undocumented — would make
an undocumented mechanism load-bearing. We go where the supported, documented mechanism is.

## Decision
- **Supervisor = Databricks App (Agent Server).** The App backend is the trusted **OBO +
  tool-execution boundary** and hosts agent orchestration. Browser UI is a thin client added
  last. **Model Serving demotes to a model-inference dependency** (the FM the agent calls).
- This resolves the earlier **L0/L1 fork in favour of L1** — the App owning the
  identity-bearing commit is now the **primary** architecture, not a fallback.
- It finally answers **"why an app?"**: the App *is* the OBO / token-forwarding surface — the
  only place the human's identity enters — not merely UI.

## "Formless" — reframed, not abandoned
- **Capabilities stay independently addressable** (guarded procs, UC functions, `parse.py`,
  Genie) and are invoked by **jobs on SP identity** (scheduled chase, bulk ingest,
  outbox→Delta publisher) — these **never touch the App**. *This* is where "formless" always
  mattered, and it is preserved. The old hostage-dependency worry is **resolved**: headless
  paths do not depend on an interactive App.
- **The human-facing interactive supervisor lives in the App**, because that is where the
  human's identity enters. We had over-applied "formless" to the human-facing orchestrator.
- Net rule change: **"no logic in the App" → "no *invariant/money* logic in the App."**
  Orchestration + identity legitimately live in the App; **invariants/money stay 100% in the
  procs** (still the sole mutation boundary).

## What carries over UNCHANGED (not surface-specific)
- The **7-tool contract** (`list_tasks`, `ask_data`, `parse_upload`, `get_proposal`,
  `stage_change` [by-reference], `approve_change`, `commit_change`).
- The **refusal set / 12-prompt red-team** (10 refusals + 2 positive controls).
- The **money-path refinement** (LLM selects records, never originates a value; server pulls
  NUMERIC from the parse store) and the **deterministic confirmation tokens** for
  approve/commit.
- The deterministic core: procs own SoD (GA003), stale-version (GA004), over-allocation
  (GA005), forged identity (GA010), commit-requires-approved, sole-mutation-boundary.

## Revised sequencing
0. **Bare-App identity micro-test** (NO LLM) — App with `user_api_scopes` + Lakebase
   `database` resource; middleware reads `x-forwarded-access-token`; mint Lakebase cred as the
   caller; `SELECT session_user, current_user`; return canonical identity only.
1. Full agent in the **same App** (7-tool contract).
2. Two-identity SoD test (Alice stages → Bob approves; two distinct `session_user`s).
3. 12-prompt red-team eval (manual → automated gate).
4. Thin browser UI last.

Independent (SP, no human, App-independent): scheduled chase, bulk ingest, outbox→Delta.

## New Phase-3 controls to bank (from this pivot)
- **`user_api_scopes` minimization** — the downscoped token bounds injection blast radius;
  declare the absolute minimum (Lakebase `database` for the specific resource; `genie`/`sql`
  only if reads truly need OBO). Over-granting scopes is the new way to widen blast radius.
- **Token hygiene:** read the forwarded token **only in trusted middleware**; it must **never**
  enter LLM context, tool args, agent state, logs, exceptions, or MLflow traces; global
  header redaction.
- **Fail-closed on missing/forged token** — no silent fallback to the App SP (that would be
  GA010-class identity laundering under a "trusted" surface). Caller-supplied
  `x-forwarded-access-token` must **not** override the platform-injected value.
- **Request-scoped SDK clients + DB connections** — **never a shared pool** whose
  credential/role can bleed across users; add a **concurrency test for cross-user credential
  leakage** (simultaneous Alice/Bob must never share identity/connection).
- **CSRF protection** on the browser surface, in addition to Databricks auth.
- Tools receive a server-created **`RequestContext`**, never `actor_id`/token parameters.

## #1 verify-by-spike (the fact the whole pivot rests on)
Does the Lakebase **`database` scope + `CAN_CONNECT_AND_CREATE`**, driven by a forwarded user
token, actually make Postgres `session_user` == the **human** — *given that human is
provisioned as a Databricks-identity Postgres LOGIN role* (not native `alice`/`bob`)? Prove in
the bare-App micro-test **before any agent code**. Likeliest silent failure: connects fine but
as a mapped/shared role, so `session_user` isn't the human.

## Open testing-mechanics question (needs confirming before build)
`x-forwarded-access-token` carries the identity of whoever authenticated **to the App**. So the
micro-test must be driven by a real **browser/SSO session** as user A, then user B — a script
with a raw PAT may not reproduce the forwarding. Confirm how the test caller's token gets
populated before relying on a curl-based harness.
