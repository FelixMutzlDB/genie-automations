# app — Databricks App

The host surface: a UI + a custom **MCP server** that exposes the capabilities in
`packages/core/capabilities/`. The UI calls the supervisor serving endpoint; the supervisor
reaches the capabilities via the MCP server / UC functions.

Deliberately a thin BFF + UI, not the home of the logic — so the supervisor endpoint stays
reachable on its own and the long-term "formless serving endpoint" is a deletion of the app,
not a rewrite (PLAN.md ADR-003).

Build in P0 (bare UI calling the endpoint with one tool), grow through P2–P3. Load the
`databricks-apps` skill when implementing.
