# tasks/receivables — automation #1

Group receivables collection + reconciliation across many subsidiaries. The reference
automation and the proof that the framework works. Ported from the pipeline-first prototype in
the sibling `group-reconciliation-automation` project.

To migrate in (P0):

- `spec.yaml` — the Task Spec (from the prototype's `process.yml` + `checks_config.yml`).
- `schema/` — target DDL + a synthetic `*_example.csv` (synthetic entities only; no real data).
- `registry/` — the chase registry seed (synthetic subsidiaries + channel refs).

The reconciliation checks are the behavioural contract; the golden implementation lives in
`../../oracle/`. The UC-function `validate` capability must diff-match the oracle on the same
inputs.

> Public repo: synthetic entity names only.
