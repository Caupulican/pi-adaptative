# Router Setup

`/settings` → **Model Router** is the router's one control surface: which models the router may pick,
who picks the exact model, how subscription-backed models are preferred, and the evidence behind each
choice. Nothing on this screen runs a provider call by being opened.

## Selection mode

| Mode | Tier model |
| --- | --- |
| `manual` (default for existing installs) | the operator's pin for each tier; an unset tier stays unset, exactly as before |
| `auto` | the router decides the tier (regex floor, optional judge), then selects the exact model from the candidate pool |
| `hybrid` | a pinned tier wins; an unpinned tier selects automatically |

Tier pickers show `(AUTO)` for a tier the router selects and `(unset)` in manual mode. Existing
`modelRouter` settings load unchanged: `selectionMode` defaults to `manual` and `poolPreference` to
`subscription-first`; no reset happens.

## Candidate pool

The pool is the existing **Models** configuration and nothing else, and it carries its provenance:
`enabledModels` in settings (`Models config`), the `--models` flag (`--models`), an SDK caller's scope
(`SDK scope`) or a live edit in the Models selector (`Models selector`). An uncustomized configuration
means every model with configured auth (`all enabled models (N)`); a customized list is a hard boundary
(`N selected models (Models config)`) that no automatic route — router or H-MoE — can leave. The pool is
separate from the model-cycling list: an orchestration profile pins cycling to its root model but is
never a pool source, so a profiled session still routes across everything you enabled. Favorites order
pickers only; they never enter the pool or weigh a route. A model outside a customized pool can still
be pinned manually (the picker marks it `outside pool`, and Diagnostics and the route preview name the
exception), but it is never selected automatically.

**Configure models** opens the Models selector (the same multi-select editor as `/models`); when it
closes, Router Setup comes back on the edited pool, so the summary, calibration rows, tier pickers and
preview all describe the new pool. Session-only edits and saved edits both change the pool immediately.

## Subscription-first

`poolPreference` applies only to automatically selected tiers and only after hard admission:

```text
eligible candidates → hard admission → evidence class → subscription preference → evidence ranking
```

Hard admission is authority and preference cannot override it: missing auth, quota exhaustion, a
local/managed model with no working tool-call path, the fitness gate when enabled, a manual pin, or
the pool boundary. Among admitted candidates the evidence class comes first — `known_fit` (probed and
passing this surface's lanes) ahead of `unprobed` ahead of `known_unfit` — whether or not the hard
fitness gate is on, so a model the probes graded unfit is never preferred for being subscription-backed.
Within a class, `subscription-first` ranks subscription-backed models (`ModelRegistry.isUsingSubscription`,
the same ownership the footer's `(sub)` uses) ahead of metered ones, and then the existing ranking decides
(capability class, tier-appropriate cost, stable name order). `balanced` keeps the evidence ranking alone.
A known-fit metered model always beats a known-unfit subscription model; two fit candidates prefer the
subscription one.

When the adaptive runtime's H-MoE expert selector is attached, it refines auto-selected tiers with
the pool as its `allowed_model_refs` allowlist (enforced when candidates are generated and again at
admission); its ranking orders the same adequacy class first (derived from the FitnessStore lane the
request uses), then `prefer_subscription` within the class, then the evidence score; manual pins are never
handed to it.

## Calibration

Operator-triggered only. Calibration reuses the existing evidence and nothing else: the host-keyed
fitness reports written by `/fitness` (`runModelFitness`) and the persisted `/toolprobe` verdicts.
Each pool model shows one state per router surface — the five router fitness surfaces `router_cheap`,
`router_medium`, `router_expensive`, `router_judge`, `executor` — as `FIT`, `UNFIT`, `UNPROBED` or
`STALE`; the real tool execution probe is reported separately. A surface whose lane is missing from an
otherwise present report is `UNPROBED`, not fit. Evidence is `STALE` when it is older than 30 days, when
a tool probe was recorded after it, or when the model's registered context window changed since the
probe; stale evidence never appears fresh. Evidence does not detect a changed endpoint or serving stack
behind the same `provider/id`, nor a change to the surface-to-lane mapping; recalibrate after either.
There is no universal intelligence score.

- **Calibrate one model**: pick a pool model; the existing fitness probe runs, then the real tool
  probe, then the role selector.
- **Calibrate unprobed**: every pool model with no report, stale evidence, or any router surface still `UNPROBED` or `STALE`.
- **Recalibrate selected**: every pool model.

Batch runs show the models, the surfaces, that provider calls are required and the last known cost,
and run only after you confirm. A mechanically incompatible model (no tool path, failed lanes) cannot
be marked fit by hand; correct routing structure through manual/hybrid pins instead.

## Preview route

Enter an example task. The deterministic preview classifies it exactly as a turn would and resolves
the model through the same code path — intent, baseline tier, risk, reason, mode, pin, pool,
subscription candidates, eligible candidates, the model it would choose, its source and fitness —
without any provider call and without touching the session model or the router's status. Prefix the
task with `live:` to run the judged path (routing judge and H-MoE may spend); that is still
inspection, not execution.

## Diagnostics

Prints the router status: mode, pool, preference, tier fitness when the gate is on, and recent
decisions with their selection provenance (`selected by manual`, `auto` or `H-MoE`).

## Operator POV

While a routed turn runs, the POV bar shows `ROOT` (the session model the turn returns to),
`ACTIVE` (the model executing now) and `ROUTE` with the authority that chose it — `direct`,
`manual:<model>`, `<tier> via model-router`, `<tier> via model-router/H-MoE` or
`escalated→<model> via model-router`. Jev is never named as the selector; its own slot reports only
its observed state (`JEV off | ready | eval | ok | degraded`). See `workbench.md`.
