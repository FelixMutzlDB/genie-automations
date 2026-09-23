# 11 — UI/UX Spec: a Genie-inspired reconciliation co-worker

> **Ask:** the *real* (productionized) genie-automations app should look and feel like
> the **Databricks Genie** product experience — colors, fonts, layout, chat-centric
> interaction — drawing inspiration from it (not a pixel clone).
>
> **The reframe both partners converged on:** *"look like Genie" is a framework
> decision, not a CSS decision.* The highest-leverage move is to **consume the
> Databricks Design System (DuBois) natively** rather than hand-theme our spike CSS
> to mimic it. Hand-theming a design system you don't consume is a treadmill: it
> looks *almost* right, drifts on every DuBois update, and you pay for every
> component twice. Consuming DuBois makes the app *visually indistinguishable*
> because it's the same components — and it stays current for free.

---

## ADR-006 — Frontend framework: adopt AppKit / DuBois for the production UI  *(Proposed — gated)*

**Status:** Proposed, **gated** on the OBO-in-Node validation below. Do **not** lock
until that micro-test passes and Felix picks the resolution. (Consistent with both
partners: "decide the direction now on the plan — cheap; scaffold at the Arc-2
boundary; lock the ADR only after verifying.")

**Decision (direction):** The productionized UI consumes the Databricks Design
System via **AppKit** (`@databricks/appkit` / `@databricks/appkit-ui`) — the same
React SDK + DuBois tokens + shadcn primitives the Genie product is built on —
rather than the hand-rolled dark-theme FastAPI/CSS of spike-03. AppKit ships a
native **`GenieChat` component + `useGenieChat()` hook**, so the chat surface *is*
Genie's, not a look-alike.

**⚠️ Grounded correction to the partners' shared assumption (the load-bearing fact).**
Both partners *assumed* AppKit could be adopted "frontend-only" while keeping the
proven Python backend, on the logic that OBO is platform-level. The OBO *token*
part of that is true — `x-forwarded-access-token` is injected by Databricks Apps
for **any** framework (the `databricks-apps-python` skill confirms user-auth is GA
and framework-agnostic). **But** the packaging is not a free swap: **AppKit is a
full-stack Node/TypeScript framework** — it brings its own server (`server/server.ts`
with routes like `/api/whoami`, the `genie()` plugin reading
`DATABRICKS_GENIE_SPACE_ID`, the analytics plugin, `useGenieChat` talking to those
Node plugins). A Databricks App deploys a **single** `app.yaml` command, so you
cannot run "AppKit Node frontend + our Python FastAPI backend" as one App without
extra plumbing. The decision is therefore a real fork, not a repaint:

- **Option A — Port the thin backend to the AppKit Node server (recommended).**
  Move the five backend responsibilities into the AppKit Node server: (1) read
  `x-forwarded-access-token`, (2) mint a Lakebase credential *as the caller*,
  (3) open a per-request Postgres connection, (4) run the agent tool-loop, (5) call
  the FM. **The crown-jewel safety boundary — the guarded Postgres stored procs —
  is SQL, language-agnostic, and does NOT change.** All five have direct Node
  equivalents (Databricks SDK for Node, `pg`, OpenAI-compatible `openai` npm). Cost:
  re-implement + **re-prove L0 OBO from Node** before retiring the Python app.
- **Option B — Stay on Python FastAPI, hand-adopt the look.** Serve a React bundle
  from FastAPI using AppKit-**ui** components/shadcn + DuBois tokens, but *without*
  AppKit's Node plugins — so you lose the turnkey `GenieChat`/analytics plumbing and
  hand-wire the Genie chat against our existing `/chat` route. Keeps the proven
  Python OBO path 100% untouched; gets ~80% of the look, not the native Genie
  chat component.

**Gating validation (must pass before locking ADR-006 down Option A):**
Re-prove **`session_user == the real human`** from an AppKit **Node** server on
`fevm-felix-demo` — the Node analogue of the `spike-03/identity_app` micro-test we
already ran in Python (which returned `L0_full_obo`). If Node OBO→Lakebase minting
is clean, Option A is safe and preferred. If it's awkward, fall back to Option B.

**Rationale:** native Genie look/feel; accessibility, light/dark, focus states for
free; no theming treadmill; typed API/SSE contract; far less bespoke CSS to
maintain. **Why decide the direction now (Arc 1):** it's an ADR — cheap on the plan,
**expensive to reverse** in code (scaffolding + framework migration). Deciding early
prevents the spike UI from quietly becoming production and prevents building Arc-2 UI
in the old stack only to rebuild it in Arc 3.

**Consequences:** a typed HTTPS/SSE boundary between client and Agent Server; the
spike HTML/CSS is deprecated (not productionized); a one-time frontend migration;
under Option A, a bounded Node port of the backend with a mandatory OBO re-proof.

**Rejected option:** productionizing the hand-rolled dark-theme spike UI (guarantees
the "almost-right + drifts forever" treadmill).

**Non-negotiable invariant regardless of A/B:** the UI is presentational only. The
**guarded Postgres procs remain the sole mutation boundary**; SoD/invariants/
idempotency/audit hold no matter what the frontend looks like. A prettier Approve
button is still just a call to `approve_change`. The design work *cannot* weaken the
safety model because the safety model isn't in the frontend.

---

## 1. Design principles to borrow from Genie

1. **Chat-first, single primary column.** The conversation is the app; prompt
   composer pinned at the bottom; streamed responses; generous line-height.
2. **Light-default, low-chroma, high-contrast.** Genie is a calm, near-white canvas
   where *data and accents* carry the color, not the chrome. This also reads as more
   trustworthy/enterprise than the spike's dark theme — which matters for a **money**
   surface.
3. **Suggested prompts**, task-scoped: *"Reconcile SUB-014's latest submission,"*
   *"Which subsidiaries are still outstanding?"*
4. **Inline structured results.** Parsed rows, diffs, consolidated positions render
   as inline DuBois tables in the transcript — never raw JSON.
5. **Right-hand context/details rail** — where our Proposals panel lives (we already
   had the correct instinct).
6. **Restraint / low ornamentation** — crisp radii, thin dividers, one accent color,
   whitespace over borders.

### 1b. Where we deliberately DIVERGE from Genie *(non-negotiable)*

**Genie is read-only. This app writes money.** Genie has no concept of a blocked
action, a two-person approval, or a guardrail rejection. We borrow Genie's *calm and
layout* but add a whole vocabulary Genie doesn't have — **state, consequence, and
refusal made visible.** Copying Genie blindly would erase exactly the transparency
that makes this app safe. **Borrow the feel; keep the safety surface.**

---

## 2. Layout — Genie feel, safety surface preserved

Keep the three-zone structure (already right), Genie-ify the styling, harden the
semantics:

```
┌───────────┬─────────────────────────────┬───────────────────────┐
│ Left rail │  Center: CHAT (primary)     │  Right: CONTEXT        │
│ (slim)    │                             │                        │
│ • Tasks / │  • Streamed agent messages  │  ▸ PROPOSALS panel     │
│   auto-   │  • Inline result tables     │    staged → approved   │
│   mations │  • Suggested prompts        │      → committed       │
│ • Runs    │    (task-scoped)            │    - typed diff preview│
│ • Out-    │  • Prompt composer (pinned) │    - source + SHA-256  │
│   standing│    + file-upload affordance │    - confidence, cfg v │
│   subs    │                             │    - [Approve][Commit] │
│           │                             │      (explicit, split) │
│           │                             │  ▸ ACTIVITY (tool log, │
│           │                             │    collapsible)        │
│           │                             │  ▸ Audit / actor_id    │
└───────────┴─────────────────────────────┴───────────────────────┘
Header: Task selector · Period · Freshness · Signed-in identity · Status
```

**Responsive:** desktop = collapsible left rail + dominant chat + persistent right
rail; narrow = left rail → drawer, proposals → slide-over; composer stays pinned.

---

## 3. Component plan (bind to real AppKit primitives)

> Only names exported from `@databricks/appkit` / `@databricks/appkit-ui`. Confirm
> exact signatures with `npx @databricks/appkit docs` at build time.

| Element | AppKit primitive | Token/role | States |
|---|---|---|---|
| Chat surface | **`GenieChat` / `useGenieChat()`** (or our `/chat` SSE under Option B) | `--foreground` / `--muted-foreground` | streaming / error / empty |
| Prompt composer | AppKit input + `Button` | `--primary` | disabled while streaming |
| Suggested prompts | `Button` (ghost) row | `--muted-foreground` | — |
| Inline result table | `Table` | tabular-nums for money | `Skeleton` / `Empty` |
| Proposal card | `Card*` + status `Badge` | `--sem-pending` / `--success` | staged/approved/committed |
| Approve / Commit | two distinct `Button`s | Commit = heaviest, `--primary`; disabled until `approved` | disabled-with-reason |
| Guardrail (GA00x) | `Alert` (inline, in transcript) | **`--destructive`**, high-salience, code visible | first-class message type |
| Activity / tool log | collapsible `Card`/disclosure | `--sem-info` | expand → tool, duration, trace id, cfg v, **sanitized** args |
| Identity badge | `Badge` from `/api/whoami` (`x-forwarded-email`) | `--muted-foreground` | — |
| Post-commit audit chip | `Badge` showing `actor_id = <human>` | `--success` | the OBO payoff, made visible |
| Loading / empty / error | `Skeleton` / `Empty` / `Alert` | — | **every** data view |

### The 5-point Genie AI-trust checklist maps onto our safety surface

Databricks' own Genie-surface trust checklist aligns almost 1:1 with the transparency
we already built — adopt all five:

1. **Identity shown** — `/api/whoami` (`x-forwarded-email`) → `Badge`. We disclose
   **true OBO** (`session_user = human`), which most Genie apps *can't* claim.
2. **Generated SQL / action inspectable** — our **Activity log** already shows the
   tool calls / stored-proc invocations; render them inspectably (never hide how a
   change was computed).
3. **Streaming/status** — reflect real status, never a frozen spinner.
4. **Per-answer AI disclaimer** — persistent "AI-generated — verify" note.
5. **Governance + states** — truthful execution-identity disclosure + `Empty`/`Alert`
   for empty/ambiguous/error.

---

## 4. Safety-visibility non-negotiables *(must survive any future "cleanup")*

- **Proposals panel** shows the typed diff, source lineage (file + SHA-256),
  extraction confidence, config version, proposer — "no blind approval" rendered as
  UI. Financial actions are **never** ordinary chat suggestions.
- **Approve / Commit** stay explicit, separate, deterministic buttons on dedicated
  routes — never a combined step, never a chat "yes." Commit is the heaviest control,
  disabled until `state = approved`.
- **GA00x guardrail messages** render verbatim as high-salience `--destructive`
  inline callouts *in the transcript*, code visible — a feature to showcase, not an
  error to hide, and **never** a transient toast. Stable human copy + preserved code:
  - `GA003` → "Another authorized user must approve this proposal." (SoD)
  - `GA004` → "The underlying record changed. Refresh and review a new proposal."
  - `GA005` → "Blocked: this change would over-allocate the remittance. Nothing was written."
  - `GA010` → "Identity mismatch — the action was rejected."
- **Tool-event / Activity transparency** preserved (collapsible), with **sanitized**
  args/results — never credentials, raw OCR, or untrusted document text.

---

## 5. Reconciliation with the thin-client architecture

Adopting DuBois changes the *frontend layer* and nothing in the trust architecture:

```
AppKit React UI  (rendering, navigation, a11y, explicit button gestures — NO money logic)
        ↓ typed HTTPS/SSE
Agent Server  (forwarded-token → OBO, agent orchestration/streaming, server-issued
              confirmation tokens, typed tool wrappers, authorization)
        ↓ request-scoped OBO (session_user = human)
Guarded Lakebase procs (SOLE mutation boundary) · Genie · UC · FM inference
```

The database remains the sole financial mutation boundary; button visibility is UX,
backend + DB enforcement stay authoritative. (Under Option A the "Agent Server" is
the AppKit Node server; under Option B it stays the Python FastAPI app.)

---

## 6. Required states & data realism

Every data view handles: **loading → `Skeleton`**, **empty → `Empty` + next action**,
**error → inline `Alert`** (never a blank panel), **partial/stale → show what you have
+ freshness note**. Money/results always carry unit + period + provenance (source,
freshness, task/config version, and whether *proposed / approved / committed*).

---

## 7. Where this sits in the Arc 1/2/3 sequence

- **Arc 1 (now): decide, don't build.** Record ADR-006 (this doc), run the Node-OBO
  gating micro-test, finalize the typed API/SSE contract + UI state model. **Hard
  constraint: stop investing in hand-rolled CSS.** Any Arc-1 UI needed for automation
  #2 stays deliberately minimal/disposable.
- **Arc 2 (scaffold here): adopt AppKit when building net-new surfaces.** Arc 2 builds
  new UI anyway (config-governance, chase views) — build those in AppKit *from the
  start*, and migrate the chat/proposals screens onto AppKit in the same scaffold.
  Lowest-waste moment for the switch.
- **Arc 3 (polish here):** final token tuning against live DuBois, micro-interactions,
  streaming feel, empty/loading states, responsive, accessibility/visual/smoke tests,
  then retire the spike CSS.

### Companion plan updates (fold in during Arc 1/2)
- **`12-design-tokens.md`** — the semantic delta layer (this doc's sibling).
- **`05-topology.md`** — rename "UI-only App" → "AppKit client + Agent Server trust
  boundary"; keep no-domain-logic-in-client.
- **`03-harden-security-resilience.md`** — add UI rules: confirmation-token binding,
  CSRF, sanitized activity traces, no credential/raw-document exposure, caller cannot
  override the injected `x-forwarded-access-token`.
- **`04-optimize-...` eval gates** — add UI tests: button-only approve/commit,
  blocked-action rendering, identity display, stale-proposal refresh, streaming
  failure, keyboard nav, responsive layout.
