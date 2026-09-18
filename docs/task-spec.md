# Task Spec — the contract

A **Task Spec** is the single declarative unit that defines an automation. Every capability
reads from it. A task *type* is a template; each *instance* is customer-specific (its own
target, validations, and chase list). This is the "add an automation = add a Task Spec" seam.

It generalises the prototype's three files — `process.yml`, `checks_config.yml`, and the
`subsidiary_registry` — into one schema.

## Draft schema (to firm up in P0)

```yaml
task:
  type: receivables               # the reusable template family
  instance: acme_receivables      # customer-specific implementation id
  name: "Receivables collection + reconciliation"
  owner_role: "Group Controlling"

data_contract:
  target: "${catalog}.${schema}.ar_entries"   # where validated records land
  shape:                                        # canonical fields + types
    legal_entity: string
    cut_off_date: date
    balance: decimal(18,2)
    not_due: decimal(18,2)
    overdue: decimal(18,2)
    # aging buckets, action-item fields, …
  key: [legal_entity, cut_off_date, item_no]    # idempotency / upsert key

inputs:                            # which input types this task accepts
  - type: excel
  - type: csv
  - type: chat_text                # rows entered directly in conversation
  - type: image                    # e.g. a screenshot of a table
  header_aliases:                  # spelling drift → canonical field
    legal_entity: ["Legal Entity", "BUKRS", "Company Code"]
    balance: ["balance", "Saldo", "Total"]
    # …

validations:                       # deterministic checks; block gates, warn flags
  - code: C1_ROW_BALANCE
    level: detail
    severity: block
    identity: "balance == not_due + overdue"
    message: "Item {item_no}: balance {balance} != not_due {not_due} + overdue {overdue}."
  # … the full checks_config set

chase:
  registry: "${catalog}.${schema}.chase_registry"   # who owes data + channel + secret refs
  channel_primary: teams
  channel_fallback: email
  escalation:
    rounds_before_escalation: 2
    escalate_to: group_controller
    escalation_after_hours: 24
  tone: "polite, specific, persistent; always name the exact line-item fix"

schedule:
  cut_off_calendar: ["2026-06-30", "2026-07-31", "…"]
  reminder_lead_days: 3
  due_offset_days: 2
  ingest_cron: "0 */2 * * *"
```

## How each capability uses it

- **`ask_data`** — points Genie at `data_contract.target` (and the consolidated views over it).
- **`ingest`** — uses `inputs` + `header_aliases` to parse and canonicalise to `data_contract.shape`.
- **`validate`** — runs `validations` against candidate rows; returns findings with severity.
- **`modify`** — upserts into `data_contract.target` on `data_contract.key`, idempotent + audited.
- **`chase`** — reads `chase.registry`, applies `chase.escalation` + `schedule`, sends on channel.

## Notes

- Task-prefixed table names (`ar_*`, `<type>_*`) keep the multi-task schema clean.
- Status enums as `VARCHAR + CHECK`.
- The oracle (`oracle/`) is the behavioural golden for `validations`: the UC-function
  implementation must diff-match it on the same inputs.
