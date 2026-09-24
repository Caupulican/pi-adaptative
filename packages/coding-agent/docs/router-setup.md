# Router Setup

`/settings` → **Model Router** is the router's one control surface: which models the router may pick,
who picks the exact model, how subscription-backed models are preferred, and the evidence behind each
choice. Nothing on this screen runs a provider call by being opened.

## Conversation stages

The router decides once per conversation, not once per message:

- **Opening.** The first owner message the classifier does not mark small is routed once (System One judges it when configured). Its model becomes the conversation's talker: it is set as the session model, so later turns and a resumed session run on it with no swap, and the choice is recorded as a `conversation_talker` entry.
- **Talker.** Every later substantive owner message goes to the talker with no route judged. `/model` changes the talker like any session model change. A conversation that outgrows the talker's window is compacted, never moved.
- **Side trip.** A message the classifier marks small (no System One call) takes one turn on the cheap tier (its pin first) when that costs less than the talker answering on its warm cache: writing the side trip's brief at the cheap model's cold price, against the talker's cache-read price for its prefix. A free model always qualifies. The side trip reads a small brief, the talker's last reply and the new message, never the transcript, and its reply stays in the conversation. If it reaches for a mutating tool, the message reruns on the talker.
- **Toolkit hit.** A message that is exactly a registered toolkit script's name or one of its taught aliases runs that script through `run_toolkit_script` (its authorization and danger confirmation unchanged) with no model request, and the run is recorded like a `!` command for the talker to read next turn. A message that only reads like a script ("is the status report green?") goes to the talker. `executorModel` no longer takes foreground turns; it stays in the pool.
- **Internal turns** (goal continuations, System One route briefs, lane follow-ups, reflection) run on the talker with no tier swap. Work meant for another model goes to a worker through the objective route.
- **Work boundary.** Work starts where it is declared (a goal starting) or, with nothing declared, at the first tool call that may change the world. Each start is recorded once as a `work_unit` entry; an enforced unit ends when the owner speaks again, a declared one when its goal ends. For a route the root may take, the objective loop hands the work to a worker only when that is cheaper: writing the route's brief on the worker and appending its report, against the talker reading its whole prefix on each of the requests that route kind has learned to take (the root keeps the work until it has learned that). A retrieve route follows the same price: when the talker's reads would cost more, read-only minions (no forked turns, one per requirement the route targets) gather in parallel, and only their accepted reports reach the talker, as one bounded `gathered_evidence` record on its next turn.

## Selection mode

| Mode | Tier model |
| --- | --- |
| `manual` (default for existing installs) | the operator's pin for each tier; an unset tier stays unset, exactly as before |
| `auto` | the router decides the tier (regex floor, optional System One judge), then selects the exact model from the candidate pool |
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
Each pool model shows one state per router surface — the four router fitness surfaces `router_cheap`,
`router_medium`, `router_expensive`, `executor` — as `FIT`, `UNFIT`, `UNPROBED` or
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
task with `live:` to run the judged path (the System One routing judge and H-MoE may spend); that is
still inspection, not execution.

## Diagnostics

Prints the router status: mode, pool, preference, tier fitness when the gate is on, and recent
decisions with their selection provenance (`selected by manual`, `auto` or `H-MoE`).

## Operator POV

While a routed turn runs, the POV bar shows `ROOT` (the session model the turn returns to),
`ACTIVE` (the model executing now) and `ROUTE` with the authority that chose it — `direct`,
`manual:<model>`, `<tier> via model-router`, `<tier> via model-router/H-MoE` or
`escalated→<model> via model-router`. Jev is never named as the selector; its own slot reports only
its observed state (`S1 off | ready | eval | ok | degraded`). See `workbench.md`.

A routed turn's model is the turn's, never the session's. The session model is the one last selected
(session start, `/model`, a forced switch such as billing failover or an unavailable model), recorded as a
`model_change`; a reply written by a routed model never becomes it, so a resumed session reopens on the
same ROOT. Billing failover inside a routed turn replaces that turn's model and leaves the session model alone.

When a subscription runs out of quota (a usage limit, an exhausted balance, HTTP 402), the work moves
on and the failed request continues at once on the new model (`Continuing on <model>`). A provider's own
backup comes first when it has a usable one (Codex's default model); otherwise the router picks, trying
the tiers from strongest to cheapest with the same checks a routed turn uses: your pin for the tier in
any selection mode, then the tier's automatic pick from the pool, never an exhausted model, one outside
your model policy, one without auth or a working tool path, or one too small for the context. A metered
balance still stops and asks, because moving it to another paid model is a spending decision.
`failover.subscriptionHop: false` turns the automatic move off.

## Model pools by request

Models fall in three pools: subscription (a flat plan, not billed per request), metered (pay-per-use API
keys) and local. The owner turns pools on and off by saying so in the session ("we can only use
subscription models", "enable the API models again", "no local models"). System One reads the change;
the policy then governs every allocation from the next pick on: foreground turns, workers, background
lanes and the stronger-model consult. A pin or the session model outside the policy is reallocated from
the allowed pool, even with the router off, never refused. A change that would leave no model to
allocate is refused with the reason and the previous policy stays. System One itself is not a pool.

## System One allocation

When System One is bound, a routed turn is allocated in three steps. System One judges which kind of
model and thinking the work needs (one Choice over flash-light, flash-deep, strong-medium, strong-deep),
and each category names a tier. The owner's pin for that tier runs it, in any selection mode, whenever
the pin has auth, is allowed by the model policy, is not exhausted, has a working tool path and can take
the turn (reads images when there is one, fits the context). Otherwise H-MoE picks inside the category
from facts: a model the probes graded unfit sorts last; System One judges which models are lightweight
speed variants and which are superseded by a later version of the same model; flash models are ordered
by measured turn time on this host, first token included; a model that runs the category's thinking
level exactly comes before one that only reaches it by clamping. Confidence at 0.90 decides; otherwise
the question narrows to the two leading options and decides there; a leader from 0.80 may stand for a
reversible route with its doubt recorded. `npm run probe:system-one-route` measures the choice on the
machine's real models.
