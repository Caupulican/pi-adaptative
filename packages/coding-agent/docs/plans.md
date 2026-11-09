# Plans

A plan is the root session's whole breakdown of one goal: a titled set of steps, the files each step may change, which steps need which others, and joins that combine several results into one. The root records it with one `plan` tool call; the harness then runs it. Ready steps start in parallel as the fleet has room, failed steps retry through the normal worker recovery, and the root is woken once per combined result instead of once per worker. Nothing requires the owner to type a command for a plan to run, retry, join or finish.

In this build the `plan` tool is not offered to the root session yet: the harness runs plans and shows them, but the session does not register the tool. Until it does, no new plan can be recorded.

## How the root uses `plan`

`plan` is a root-only tool. Workers and bots never receive it.

- `start`: a `title` and every step. Each step has an `id`, `do` (the task in plain words), and optionally `files` (what it may change; none means read-only), `uses` (steps whose results it needs and receives), `after` (steps that must finish first, without results), `req` (goal requirement ids it proves), `deep` (a hard step that needs more thinking), `join` with `question`, and `by` (a bot, leader or machine to prefer). `final` names the step whose result finishes the plan.
- `revise`: steps to add or replace (the same id replaces) and `remove`; an unchanged running step keeps running, a changed one starts afresh.
- `cancel`: ends the plan with a `reason`.

Before anything runs, code checks the plan: known step ids, no loops, size and depth bounds, joins that list their members in `uses`, write scopes inside the repository, room in the session's task ledger, and requirement ids that exist on the active goal. A refused plan lists every fix at once and records nothing. Open requirements no step cites stay with the root. System One may add an ordering edge or note a doubt; it never refuses a plan by itself, but an edge it adds is checked with the plan again, and a plan that no longer passes the code checks with that order is refused with the edge named. When System One is unavailable the plan is recorded on the code checks alone and marked as checked without System One.

## Joins

A join is a step that combines the steps in its `uses`:

- `collect`: gathers the members' results in order, with which requirements they cover.
- `reduce`: a read-only worker turns the members' findings into one answer to the step's `question`.
- `vote`: picks the best of several attempts at the same task against the `question`.
- `race`: the first accepted attempt wins; the others are cancelled.
- `verify`: an independent check of the members' work.
- `merge` (combining file changes) is not available yet: the tool does not offer it, and a stored plan that names it is refused with a fix to use `collect`.

## What the owner sees

The work panel shows each open plan under a heading with its title and counts (`Plan: Add export to CSV · 3 of 7 done · 2 running · 1 waiting`), then one row per step: the step's task as its label, and its state in plain words (waiting, starting, running, done, needs you, needs a re-plan, waiting on the root, replaced, cancelled), what kind of join it is, where it runs (worker, bot, leader, another machine) and, for a finished step, how it ended. A held step shows why in its details. The compact Work plan block keeps held and failed steps first, then running, then waiting ones, and counts the rest. With no open plan, the panel shows the last plan and how it ended. A worker running a plan step is listed under Workers by its step's task. The live row's plan slot shows the running plan as `Plan 3/7 · <title>`, or `Needs you 3/7 · <title>` while a step waits on the owner.

`/status` prints one line per open plan:

```
Plans:
  Plan "Add export to CSV": 3 of 7 done, 2 running, waiting on you for 1 step.
```

`/plan` prints each open plan step by step (title, version, state, counts, one line per step with its state and any held reason, and the requirements the root keeps), and each closed plan in one line with how and why it ended. It only reads; the same data is in the RPC `get_autonomy_status` response under `plans`.

The harness log records plan decisions under the `plan` category (see [Settings](settings.md)).
