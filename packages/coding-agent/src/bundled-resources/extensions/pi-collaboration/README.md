# Persistent collaboration

Enable the packaged extension with `extensions.allow: ["pi-collaboration"]` in a resource profile. The tool is `pi_collaboration`; the command is `/pi-collaboration`. Herdr is the terminal backend, behind a provider-neutral interface.

## Lifecycle

`status` discovers installed/authenticated Pi, Codex, Claude, and agy CLIs. `fire_task` starts a bounded team of persistent interactive sessions; `launch_workspace` starts the sessions without submitting a task. `workspace_plan` and `dryRun:true` preview the plan. Missing Herdr is installed from pinned, checksum-verified release assets.

Worker thoughts, progress, and tool text stay in the worker. Only a stopped-work terminal event or question/blocker wakes the owning parent. Idle and printed markers are not proof of success: an authenticated exact-turn result claim and stopped agent identity must match. Reporting alone never publishes completion. Results remain untrusted claims for parent review.

Use `answer_question` with the same `jobId`/`agentId` and `answer.text` or `answer.keys` to respond to a question. Use `send_followup` for another task. Both reuse the persistent CLI and its context. Answers mint a fresh dispatch identity; workers query their authenticated `current` command again before `report`. A disconnected controller never blindly resubmits an uncertain prompt.

Pi dialog questions retain bounded authenticated question/choice context separately from final reports. Native dialogs receive direct input; textual questions from idle agents receive a continuation prompt. Keys-only answers require a blocked dialog. Oversized question context is explicitly marked incomplete, never silently treated as sufficient to answer.

`job_status`, `list_jobs`, `set_variable`, and `list_variables` expose bounded state. `notify`, `set_status`, and `clear_status` affect display metadata, not task completion. `list_templates` and `show_template` load the single JSON template source.

`stop_job`/`stop_session` preview by default; use `dryRun:false, confirm:"yes-collaboration-stop"` to close the exact owned agent panes, not unrelated terminals or the whole daemon. `dismiss` ends tracking without terminating an idle native CLI; active work must first stop. Closing a controller alone is not proof that its worker stopped.

Team launches require distinct per-agent `task` responsibilities. Native workers receive a portable, authenticated peer mailbox command; queued messages reuse the same turn owner once a recipient is idle. Herdr client detach (`Ctrl+B`, then `q`) and reattach (`herdr --session <sessionName>`) preserve live agents. Server termination is a separate failure boundary; an uncertain task is never blindly resubmitted. See the packaged `docs/pi-collaboration.md` for recovery and retention limits.

## Execution policy

By explicit user policy, collaboration launches use:

- Claude and agy: `--dangerously-skip-permissions`.
- Codex: `--dangerously-bypass-approvals-and-sandbox`.

These are unrestricted host processes. Pi cannot enforce its tool permissions or token budget inside a foreign CLI. Installed executable, credential readiness, and interactive readiness are separate checks; local authentication status cannot guarantee server-side credentials have not been revoked.

Pi workers inherit immutable host-derived tool/resource/thinking profiles. Tasks require an already-granted `bash` or `python` tool for peer/result commands; admission never widens a shell-free profile. An explicit `path` narrows Pi's structured file tools; foreign CLI paths only set cwd. Default Pi launches use the current harness's stable launcher, not an older PATH binary. Explicit Pi wrappers must implement the same source-scoped native readiness bridge; a guessed idle screen cannot admit work. No default launch adds `--verbose`. Additional providers require an explicit authentication/launch strategy; unknown executables are never assumed authenticated.

All implementation and resources ship in this package. Job/turn projection uses bounded atomic storage under `work/background/pi-collaboration/state`; the existing managed-worker lifecycle owns grants, terminal claims, and parent notifications. Native conversations are retained by their respective CLIs and Herdr. Do not include secrets in task text, answers, commands, or environment specifications.

## Migration

Replace the old extension/tool configuration with `pi-collaboration` / `pi_collaboration`; no competing tool alias remains. Goal dispatch uses `dispatchTarget:"collaboration"`. Existing unrelated terminal sessions are not adopted or killed. Native Windows process/terminal behavior requires platform verification; Linux-only tests do not establish cross-platform production readiness.
