# worktree-sync

`worktree_sync` is a core (built-in, not extension) tool: a hard-gated, worktree-per-lane
parallel-work workflow for a solo developer who does not use PRs. Every writing agent works in
its own local git worktree on its own lane branch; integration is always rebase-onto-main +
fast-forward — linear history, no merge commits, no PRs, no push. `origin` is never touched;
push stays a manual owner act.

## Workflow overview

1. A lane worktree is created off main (`create_lane`) with its own branch (`pi/wt/<laneKey>`).
2. The agent bound to the lane works and commits inside that worktree only.
3. Before landing, the lane must be fresh relative to main: `sync` rebases current main onto the
   lane branch. A clean rebase leaves the lane fresh; conflicts leave the rebase in progress and
   return a structured worklist.
4. `land` is the only door to main: serialized under one integration lock, freshness-checked,
   gate-command-verified, fast-forward-only.
5. A successful land bumps a shared integration epoch and marks every other active lane stale —
   structurally, not by convention — so the next lane to touch files or land is directed to sync
   first.
6. `release_lane` removes a fully-landed, clean lane worktree and branch. When a collaboration
   worker's process closes, the host does this itself (see "Lane lifecycle").

Correctness never depends on a notification arriving; it depends on `land`'s own freshness check
(G3 below), re-derived from git at land time while holding the lock. Notifications only make
lanes aware *promptly*.

## Enabling

