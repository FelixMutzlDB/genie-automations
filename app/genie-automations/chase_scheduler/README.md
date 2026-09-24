# Chase scheduler (Part B)

This hourly Job evaluates enabled receivables chase schedules and writes reminders to
`genie_spike.chase_delivery` with `status='pending'`. `NoOpTransport` is the only
adapter in this PR: it performs zero external calls and leaves every delivery pending.

Each approach or post-due offset can produce at most one row for an item and due date.
The database enforces this with the unique key `(task_id, item_reference, due_at,
offset_kind, offset_days)`, so retries and later hourly evaluations cannot double-fire
the same offset crossing.

## Provisioning

Create a dedicated Databricks service principal and pass its application ID as
`--var chase_scheduler_sp=<application-id>`. Create/map its Lakebase role, then run
`migrations/004_chase_scheduler.sql` with `scheduler_role` set to that role and
`admin_role` set to the existing deployment administrator. The scheduler role receives
only schema usage (from the existing deployment baseline) and `EXECUTE` on the five
scheduler definer functions; do not grant it table DML.

Sending remains disabled. A follow-up PR must provision an approved transport
credential/secret and delivery destination, implement a new `Transport` adapter, and
expand the outbox status model only after the infrastructure decision is approved.
