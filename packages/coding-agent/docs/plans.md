# Plans

A plan is the root session's whole breakdown of one goal: a titled set of steps, the files each step may change, which steps need which others, and joins that combine several results into one. The root records it with one `plan` tool call; the harness then runs it. Ready steps start in parallel as the fleet has room, failed steps retry through the normal worker recovery, and the root is woken once per combined result instead of once per worker. Nothing requires the owner to type a command for a plan to run, retry, join or finish.

## How the root uses `plan`

`plan` is a root-only tool. Workers and bots never receive it.

- `start`: a `title` and every step. Each step has an `id`, `do` (the task in plain words), and optionally `files` (what it may change; none means read-only), `uses` (steps whose results it needs and receives), `after` (steps that must finish first, without results), `req` (goal requirement ids it proves), `deep` (a hard step that needs more thinking), `join` with `question`, `need` (a collect join: how many of the steps in `uses` must succeed), `by` (a bot, leader or machine to prefer), `doneWhen` (the one line that says the step is done) and `outOfScope` (what the step must not touch). The worker reads the last two as `Done when:` and `Out of scope:` lines, and the step's proof sheet repeats them. `final` names the step whose result finishes the plan.
- `revise`: steps to add or replace (the same id replaces) and `remove`; an unchanged running step keeps running, a changed one starts afresh.
- `cancel`: ends the plan with a `reason`.

Before anything runs, code checks the plan: known step ids, no loops, size and depth bounds, joins that list their members in `uses`, write scopes inside the repository, room in the session's task ledger, and requirement ids that exist on the active goal. A refused plan lists every fix at once and records nothing. Open requirements no step cites stay with the root. System One may add an ordering edge or note a doubt; it never refuses a plan by itself, but an edge it adds is checked with the plan again, and a plan that no longer passes the code checks with that order is refused with the edge named. When System One is unavailable the plan is recorded on the code checks alone and marked as checked without System One. A System One request that does not answer within its bound counts as unavailable for that question: the code facts decide it, and the plan notes the doubt.

A plan survives its session being closed. Closing the session interrupts the plan's workers and cancels none of them: a step whose worker was running goes on with the task it was given, a step whose worker was waiting for room starts when there is room, and a step that had finished is not run again. When the session is opened again the plan goes on by itself, without a prompt, and the root is told of each join and of the plan's result. The same holds when the process ends without closing the session: on the next opening a step whose worker was running under the ended process is suspended and then goes on, and a step that was waiting for room is taken up as it was.

A plan started under a goal holds that goal's automatic continuation while any of its steps is running, starting or ready: the root is not prompted to go on in the meantime, whether or not the goal has an open requirement, and is woken by the plan itself, with each combined result and when a step needs it. The wait ends by itself when the plan shows no movement for an hour (no step released, finished or held, no join combined): the goal then continues once, so the root can go on with what is known and re-plan what is stuck. A goal that stops (its budget is spent, the owner pauses it) does not stop the plan's running steps: they finish and report, steps that had not started wait until the goal goes on, and what the plan has to tell still reaches the root.

## Joins

A join is a step that combines the steps in its `uses`:

- `collect`: gathers the members' results in order, with which requirements they cover. A `need` settles it on a quorum: `need: 2` over three members settles the join once two have succeeded, and stops the one still running; left out, every member is waited for.
- `reduce`: a read-only worker turns the members' findings into one answer to the step's `question`.
- `vote`: picks the best of several attempts at the same task against the `question`.
- `race`: the first accepted attempt wins; the others are cancelled.
- `verify`: an independent check of the members' work.
- `merge`: lands file changes on main. Every step in its `uses` is plain work that names its `files`. Each of those steps works in its own worktree lane (its own folder and branch off main) and commits there with git before it reports. A result that is not verified is checked first by an independent review, which the plan adds by itself; the review runs in that step's lane, because the work is there and not in the shared checkout until it lands. When every check has accepted, the harness lands the lanes on main in the plan's order through the land check (`worktreeSync.gate`, `worktreeSync.gateCommand`), without a worker. A lane that cannot land gets one worker to merge it; a second failure holds the join and names the steps and files, and a refusal only the owner can fix holds at once with the fix in words.

A lane is a fresh checkout of main, so a `merge` needs a git repository whose checkout is on main, has no uncommitted or untracked changes, and keeps no installed dependencies in it (`node_modules`, `.venv`, `venv`). Where no lane can be made the step is held and says why, so the root can order the steps with `after` instead of merging them. See [Worktree sync](worktree-sync.md) for what a lane is and when it is released.

## What the owner sees

The work panel shows each open plan under a heading with its title and counts (`Plan: Add export to CSV · 3 of 7 done · 2 running · 1 waiting`), then one row per step: the step's task as its label, and its state in plain words (waiting, starting, running, done, needs you, needs a re-plan, waiting on the root, replaced, cancelled), what kind of join it is, what a waiting step waits for (`after 2 steps`), a hard step's `hard step, deep thinking`, where it runs (worker, bot, leader, another machine), its attempt once it has run more than once, and, for a finished step, how it ended. A held step shows why in its details. The compact Work plan block keeps held and failed steps first, then running, then waiting ones, and counts the rest. With no open plan, the panel shows the last plan and how it ended. A worker running a plan step is listed under Workers by its step's task. The live row's plan slot shows the running plan as `Plan 3/7 · <title>`, or `Needs you 3/7 · <title>` while a step waits on the owner.

When a join combines its members or the plan settles, the update carries a proof sheet, shown before the update text: which requirements the combined result covers, the files the members changed, failed members, gaps and conflicts, and the spend. A join runs no checks of its own, so the plan sheet does not judge which changed files a check touched; it says the checks are on each step's own result, where the member workers' sheets show them.

`/status` prints one line per open plan:

```
Plans:
  Plan "Add export to CSV": 3 of 7 done, 2 running, waiting on you for 1 step.
```

`/plan` prints each open plan step by step (title, version, state, counts, one line per step with its state and any held reason, and the requirements the root keeps), and each closed plan in one line with how and why it ended. It only reads; the same data is in the RPC `get_autonomy_status` response under `plans`.

The harness log records plan decisions under the `plan` category (see [Settings](settings.md)).