Enabled by default; `"worktreeSync": { "enabled": false }` is the explicit off-switch — zero
behavior change once set. Settings live under `worktreeSync` in `settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Explicit `false` is the hard off-switch: the tool is hidden, no gating runs, and in-process workers keep sharing the root's checkout (see "Worker lanes for in-process `delegate` workers"). |
| `mainBranch` | unset (auto) | Overrides default-branch resolution (`main`, then `master`; never guessed further). |
| `syncPolicy` | `"on_land_mandatory"` | Staleness-propagation policy — see below. |
| `gateCommand` | unset | Land gate command (G4), e.g. `"npm run check"`, run in the lane worktree at the exact tip that becomes main. |
| `gate` | `"on"` | `"off"` is the owner-level G4 opt-out, recorded per land event. Agents cannot flip this at runtime. |
| `gateTimeoutMs` | `900000` | Gate command timeout. |
| `maxLanes` | `5` | Active-lane ceiling; `create_lane` refuses beyond it. |
| `worktreesRoot` | agent-paths default | Overrides the lane-checkout root. |
| `workerLand` | `"deny"` | `"allow"` lets a WORKER session (see "Identity, UAC, and zero footprint" below) run `land` on its own bound lane; still subject to normal freshness/ownership gating. |

`syncPolicy` values:

- **`on_land_mandatory`** (default) — every successful land marks every *other* active lane
  `sync_required`; under this policy a stale lane's file mutations are refused until it syncs.
- **`overlap_mandatory`** — `sync_required` fires only when the land's changed paths overlap the
  lane's own changed paths; otherwise staleness stays advisory until land time.
- **`land_time_only`** — staleness is always advisory; only the land gate (G3) enforces.

## The hard gates (G1–G11)

Enforced in core code paths, never by prompt compliance. Every refusal carries a tagged code and
appends an audit event.

| # | Gate |
|---|---|
| G1 | `land` is serialized under one integration lock — two concurrent lands are impossible. |
| G2 | `land` requires the lane worktree clean (no uncommitted/untracked-modified state). Refusal: `lane_dirty`. |
| G3 | `land` requires the lane fresh (current main is an ancestor of the lane tip), re-derived from git while holding the lock. Refusal: `stale_lane` + a structural sync directive. This is the backstop that cannot be evaded even if every notification failed. |
| G4 | `land` requires the configured gate command to pass at the exact tip that will become main, unless the owner set `gate: "off"` (recorded per land event). |
| G5 | Main only ever moves by a fast-forward merge of the lane branch in the hub checkout — no merge commits, no force, no rewrite of main. |
| G6 | `land` refuses `hub_dirty` only when hub-local modifications intersect the land's changed-file set (overlap-based, not pristine-hub-based). |
| G7 | A successful land bumps the epoch and broadcasts staleness in the same critical section as the merge, before the lock releases. |
| G8 | A stale lane under the mandatory policy is refused by the file-mutation tools (edit/write/mutating bash) of a lane-bound `pi` session until it syncs. Hard for `pi` children; cooperative for foreign CLIs. |
| G9 | Sync completion requires the rebase finished, zero conflict markers (byte-scanned), and freshness passing. Refusals: `conflict_markers_present`, `rebase_in_progress`. |
| G10 | No lane touches main directly — a lane-bound `pi` session's `git commit/merge/rebase/reset/switch` targeting main is refused (`main_mutation_refused`). Main is written by the land gate alone. |
| G11 | A lane with unlanded commits or dirty state is never auto-deleted; `release_lane` on such a lane requires `confirm: "yes-discard-lane"`. |

## The `worktree_sync` tool

One tool, thirteen actions — the entire agent-facing surface, so a model never improvises git
ceremony. Every outcome carries a tagged code (`details.code`) and refusal text always names the
exact recovery step.

| Action | Effect |
|---|---|
| `status` | The deterministic full picture: epoch, hub state, lock, per-lane freshness/staleness/dirty/rebase state, and a one-sentence assembled `advice`. Read-only. |
| `git_status` / `git_diff` | Read the bound lane with fixed argv (`git status --short --branch`, `git diff -- <paths>`). `paths` are explicit relative paths that must stay inside the lane worktree (`path_outside_lane` otherwise). |
| `git_add` | Stage only explicitly named, validated in-lane `paths` (`git add -- <paths>`); no paths is refused, so `git add -A`/`.` cannot be expressed. |
| `git_commit` | `git commit -m <message>` with a literal, non-empty `message`; no `-a`, no `--no-verify`. |
| `check` | Run only the owner-configured trusted check (`worktreeSync.gateCommand`) in the lane worktree; refused `gate_command_unset` when none is configured. |
| `create_lane` | Worktree add + branch + registration off main. Params: `laneKey?` (else auto-allocated), `goalId?`, `requirementId?`. |
| `sync` | Rebases current main into the lane branch. Clean → lane fresh. Conflicts → rebase left in progress plus a structured worklist. |
| `continue` | After conflicts are resolved: verifies zero conflict markers, stages, and drives the rebase to completion (looping per conflicted commit). |
| `abort_sync` | Aborts the in-progress rebase; the lane returns to its pre-sync tip, still honestly reported as stale. |
| `land` | The full G1–G7 pipeline. On success returns the new epoch and main sha. |
| `release_lane` | Unregisters the lane and removes the worktree/branch — only when fully landed and clean, else the G11 confirm. |
| `reconcile` | Re-syncs the lane registry with git reality (orphaned worktrees, stale locks, cleared owners). Runs automatically at startup in a main session (never in a worker session); also directly callable by a main session. The `reconcile_summary` audit event is appended only when the pass changed something. |

## Lane lifecycle

`create` → work/commit on the lane branch → `sync` (rebase current main in) → resolve conflicts
locally and `continue` → `land` → (optionally) `release`. Landing does not happen automatically
when a worker finishes its task — it is a distinct, deliberate step the orchestrator (or the
worker, when instructed) triggers, since the gate run at land time is itself the evidence the
goal record relies on.

For a goal-bound collaboration dispatch the host also owns the two lifecycle edges, both driven by
the managed-lane ledger's own events (never by polling a process):

- **Dispatch**: the created lane is bound to the managed worker (`bindLaneWorker`, `boundLaneId`) when
  the worker's dispatch is recorded. If the dispatch fails after the lane was created
  (`collaboration_dispatch_failed`, `collaboration_dispatch_incomplete`, `lane_correlation_failed`) the
  fresh lane is released at once, so a failed dispatch leaves no lane, branch, or registry entry. A lane
  that cannot be released is named in the skip reason (`;worktree_lane_kept=<laneKey>(<code>)`).
- **Repository of the lane**: the dispatch record also carries the lane's worktree path (`worktreeLanePath`,
  next to `worktreeLaneKey`, a caller claim like it). A task directory can sit in a different repository than
  the session's own, so both edges act in the repository that path belongs to: binding runs from the lane's
  path, and closure resolves that repository's own checkout (the lane's directory is the one thing a release
  deletes, so the engine cannot run from it) and releases there. A wrong path finds no lane, or one bound to
  another worker, and releases nothing; it falls back to the session's directory only when the path no longer
  leads to a repository.
- **Worker closure**: when the worker's process closes (the `retired` lifecycle report, which follows
  its last published turn) the host releases its lane if, and only if, the lane is bound to that exact
  worker (`lane_bound_elsewhere` otherwise: the lane key in a dispatch is a caller claim), the branch is
  fully landed, and the checkout clean. The release runs once per closure report and is not retried by
  polling: a host that stops between recording the closure and finishing the release leaves the lane
  registered for an explicit `release_lane`. A lane holding unlanded commits or dirty files is never auto-discarded: it stays
  registered and the parent session is told, and discarding it remains the explicit `release_lane`
  `confirm: "yes-discard-lane"` decision (G11). A worker that is idle but not closed keeps its lane,
  since a persistent agent can receive another turn in it.

The conflict-resolution substrate (rerere replay, zdiff3 hunks) is passed to each rebase-driving git
command with `git -c`; the engine never writes it into the shared `.git/config`, so creating or
releasing a lane leaves the repository's configuration untouched.

## Worker lanes for in-process `delegate` workers

An in-process worker that shares the root's checkout shares its branch, index and HEAD: its `git commit` or
`git merge` lands on the root's branch, and two workers can race each other there. Git is not an edge class, so
no permission gate separates them, and refusing git commands would cost the long work workers exist for. The
host isolates instead. When `worktreeSync.enabled` is true (the default), a **fresh** worker that can write
(`write`/`edit` granted, not a verifier, not a reused specialist) is moved into its own lane worktree on its own
branch off main before it is admitted, through the same engine as every other lane:

- the lane becomes the worker's execution directory, so the immutable execution contract pins it (a restarted
  worker resumes in the same lane) and its `write`/`edit` scope, shell directory and claim review are the lane's;
- the worker's repository writes can only land on its own lane branch; `git switch main` fails because main is
  checked out in the hub, and nothing it commits reaches main except through `sync` and `land`;
- the lane registration records the worker as its owner when the worker starts;
- when the worker ends and its lane holds work (uncommitted changes or commits ahead of main), the claim carries
  a `worker_lane:` blocker naming the lane key, path and branch and the steps to integrate it, and requires
  parent review, so the parent looks in the lane and not in the shared checkout. The root reviews with
  `worktree_sync git_diff laneKey=<key>` and integrates with `git_add`/`git_commit` (laneKey), `sync`, `land`; a
  `git_commit` the root makes in a lane bound to a worker records that worker as the commit's author (the
  committer stays the committing session), so the work stays attributed to the worker that did it;
- the lane is released when the worker's persistent identity is retired (`delegate retire`), the lifecycle edge
  itself, never polled, and only if it is fully landed and clean; a lane holding work is kept, the parent is
  told, and discarding it stays the explicit `release_lane` `confirm: "yes-discard-lane"` decision (G11). A
  lane a refused start never used is removed at once.

**By design, isolation applies to clean repositories without in-tree dependency directories.** A lane is a fresh
checkout of main, so it is only the same code the worker would have seen when the checkout is on main and
clean, and it only lets the worker run the project's checks when the project keeps no installed dependencies in
the checkout. A dirty checkout, or one with `node_modules`, `.venv` or `venv` in it, keeps the shared checkout,
with the attribution, overlap and tamper findings below instead of isolation. The host never symlinks
`node_modules` (or any dependency directory) into a lane: a link into the shared tree lets the lane's installs
and builds write back into the checkout it was meant to be isolated from, which is the baseline-contamination
trap, and a lane-local install is a project decision the host does not make. In full, the worker stays in the
shared checkout when:

- the checkout is not on main, or has uncommitted or untracked changes (they would be invisible in the lane);
- installed dependencies live in the checkout (`node_modules`, `.venv`, `venv`): a fresh lane has none, so the
  worker could not run the project's checks;
- the directory is not a git repository, or the engine refuses the lane (for example `max_lanes_reached`);
- the root granted write roots (`writePaths`) outside the lane: it means the worker to write the shared
  checkout, so the lane is removed and the worker runs there. Root instructions that name absolute
  shared-checkout paths therefore also keep a worker out of a lane, and a lane worker that is denied a write
  outside its lane is told to report the path for a `writePaths` re-dispatch;
- the worker is a reused specialist: a reused specialist keeps the directory its contract pinned, so it
  continues in its own lane. Matching a request to such a specialist, with or without naming its `agentId`,
  compares everything but the directory exactly (profile, model, tools, read scope, budget, soul, resources), maps
  the caller's directory onto the lane in the write scope (a different granted write root is a different
  specialization), and requires the lane's registration to be bound to that same specialist and to have been made
  from the repository of the caller's directory. A lane bound to another worker, or to none, never matches, so
  matching cannot cross lanes between workers.

An unexpected refusal (a git error, the lane ceiling) is warned to the owner; the expected conditions above are
silent. A lane of a worker that is never retired stays registered until it is retired or released explicitly and
counts against `maxLanes`, a ceiling it **shares with goal collaboration dispatch**: once it is reached new
workers stay in the shared checkout and a goal's `dispatch_worker` collaboration lane is refused
(`worktree_create_failed`) until a lane is released, so retire idle writing workers. A lane whose worker was
cancelled or failed before it started never got bound; retiring that worker still releases it (landed and clean
only). A replayed `delegate start` still resolves to the original task: the replay comparison ignores the
directory-derived fields (cwd, write scope, workspace identity) for a lane worker and requires everything else to
match.

## Attribution without serialization

Workers are not serialized and their shell is not sandboxed, so the host records who did what and reports it to
the parent. Nothing below refuses a command, blocks a worker or reverts a change.

- **Git identity.** Every repository write a worker makes names the worker as the committer
  (`pi-worker <worker id>`, `pi-worker@localhost`) through `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` in the
  environment only, never in git config. The reflog entry of a ref move names the committer too, so `reset`,
  `branch -f`, `stash` and `rebase` are attributable, not only commits. An in-process worker's `bash`, `python`
  and `run_process` all get the identity (and the credential stripping and scratch directory) from the worker
  run environment, labelled with the worker's own agent id; a worker process (a lane-bound or collaboration `pi`
  child) exports it once at startup, so its shell, python, `run_process` and the engine's own typed
  `git_add`/`git_commit`/`sync` calls inherit it. `git push` carries the label too: the pre-push hook records
  `pushedBy` in the `pi-ci` verdict and `events.log`.
- **Concurrent writers.** The host remembers the files each in-process worker changed (the claim's
  `changedFiles`: what its `write`/`edit` tools and reported actions changed) and when it ran. When a worker
  finishes, every path that another worker, whose run overlapped in time, also changed is reported as a
  `worker_write_overlap:` blocker naming the path and both workers; the claim then requires parent review.
  Neither worker is blocked. A shell redirect or a script a worker runs is not in `changedFiles`. A claim carries
  at most 8 host findings; a final `host_findings:` line states how many more were omitted. A worker the parent
  cancels (or that is stopped by session dispose) carries the same bounded, attributed findings on its
  cancelled claim; the parent already reviews every cancelled claim.
- **Protected-path tamper detection.** `bash`, `python` and `run_process` are host-trust boundaries: a redirect
  can overwrite a harness file the structural `write` tool refuses (see "Structural path envelopes"). The host
  fingerprints (size and mtime, at most 2,048 entries and 5 levels deep) the configuration and executable part of
  the write-protected set (skills, extensions, prompts, profiles, themes, bin, root config files, project `.pi`
  files, `.husky`, `.git/config`, `.git/hooks`) between the start and end of every process-tool call and once
  across the whole run. A change is recorded as a `protected_path_changed:` blocker with the worker, the path
  and the before/after fingerprints, and the claim requires parent review. It says the path changed while this
  worker's command or run was in progress; it is evidence for review, not proof of authorship, because the root
  or another worker may also have written. The stores the host itself writes continuously (`state/`, `cache/`,
  `work/`, `sessions/`, `memory/`, ...) and `auth.json`, `MEMORY.md`, `USER.md` are not fingerprinted (a baseline
  over them would flag every check); they stay covered by the structural read/write denials only. Entries past
  the bounds are not watched. Python and run_process get the same worker run environment as bash (committer
  identity, credential stripping, scratch directory, ownership marker), including a research lane that grants
  python, by design. Disposing a lane with any of them scans `/proc` (Linux) once for processes that still carry
  its marker, also by design. A worker process (a collaboration or tmux `pi` child) runs its tool calls in a
  process the parent cannot see into, and a detector inside it would be under the control of what it watches,
  so the comparison for it runs in the parent: one fingerprint at dispatch and one at the worker's terminal
  report (the run scope), recorded as the same `protected_path_changed:` blocker on its claim. It is lost
  across a parent restart (the report then carries no comparison) and does not see per-call timing.

## Session binding: `PI_WORKTREE_LANE` / `--worktree-lane`

A session becomes lane-bound via the `PI_WORKTREE_LANE=<laneKey>` environment variable, or the
`--worktree-lane <laneKey>` CLI flag (sugar over the same env contract — collaboration panes launched by a
lane-first goal dispatch inherit it automatically). A lane-bound session:

- gets the G8/G10 lane gate wrapped under its file-mutation tools (edit/write/bash);
- defaults `worktree_sync`'s `laneKey` param to its own bound lane for `sync`/`continue`/
  `abort_sync`/`land`, so the model rarely needs to pass it explicitly;
- runs a lane-sync watcher (an `fs.watch` on the shared epoch file, checked at every turn start)
  that injects a source-labelled system notice when the epoch changes, so the session learns
  about staleness promptly instead of only at its next `status` call.

A goal-bound collaboration dispatch (`goal` tool's `dispatch_worker` with `dispatchTarget: "collaboration"`, when
`worktreeSync.enabled`) creates the lane first, then launches its `pi` worker with `--worktree-lane
<laneKey>` and one extra system-prompt clause naming the lane doctrine (work only inside this
lane's worktree; integrate exclusively via `worktree_sync land`; never touch main directly). A
lane-creation refusal (e.g. `maxLanes` reached) aborts the dispatch cleanly before any native agent
session is ever launched (`dispatchSkipReason: "worktree_create_failed"`).

## Capability adaptation

Complex agentic work (goals, worktree-sync lanes, orchestration) requires a capable model, and the
harness neither enforces nor allows it on a small one. The rule rides the existing model-capability
system (`core/model-capability.ts`). Every worker -- a worktree-sync lane worker, a launched
collaboration child, and an in-process `delegate` worker -- must have a model that is BOTH capability
class `full` AND has a declared, working native tool-call path. For lane-worker eligibility only,
unknown metadata refuses; ordinary foreground sessions keep the 128000 registry default.

- **Class `full`** with a DECLARED context window: the classifier reads the model's own REGISTRY
  metadata (`Model.contextWindow`), never the live serving context a local runtime happens to be
  configured with. A window the registry filled from its default (`Model.contextWindowDefaulted`)
  is not a declaration and refuses (`context_window_unknown`).
- **Declared native tool calling**: the transport facts come from the single `resolveModelToolProtocol`
  resolver. A built-in catalog model or one with an explicit `textToolCallProtocol: false` declares it;
  a probe verdict of `native` proves it. A user-configured model that declares nothing
  (`Model.toolCallingUndeclared`) refuses (`tool_calling_unknown`) until probed or declared.
  `textToolCallProtocol: true` without a native probe verdict is phone-only by declaration
  (`tool_calling_unadvertised`).
- **Not demoted**: a `/toolprobe` verdict of `text-protocol` or `none`, or a `toolProtocol` setting
  that forces the text protocol, makes the model ineligible (`tool_calling_demoted`).

The goal lifecycle tools (`goal`, `create_goal`, `get_goal`, `update_goal`) require class `full`:
they are blocked for lean and absent for minimal and chat. The lean class also blocks
`worktree_sync`, `improvement_loop`, `extensionify`, `skillify`, `model_fitness`, `context_scout`, and
`pi_collaboration` (`MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS`) -- `run_toolkit_script` and `task_steps`
stay available by design.

Refusal points, one authority:

- An in-process `delegate` worker is refused at admission against the WORKER model's own facts
  (`worker-delegation-controller.ts`), skip reason
  `worker_capability_insufficient:reason=<reason>;class=<class>;contextWindow=<window|unknown>`.
- A goal collaboration dispatch (`tools/collaboration-dispatch.ts`'s `dispatchCollaborationWorker`)
  evaluates the model the CHILD will resolve (its explicit selection, else its own startup resolution),
  FIRST, before `createLaneWorktree` or any `fire_task` call, with the same skip reason and zero
  lane/pane side effect. The `goal` result is then an error outcome (`operation_outcome`), never a
  success.
- The launched child session refuses AUTHORITATIVELY at its own startup (main.ts) when it is a lane
  worker (a bound worktree lane, a collaboration job member or an orchestration agent; other
  worker-role children, such as the read-only Auto Learn learner, carry no complex agentic work and
  are not subject to the model rule): it prints a deterministic, greppable line
  (`formatLaneWorkerRefusal`, prefix `lane-worker refusal:`, followed by what to change), records the
  refusal on its collaboration job, and exits non-zero. The controller then reports the turn `blocked` with that reason
  (`reasonCode: worker_capability_insufficient`), not a bare pane exit. There is no silent unbinding.

Every refusal names its remedy (`laneWorkerRefusalRemedy`): declare `contextWindow` and
`textToolCallProtocol: false` for the model in `models.json`, run `/toolprobe` to prove native tool
calls, pick a larger-window model for the worker, or clear a demoting verdict with
`/toolprotocol-reset`. The `delegate` and `goal` results carry that text, so a blocked start always
tells the parent what the owner changes.

Enforcement is orthogonal to prompt complexity: the lane gate (G8/G10) and the epoch watcher stay
wired for every OTHER session exactly as before this system existed. An ineligible session simply
never reaches them, because it never reaches session startup's live phase at all.

## Identity, UAC, and zero footprint

A session's **role** (`main` or `worker`) is derived structurally, never asserted by the session
itself (`core/session-role.ts`): a session is a **worker** iff it is bound to a worktree-sync lane
(`PI_WORKTREE_LANE`), launched with `PI_SESSION_ROLE=worker`, OR declared a managed child by a valid
`PI_PARENT_PID` (see `docs/process-matrix.md`). `PI_SESSION_ROLE=main` is
deliberately **not** an escalation -- it can never override a bound lane, so there is no
environment value a lane-bound process can set to shed the worker ceiling below.

### Forbidden-tool ceiling

A worker session holds only the tools named in `WORKER_PROCESS_ALLOWED_TOOLS`
(`core/worker-tool-ceiling.ts`, the single source of truth for every worker tool list): `read`,
`write`, `edit`, `grep`, `find`, `ls`, `repo_read`, `bash`, `python`, `run_process`, `tool_search`,
`artifact_retrieve`, `skill`, `skill_audit`, `systemone`, `fetch`, `web_search`, `webfetch` and
`worktree_sync`. A tool added to the catalogue later is never inherited until it is named there, and
extension tools are never inherited by default. The one way to add an extension tool is an explicit
launch-profile grant: a `pi_collaboration` agent's `tools` may name a tool provided by an extension
loaded (and the tool active) in the launching session. The worker process then loads only the extension
file that provides it and admits only that tool (`core/worker-extension-grants.ts`, env
`PI_WORKER_EXTENSION_TOOLS`). The grant is tool-only: the extension's factory runs, but it receives a
restricted `ExtensionAPI` (`core/extensions/tool-only-api.ts`) in which only `registerTool` for a granted
name takes effect. Every other registration (event handlers, commands, shortcuts, flags, message
renderers, markdown transformers, providers, memory providers, event-bus use) and every action on the
worker's session (`sendMessage`, `sendUserMessage`, `appendEntry`, `setActiveTools`, `setModel`, ...) is a
recorded no-op, never a throw, so the load does not fail; a startup warning names what was ignored
(bounded). `exec`, `getStorage`, `onDispose` and the read-only getters keep working. The view is a complete
`ExtensionAPI` literal, so a member added to the interface does not compile until it is classified there.
If the view cannot be built, or the file never registers the granted tool, the grant is refused with an
error naming the file; the extension is never loaded whole. A passive bundled extension (`tps`) still loads
whole. The tool's own `execute` receives a restricted `ctx` (cwd, signal, `hasUI: false`; no UI, session,
model registry, system prompt or way to abort, shut down, compact or reload the session; see
`docs/extensions.md`, "Loaded for a worker tool grant"). The tool keeps the worker's credential-exposure guard,
and the grant loader registers its name in the tool capability policy at startup as `path-scope` filesystem
authority, so the path envelopes below (private paths, harness write protection, default write scope) check
every path-looking argument as they check `write`; a tool whose arguments carry no path is unaffected. What the
grant ignores, at startup or later during a call, is recorded on the job once per label and reported to the
parent as one bounded `ignored by tool-only grant: ...` line in the turn's terminal summary. A name that is on
the forbidden floor, in-process-only, allow-listed, or capability-catalogued is never grantable, and an unknown
tool fails the launch with the reason. The grant is recorded in the job's immutable profile
(`extensionToolGrants`); the host-side capability grant compiles catalogued tools only, so a granted tool is
classified inside the worker process, not in the launcher's grant. The allow-list is enforced as the FIRST line of the
tool registry's allow predicate (`RuntimeBuilder`'s `isAllowedTool`, via `isWorkerProcessToolAllowed`),
so it wins over an allow-list, an exclude-list, or an active resource profile that names a tool.

Below the allow-list sits a deny floor, `WORKER_FORBIDDEN_TOOLS`, that no surface may widen: the legacy
composite `goal`, `secret_store`, `memory`, `delegate`, `improvement_loop`, `model_fitness`,
`pi_collaboration`, `list_peers`, `agent_send`, `context_scout`, `peer`, `runtime_update`,
`image_generate`, `task_automation`, `decision_ledger_read`, and `self_compact`. `delegate`,
`pi_collaboration`, `context_scout`, `peer`, `list_peers`, `agent_send`, and `model_fitness` launch or
address agent/provider worker loops. `memory` and `improvement_loop` mutate root-owned reflection
state, while `secret_store` mutates machine credential/project bindings.
`WORKER_LEAF_LANE_ONLY_FORBIDDEN_TOOLS` adds what the in-process adapter registry never brokers into a
leaf lane (the goal lifecycle, `task_steps`, `pipeline`, `tool_task`, `ask_question`, `skillify`,
`extensionify`, ...); together the two sets are `WORKER_TOOL_ADAPTER_FORBIDDEN_NAMES`. A worker
session's `skill` tool has no `repair` action: the registration is chosen by session role
(`createWorkerSkillVaultToolDefinition`), so a worker cannot rewrite a skill file.

An in-process worker's commands run without the owner's credentials: environment variables whose
name marks a credential (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, ...) are removed from its
shell and python. The owner grants a worker one explicitly by listing the variable names in the host's
launch environment, e.g. `PI_WORKER_PASS_ENV=GH_TOKEN,NPM_TOKEN`; a repository file cannot grant it.
A worker leaves nothing running when it ends: processes still carrying its run marker are stopped and
the session is warned with their command lines, so a durable long-running process is started from the
root (`bash` with `background: true`, inspected with `tool_task`) or requested in the worker's report.

`bash` and `python` are deliberately **not** forbidden. Removing only one execution route would not
create a meaningful filesystem boundary. Pi hard-denies private harness roots for structural
read/write/edit/search calls, but arbitrary process code remains a deliberate host-trust boundary and
can reach any file visible to the OS account. The harness does not claim a process sandbox it does not
have; lane G8/G10 and the land gate remain the backstops for repository integration. What it adds for process tools is attribution, not confinement: every command carries the worker's committer identity, and changes to the protected harness files and files two concurrent workers both changed are recorded and reported to the parent ("Attribution without serialization").

### `worktree_sync` tool scoping for a worker

A worker session's `worktree_sync` calls are narrowed at the tool layer (independent of the engine
-- see the next section):

- `status`, `sync`, `continue`, `abort_sync` and the typed lane actions `git_status`, `git_diff`,
  `git_add`, `git_commit`, `check` stay available unconditionally. The typed actions run fixed argv in
  the worker's own bound lane worktree only, with explicit in-lane paths (`path_outside_lane`
  otherwise), so staging the whole tree and `commit -a` are not expressible through them.
- `create_lane`, `release_lane`, `reconcile` are always refused (`role_forbidden`).
- `land` is refused by default (`role_forbidden`); the new `worktreeSync.workerLand` setting
  (`"deny"` default, `"allow"` opt-in) lets a worker land its own lane when set -- still subject to
  the normal freshness/ownership gates below.
- An explicit `laneKey` that differs from the session's own bound lane is always refused
  (`role_forbidden`): a worker may only ever target its own lane.

### Land/release ownership

`land` and `release_lane` refuse `lane_owner_conflict` when the target lane is owned (its
registration's `ownerSessionId`) by a **different, still-alive** session -- same-host pid liveness,
the same pattern the integration lock and `reconcile` already use. A lane with no recorded owner,
owned by the calling session itself, or whose recorded owner is dead never conflicts. This check is
deliberately engine-level and applies to `land`/`release_lane` ONLY -- `sync`/`continue`/
`abort_sync` are never owner-gated at the engine; a worker's cross-lane containment for those comes
from the tool-layer `laneKey` check above. `release_lane`'s existing G11 discard-confirm requirement
is unaffected: it still applies once ownership no longer conflicts.

### Structural path envelopes

Every worker session wraps structural read/write/edit/grep/find/ls calls in a symlink-safe private-path
envelope. `auth.json`, `MEMORY.md`, `USER.md`, settings/model files, session/state/work roots, and the
active project's `.pi/settings.json` are denied before the underlying tool runs. The positive scope is
empty for an unrestricted worker, meaning arbitrary sibling projects and machine paths remain available
as required by the inherited full-machine profile. A managed Pi worker launched with an explicit profile
`path` receives that path through an immutable startup channel, and the same envelope then denies
structural access outside it.

A second, write-only envelope protects harness resources a worker may read but never write: every
canonical agent-root entry (`skills/`, `extensions/`, `prompts/`, `profiles/`, `state/`, `bin/`,
`keybindings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`, `ESTOP`, ...) except `worktrees/`
(lane working directories), plus the project's `.pi/extensions`, `.pi/SYSTEM.md`,
`.pi/APPEND_SYSTEM.md`, `.husky`, and the repository's `.git/config` and `.git/hooks`
(`getHarnessWriteProtectedPaths`). It applies to a worker process's `write`/`edit` and to an in-process
`delegate` lane's `write`/`edit` before the YOLO, grant and envelope branches, so no mode and no explicit
write scope reaches it. Reads of `skills/` stay allowed. Process tools are not path-confined by it. A change a process tool makes there is detected and attributed to the worker instead (see "Attribution without serialization").

A worker with no explicit grant writes only inside its working directory (`write`/`edit` elsewhere is
denied), in YOLO too (YOLO skips permission prompts, never the write scope); reads stay machine-wide. The root widens the write scope with `delegate` `writePaths` (up to
16 absolute roots) or an owner profile's `writePaths`. A denial tells the worker to finish what is in
scope and report the absolute path it needs, so the root can start a new worker with `writePaths` for
that path. A worker's write scope is fixed when it is created: `delegate start` with `agentId` cannot
widen it (the refusal says to start a new worker with `writePaths`), and a worker persisted before the
cwd-only default resumes with that default.

For a lane-bound session, `edit`/`write` targets are checked against the lane's own worktree root
(`WorktreeLaneGate.checkMutation`'s `targetPath` parameter, resolved by `RuntimeBuilder`'s tool
wrapper via the same `resolveToCwd` the tools themselves use). The check is symlink-safe: the
lane's worktree root and the target are both resolved through `realpath` (walking up to the target's
nearest EXISTING ancestor when the target itself does not exist yet, so a not-yet-created file
cannot be smuggled through a symlink that escapes the lane). A target outside the resolved lane root
is refused (`path_outside_lane`). No active lane record leaves the existing fail-open behavior
unchanged. Arbitrary process code is untouched by the structural envelope and retains the explicit
host-trust semantics described above.

### Zero state/settings footprint

A worker session leaves no footprint in `~/.pi/agent/state` or `settings.json`: every scattered
on-disk store (`ToolPerformanceStore`, `ObservationStore`, `ModelAdaptationStore`, `FitnessStore`,
`ProjectTrustStore`, `SteeringCertificateStore`) takes a `readOnly` constructor option defaulting to `isWorkerSession()`, gated
ABOVE any locking/directory-creation the store's write path performs -- never at the innermost
`writeFileSync` alone, since the lock itself already creates a lockfile and parent directory before
any write. A read-only store still returns the value a real write would have produced (e.g.
`ObservationStore.increment` returns `base + 1`, `ModelAdaptationStore`'s internal `store()` returns
the computed entry) so callers see normal in-memory behavior; nothing durable ever lands on disk.
`SettingsManager`'s single write choke (`enqueueWrite`, used by every settings scope: global,
project, and directory-profile) is gated the same way -- a worker session never writes
`settings.json` in any scope; in-memory settings reads are unaffected since callers update the
in-memory state before reaching the write queue. The same default covers the rest of the shared
state a session would otherwise append to: the failure corpus (`state/failure-corpus.jsonl`), the
tool-recovery event log and per-session stats (`ToolRecoveryLogger` never starts its log worker for a
worker session; counts stay in memory), and the context payload stores (`gc`, `artifacts`, `index`),
which for a worker live in a root inside the process's leased scratch run (`work/scratch/process/<run>/`, removed at session disposal; a killed worker's run is swept by the next process start) instead of under
`work/context/sessions/<id>/`. Startup `reconcile` is skipped in a worker session, and a main
session's pass appends its `reconcile_summary` audit only when it changed something.

The INTENTIONAL artifacts a worker session still produces are its own session transcript, its own
process-matrix entry (see `docs/process-matrix.md`), and its rows in the decision ledger
(`state/decision-ledger.sqlite`), which is an analysis asset kept on every path. Ledger rows are
attributed: every session that writes gets one `session_attribution` row (role, bound lane key,
parent pid) and every session-scoped ledger table is keyed by that session id, so a worker's rows are separable from
the main session's. An in-process `delegate` worker runs inside its owner's process and its provider
requests are the owner's: its perf samples are recorded in the model-adaptation store under a separate
`<model>#lane:worker` key rather than into the owner's own model profile.

