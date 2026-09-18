# oracle — behavioural golden

A dependency-free, on-laptop implementation of a task's validations (ingest → normalise →
checks), ported from the prototype's `scripts/demo_local.py`. It is the **reference
implementation**: the UC-function `validate` capability must reproduce its findings and
statuses on the same inputs (allow ordering differences only).

Keeping the golden runnable without a warehouse means a rule change can be validated on a
laptop before it ships, and regressions in the deployed engine are caught by diffing against
it in CI.

> Synthetic inputs only in this public repo.
