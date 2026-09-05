# Persistent provider collaboration

The packaged `pi-collaboration` extension exposes `pi_collaboration` and `/pi-collaboration`. Its provider-neutral coordinator owns job admission, persistent turns and parent handoffs; Herdr owns interactive terminal sessions. Native model CLIs are not headless subprocesses.

## Enable

Bundled extensions load when an active resource profile grants them:

```json
{
  "activeResourceProfiles": ["collaboration"],
  "resourceProfiles": {
    "collaboration": {
      "extensions": { "allow": ["pi-collaboration"] }
    }
  }
}
```

`--no-extensions` disables the extension. Its implementation, templates and documentation ship with the package; no user-level extension copy is required.

## Native sessions and admission

`status` checks installed Pi, Codex, Claude and agy executables and native login evidence. Installation, authentication and interactive readiness are separate conditions. A local login check cannot guarantee that the server has not revoked access. Additional providers implement an explicit native authentication strategy.

Default Pi workers use the stable launcher of the running harness, including its source loader arguments and package environment; source runs do not silently launch an older PATH installation. Explicit Pi wrappers are labeled `external-cli` and must provide the same native activity bridge to accept tasks. Pi admission requires a source-scoped readiness report after interactive input is initialized; inferred idle screens and older wrappers without that bridge fail bounded readiness checks. No default launch adds `--verbose`.

`workspace_plan` previews; `launch_workspace` opens idle persistent sessions; `fire_task` also submits a task. Missing Herdr is provisioned from pinned, checksum-verified release assets. `guard` checks provisioning without starting a server. PATH exposure uses a writable, user-owned directory already on PATH and never replaces another executable. The returned `globalPath` field distinguishes global exposure from a managed absolute executable path.

Provide each `agents` entry with a distinct `task` responsibility when launching a team against one objective. The default team separates implementation, validation and review. `command` accepts a structured native executable/wrapper plus arguments and leading environment assignments. Authentication probes that same executable, environment and working directory. Shell pipelines are not inferred to be authenticated native providers. `model` selects a native model; `apiProvider` is Pi-only. Conflicting selectors and unprobed authentication overrides fail admission. Do not put credentials in arguments or environment specifications because job configuration persists.

Pi workers inherit immutable eligible tools, resource filters and thinking levels. `path` narrows Pi's structured filesystem tools; a foreign CLI's path only sets cwd. `tools`, `resourceProfile`, `thinkingLevel` and `worktreeLane` are Pi-only. A follow-up changes instructions, never the admitted profile.

