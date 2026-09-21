# 05 — Revised Topology (Diagram-Spec)

Owner: methodology wrapper. A precise textual spec a diagramming step can
render. Two invariants the diagram must make obvious: **the supervisor endpoint
works with the UI absent**, and **the stored proc is the sole mutation boundary.**

Render left → right:

1. **Users / external callers:** browser user, API client, scheduled Job.
2. **UI-only Databricks App (`genie-automations`):** upload / client / BFF
   only. Lands files in a governed UC Volume and calls the supervisor using the
   user's **OBO** identity. Contains **no** validation, routing, mutation, or
   chase logic.
3. **Unity AI Gateway → supervisor Model Serving endpoint:** authenticates,
   rate-limits, traces, resolves `task_id + config_version`, routes typed
   capabilities.
4. **Read/compute capabilities:** Genie queries governed Delta tables; pure UC
   functions validate and compute diffs; the ingest router selects deterministic
   xlsx/csv or confidence-gated image/text processing.
5. **Lakebase command side:** proposals, approvals, operational state,
   aggregate roots, audit, outbox. **Only the stored procedure can mutate
   financial targets.** It locks roots, revalidates versions/invariants/limits,
   then atomically writes target + audit + outbox.
6. **Jobs:** publish Lakebase outbox/audit to Delta; process bulk ingest;
   execute scheduled chase. **The chase Job runs with its SP identity and works
   when the App and the interactive supervisor are absent.**
7. **Delta / UC:** bronze raw files, canonical history, immutable audit
   projection, consolidation, Genie + dashboards.

**Trust edges** must label **OBO user identity** vs **service-principal
identity**. The supervisor remains callable and useful with **no UI deployed**.

```
                 OBO(user)                         OBO(user)
  Browser ─────▶ App (UI/BFF) ───────▶ AI Gateway ─────▶ Supervisor Serving Endpoint
  API client ───────────────(OBO user)───────────────────▶      │  resolves task_id+config_version
                                                                 │  routes typed capabilities
                                                                 ▼
                                    ┌────────────── Read/Compute ──────────────┐
                                    │  Genie (Delta)   UC funcs (pure)   Ingest │
                                    │                                    router │
                                    └───────────────────┬──────────────────────┘
                                                         │ (staged proposal, typed)
                                                         ▼
                                 ┌──────────── Lakebase (command side) ─────────┐
                                 │ proposed_changes · approvals · roots ·       │
                                 │ audit_event · outbox                         │
                                 │  commit_change() = SOLE mutation boundary    │
                                 └───────────────────┬──────────────────────────┘
                                                     │ outbox (async publish)
   Scheduled Job (SP identity) ──────────────────────┤  (chase Job runs w/ App + supervisor ABSENT)
                                                     ▼
                                 Delta / UC: bronze · history · immutable audit
                                             projection · consolidation · dashboards
```