## Shared git state, by design

A lane worktree has its own HEAD, index and branch; these live in the repository's **common** git directory and
are shared by every worktree and every worker, on purpose:

- `.git/config` and `.git/hooks`: the write-protected set keeps `write`/`edit` away from them. Hooks that run
  from a worker's git command never rewrite them: `post-checkout` runs `scripts/github-origin.mjs`, which pins
  `gh` to origin in the shared config. It now does nothing for a worker (its environment declares the worker
  role, a worker marker, or a parent pid) and for any lane worktree, so only the owner's own checkout in the
  primary worktree applies the pin. A worker that runs `npm install` with lifecycle scripts triggers husky's
  `prepare`, which sets `core.hooksPath` to the same repository-relative value; install with `--ignore-scripts`
  (the repository rule) to avoid even that.
- `rr-cache`: the rebase engine passes `rerere` and `zdiff3` per command (`git -c`), and git records resolutions
  in `<common-dir>/rr-cache`, shared so a conflict resolved in one lane is replayed in another. Resolutions are
  content-keyed, not per worker.
- `refs/stash`: one stash per repository. A worker's `git stash` is attributable through its reflog committer,
  but a stash is the one shared ref that is not lane-scoped; use lane commits instead.
- `<common-dir>/pi-ci/<branch>.json` and `events.log`: the CI verdict that the next commit's pre-commit gate
  reads, written by the detached watcher the pre-push hook starts. A worker's `git push` (for example under
  YOLO) therefore records `pushedBy` with its label; the watcher writes only these files. The pre-commit hook
  (`scripts/precommit-staged.mjs`) reads them and runs staged-scoped checks; it writes nothing shared.
- `<common-dir>/pi-worktree-sync/`: the lane registry, epoch, integration lock and audit log, the engine's own
  store, written under the lifecycle and integration locks.

## Trust boundary (honest, not faked)

- **`pi` children are hard-gated**: G8/G10 run in core code, wrapped under the file-mutation
  tools of any lane-bound `pi` session — a stale mutation or a direct write to main is refused
  structurally, not by prompt compliance.
- **Foreign CLIs (agy/claude/codex/custom) are cooperative only**: their internal tool
  loop is that CLI's own responsibility; the harness cannot enforce G8/G10 inside a process it
  does not control. Sync directives can still be delivered to an idle foreign pane via the collaboration
  extension's existing `send_followup`, but compliance is not guaranteed.
- **The land gate (G1–G7) is the backstop that cannot be evaded by either kind of worker**: no
  matter how a lane got dirty, stale, or ignored a notification, `land` re-derives freshness and
  cleanliness from git itself while holding the integration lock. A stale or dirty lane cannot
  land, full stop.