Native Pi tasks require an already-granted `bash` or `python` tool to submit peer/result commands (`bash` uses the platform's configured shell). Admission never adds that permission. A shell-free idle workspace may be opened, but cannot accept this command-dependent task protocol; use ordinary delegation for shell-free workers.

By explicit execution policy, Claude and agy receive `--dangerously-skip-permissions`; Codex receives `--dangerously-bypass-approvals-and-sandbox`. These are unrestricted host processes. Pi does not claim to enforce native foreign tools, token budgets or OS sandboxing.

## Work and question boundaries

Thinking, tool activity and progress remain inside each native CLI. The worker submits final evidence through its authenticated command: `current` retrieves the current dispatch identity, then `report <turnId> <done|blocked> <quoted-evidence> [optional-usage-json]` stores one bounded immutable claim. Exact retries are idempotent; stale identities or conflicting reports are rejected. Reporting does not publish a terminal event or declare the native process stopped.

The controller separately awaits a stopped-work event, then rechecks the same pane occupant, state sequence and agent revision before accepting the exact-turn claim. Herdr's snapshot revision is not an agent-state version and cannot establish this fence. Printed markers, prompt echoes and TUI footers never prove success. Truncated terminal display does not invalidate a separately authenticated claim. Missing claims require review; native blocked/question state takes precedence over a claimed success.

A stopped worker's question reaches the owning parent immediately even if another teammate is still working. `answer_question` targets its `jobId` and `agentId`, with `answer.text` or `answer.keys`. It resumes the original task in the same native context, with a fresh dispatch identity; the worker must query `current` again before reporting. `send_followup` starts another task in that same persistent session.

Native Pi dialog questions have a separate authenticated, exact-turn pending record, including option labels, descriptions and multiple-selection instructions. This record is not a final result claim and cannot finish work without native blocked-state evidence. Its 8 KiB bound produces an explicit incomplete-preview warning for oversized questions; the parent must not answer from missing context. A native dialog receives input directly. A textual question from an already idle agent receives a continuation prompt in the same session; keys-only answers require an actual blocked dialog. Routing is decided before input, with no fallback after an uncertain write.

Dispatch and terminal records use the existing managed-lane ledger and durable outbox. Every collaboration terminal carries its dispatch sequence; stale results cannot complete a newer turn. Handoff acknowledgment is recorded only after the parent accepts the event. Worker output remains an untrusted claim, not independent verification. Optional cooperative usage claims are advisory, not enforceable native-process billing.

No output polling discovers completion. Finite control helpers emit process-exit signals and persist bounded handoffs; parent filesystem events reconcile those records. A disconnected helper never blindly resubmits a prompt. Deadlines stop only the exact owned pane. Failed cleanup keeps the turn fenced; a bounded cleanup ladder cannot report stopped work without stop evidence.

## Peer communication and reattachment

Each native worker receives a portable command for sending a bounded message to another member of its own team. A message identity is idempotent: exact repeats return the same receipt, while changed content under the same identity is rejected. The mailbox holds at most 32 queued messages of 4 KiB each and 128 lifetime receipts. Raw peer credentials are injected into the worker environment, not stored in the job. They prevent accidental cross-team submission, not access by another unrestricted host process.

The existing turn coordinator delivers queued messages after the recipient is idle and its previous terminal handoff has been acknowledged. It never interrupts a pending question or running task. An uncertain delivery consumes its receipt and is not automatically requeued. Closing or reloading the parent detaches its observer; already admitted helpers continue and persist results for the same parent session to recover.

Herdr's `Ctrl+B`, then `q` detaches its client. `herdr --session <sessionName>` reattaches to the retained server and native terminals; this does not restart agents or resend tasks. It is distinct from terminating the server or rebooting. Managed automatic daemon restore is disabled because that backend path does not preserve the complete admitted arguments and environment. A server failure is surfaced as a control failure, not proof of task completion or permission to recreate an uncertain turn.

Parent restoration runs one bounded native-identity reconciliation, with at most four concurrent status checks. Missing servers or replaced occupants produce durable control notices without waiting for the work deadline. Queued peer messages remain queued for unavailable jobs. An explicit `job_status` inspection can recheck connectivity and resume queued delivery once the existing identities are verified. No output polling or automatic native-session recreation is involved.

## Inspection and cleanup

Use `job_status` or `list_jobs` for bounded records, `set_variable`/`list_variables` for team decisions, and `list_templates`/`show_template` for JSON templates. Custom templates in the managed collaboration state's `templates` directory override bundled names.

`stop_job` and `stop_session` preview by default. Actual termination requires `dryRun:false, confirm:"yes-collaboration-stop"`; it closes the job's exact owned agent panes, not an entire daemon that may hold unrelated terminals. `dismiss` ends tracking without killing an idle native session; active work must be stopped first. `archive_job` moves eligible records into a bounded recoverable archive. Reusing a `launchKey` with `force:true` requires the previous native agents to be closed.

Limits are explicit: 12 agents/job, 128 turns/agent, 32 retained jobs and 32 archive records, 1 MiB/job, bounded prompts and handoff evidence. Hitting a bound refuses further admission; it does not silently drop active work. Native conversations remain owned by their respective CLIs and Herdr.

## Goal dispatch and migration

`goal` action `dispatch_worker` accepts `dispatchTarget:"collaboration"`. It dispatches one Pi worker and binds the requirement to the existing managed lane. Backend preflight precedes worktree creation. An uncertain external launch never falls back to a second native delegation.

Replace old extension/tool settings with `pi-collaboration` / `pi_collaboration`; no competing alias remains. Existing unrelated terminal sessions are never adopted or killed. Linux checks do not establish native Windows lifecycle correctness, and mocked provider tests do not establish account-specific live inference behavior.
