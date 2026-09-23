# 12 — Design tokens (semantic delta layer)

> **Principle: consume DuBois, don't redefine it.** If we adopt AppKit (ADR-006), the
> base palette, typography, accent, focus rings, and elevation come **from the
> DuBois theme** — re-declaring their hex values is the anti-pattern that guarantees
> drift. This doc is intentionally **small**: it specifies only the *semantic layer*
> our app needs and Genie doesn't, plus a list of values that must be pulled from the
> live source rather than guessed.
>
> **Hard rule (from the Databricks app-design guidance): no locally invented hex when
> a semantic AppKit/DuBois token exists.** Raw hex *and* raw Tailwind utilities
> (`bg-amber-100`, `text-emerald-600`, …) both bypass the tokens and break dark mode.

---

## A. Inherited from DuBois — consume, do NOT define here

Base surfaces · primary/secondary text · primary accent (Databricks interactive
color) · font family + type ramp · focus rings · elevation/shadows · radius scale ·
light/dark pairs. Map intent to the DuBois semantic roles:

| Intent | DuBois semantic token |
|---|---|
| good / up-is-good / committed OK | `--success` |
| bad / blocked / breach | `--destructive` |
| caution / review-required | `--warning` |
| primary text / actual series | `--foreground` |
| secondary text / comparison | `--muted-foreground` |
| brand / interactive / primary action | `--primary` |
| chart series | the chart `colorPalette` prop (categorical / sequential / diverging) |

## B. ⚠️ Pull from the live source — never guess

Get these from the AppKit/DuBois theme object (best), `npx @databricks/appkit docs`
(the "appkit-ui API reference" + design-token sections), or by extracting computed
styles from the live Genie product. **Do not ship placeholder hex as truth.**

- Exact background / surface / border hex + their dark-mode pairs
- Primary accent hex + hover/active states
- Font family (Databricks uses a specific stack — do **not** assume `system-ui`)
- The exact type ramp (sizes/weights/line-heights)
- Focus-ring spec, elevation/shadow values, motion timings

## C. Tokens we OWN — the app's semantic delta (specify these)

These encode meaning Genie (read-only) never needed. Confirm each *shade* against the
DuBois semantic palette; alias to a DuBois token wherever one exists.

| Token | Purpose (this app only) | Maps to / guidance |
|---|---|---|
| `--sem-success` | commit succeeded, position clean | DuBois `--success` (green) |
| `--sem-danger` | **GA00x guardrail block** (self-approve, over-alloc, forged identity) | DuBois `--destructive` (red) — high salience |
| `--sem-warning` | low-confidence extraction, stale version, chase-overdue | DuBois `--warning` (amber) |
| `--sem-info` | tool-event / agent-activity log entries | DuBois neutral-blue / `--muted-foreground` |
| `--sem-pending` | proposal `staged` / `awaiting approval` | neutral |
| `--sem-money` | numeric treatment for amounts | **tabular-nums**, slightly heavier weight |

## D. Non-color tokens — safe starting spec (align to the DuBois 4/8px grid)

Reasonable defaults to start from; verify against live DuBois before final polish.

- **Spacing:** 4px base grid → 4 / 8 / 12 / 16 / 24 / 32. Console-grade, not
  marketing-airy.
- **Radius:** small/crisp — ~4px controls, ~6–8px cards (DuBois is low-radius; avoid
  oversized consumer chat-bubble pills).
- **Density:** medium-dense. Body **~13–14px** (the Databricks console is denser than
  consumer chat — don't go 16px). Transcript line-height ~1.4–1.5.
- **Control height:** ~32–36px.
- **Main text measure:** ~720–820px for readable responses.
- **Numbers:** **always tabular / monospaced** for money and versions — a
  correctness affordance, not decoration (misaligned digits cause misreads on a
  financial surface).
- **Shadows:** minimal; let borders + surface contrast define structure.

## E. Where the tokens live in code

- A thin machine-readable alias layer, e.g. `client/src/theme/semantic-tokens.ts`,
  that **references** DuBois variables (does not duplicate raw values) and defines the
  §C `--sem-*` aliases.
- A short "token source" note recording which values come from DuBois vs. which are
  project-specific semantic aliases — so no one later hardcodes a guessed hex.

## F. Light-first

Ship **light mode first** (Genie's default, and the more trustworthy read for a money
surface). Dark mode is optional and, if built, must use semantic tokens — **not** a
port of the spike's custom dark CSS.
