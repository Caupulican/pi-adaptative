# Pi Adaptative Workflow Lifecycle & Autonomy Architecture Review

**Date**: 2026-08-17  
**Scope**: Autonomous workflow lifecycle, delegation & write reservations, background tool tasks, session compaction, goals & pipelines, task checklists, and capability gating.

---

## Executive Summary

A deep audit across core subsystems was conducted to identify workflow lifecycle bugs, concurrency race conditions, unhandled terminal states, and security gating defects that would block user experience or autonomous operation in the upcoming release.

A total of **15 concrete defects** were discovered and categorized into four architectural domains:
1. **Worker Delegation & Write Reservations** (2 findings)
2. **Session Runtime, Background Tasks & Compaction** (5 findings)
3. **Goals, Pipelines & Task Checklists** (5 findings)
4. **Autonomy Gating & Security Envelope** (3 findings)

---

## 1. Worker Delegation & Write Reservation Subsystem

### 1.1. Pre-Yield Deadlock Check Prevents Intended Reservation Yielding
- **Files**:
  - `packages/coding-agent/src/core/delegation/worker-agent-control-coordinator.ts:1324-1341`
  - `packages/coding-agent/src/core/delegation/worker-delegation-controller.ts:1145-1159`
- **Root Cause**:
  In `waitForWorkerAgents()`, `waitBlockedByCaller` runs *before* `yieldCallerForWait`:
  ```ts
  const blockedAgentIdSet = new Set(this.options.waitBlockedByCaller?.(callerAgentId, canonicalAgentIds) ?? []);
  const blockedAgentIds = canonicalAgentIds.filter(
      (agentId) => activeAgentIds.has(agentId) && blockedAgentIdSet.has(agentId)
  );
  if (blockedAgentIds.length > 0) {
      hasFailure = true;
      failure = new Error(`Worker wait would deadlock: ${blockedAgentIds.join(", ")} is blocked by the caller's write reservation.`);
  }
  ```
  `yieldWorkerForWait` was designed specifically to yield the parent's write reservation so blocked child workers can acquire it and run. Because the check inspects `blockedByLocalLaneIds` before yielding, parent workers waiting on their own delegated children are immediately rejected with a false deadlock error.
- **Impact**: Parent workers cannot wait on child workers that require write access in overlapping directory scopes.
- **Remediation**: Allow `yieldCallerForWait()` to release the reservation before verifying whether non-yieldable third-party locks or circular dependencies exist.

---

### 1.2. `SessionRootMailbox.waitForReplies` Drops Out-of-Process Worker Replies on Timeout
- **Files**:
  - `packages/coding-agent/src/core/delegation/session-root-mailbox.ts:664-669`
- **Root Cause**:
  `subscribe()` only registers in-memory listeners within the current Node process (`listenersByMailboxFile`). When a cross-process worker writes a reply to disk, no in-process event fires. When the timeout timer triggers:
  ```ts
  timeoutTimer = setTimeout(() => {
      settled = true;
      cleanup();
      resolve({ replies: [], timedOut: true });
  }, boundedTimeoutMs);
  ```
  It resolves with an empty list without querying `currentReplies()`.
- **Impact**: Any reply written by an out-of-process worker before timeout expiry is discarded from the wait result.
- **Remediation**: Perform a final `currentReplies()` disk query in the timeout settlement handler prior to resolving.

---

## 2. Session Runtime, Background Tasks & Compaction

### 2.1. Terminal Handoff Notification Races with Active Compaction
- **Files**:
  - `packages/coding-agent/src/core/compaction-controller.ts:296-298, 540-703`
  - `packages/coding-agent/src/core/foreground-recovery-controller.ts:95-117`
  - `packages/coding-agent/src/core/foreground-terminal-handoff-controller.ts:104, 154`
- **Root Cause**:
  `CompactionController.compact()` and `runAutoOnce()` run multi-step summarization loops (`runCompactionLoop`) without acquiring a `ForegroundSubmissionLease`. `ForegroundRecoveryController.isBusy` only checks active streaming and prompt runs, but does not check `isCompacting`.
  When a background task or worker completes during compaction:
  1. `ForegroundTerminalHandoffController` acquires a submission lease and starts a prompt turn.
  2. In auto-compaction, when `runCompactionLoop` finishes, `refreshAfterCompaction()` executes:
     `this.agent.state.messages = this.sessionManager.buildSessionContext().messages;`
     This clobbers the active `agent.state.messages` mid-stream while the model is generating responses.
  3. In manual compaction, `disconnectAgent()` leaves the new turn's events unlistened to, causing custom message turns to reject.
- **Impact**: Turn message context corruption, dropped prompt responses, and token/state desynchronization.
- **Remediation**: Include `isCompacting` in `ForegroundRecoveryController.isBusy` and withhold submission lease acquisition until compaction completes.

---

### 2.2. Submission Lease Leak on `startCustomMessageTurn` Rejection
- **Files**:
  - `packages/coding-agent/src/core/foreground-terminal-handoff-controller.ts:104-148`
  - `packages/coding-agent/src/core/foreground-recovery-controller.ts:164-171`
- **Root Cause**:
  In `notifyWorkers` and `notifyTools`, if `startCustomMessageTurn` rejects before persisting (e.g. model authentication error or disconnected agent), the `finally` block calls `releaseSubmission(lease)`.
  However, inside `ForegroundRecoveryController`, `activeRuns` is still 1 during unwinding. `releaseSubmission` throws:
  `Error: Cannot release foreground submission authority while its agent run is active`
  This leaves `this.submissionLease` permanently populated.
- **Impact**: Permanent session deadlock; all future user prompts and handoffs hang forever in `acquireSubmission()`.
- **Remediation**: Gracefully queue or force release of the submission lease when the prompt initiation fails.

---

### 2.3. Branching/Forking Drops Historical Background Tasks & Resets ID Counter
- **Files**:
  - `packages/coding-agent/src/core/background-tool-task-controller.ts:480, 489`
  - `packages/agent/src/session/session-manager.ts:2117`
- **Root Cause**:
  When a session is branched, historical entries retain the parent `sessionId`. `restorePersistedTasks()` filters entries matching `value.sessionId === sessionId`, skipping all prior `background_tool_task` records. Consequently, `highestTaskNumber` resets to 0.
- **Impact**:
  1. New background tool tasks in the branched session start at `tool-task-1`, colliding with historical task IDs.
  2. `tool_task action="wait"` on pre-branch tasks throws `Unknown background tool task`.
  3. Evidence validation fails to verify historical tasks.
- **Remediation**: Inspect all active branch entries or parse ancestor task IDs when calculating `highestTaskNumber` on restore.

---

### 2.4. `PersistentProcessCoordinator` Drops Trailing Stdout/Stderr on Fast Exit
- **Files**:
  - `packages/coding-agent/src/core/tools/persistent-process-coordinator.ts:63-86`
- **Root Cause**:
  On child `exit`, `setImmediate` executes `this.clear(child)`, setting `this.currentChild = null`. Buffered `data` events arriving from the stream before `close` fail the `this.currentChild === child` guard and are silently dropped.
- **Impact**: Fast-exiting CLI commands (unit tests, git queries, scripts) drop their final lines of output.
- **Remediation**: Settle the execution promise and clear `currentChild` only when stdio streams emit `close` / reach EOF.

---

### 2.5. Pre-Aborted Signal Ignored During Shell Engine Cold Spawn
- **Files**:
  - `packages/coding-agent/src/core/tools/shell-session.ts:240, 393`
  - `packages/coding-agent/src/core/tools/windows-shell-engine.ts:219, 268`
- **Root Cause**:
  After awaiting `spawnChild` / `ensureChild`, the coordinator registers `signal.addEventListener("abort", onAbort)`. In DOM/Node `EventTarget`, adding a listener to an already-aborted signal does not fire the callback. Neither engine checks `if (signal?.aborted) onAbort()`.
- **Impact**: Commands aborted during shell initialization continue executing in the background, and the UI hangs until the timeout expires.
- **Remediation**: Add an explicit `if (signal?.aborted) onAbort()` check immediately after listener registration.

---

## 3. Goals, Pipelines & Task Checklists

### 3.1. Goal Auto-Continuation Permanent Dormancy after Turn Cap
- **Files**:
  - `packages/coding-agent/src/core/goals/goal-auto-continue-controller.ts:95-113`
- **Root Cause**:
  When `runScheduled()` completes its batch of `goalContinueTurns` (`stopReason === "max_turns_reached"`), it resets `_isContinuing = false`. However, it never calls `scheduleFromIdle()` to arm the next timer.
- **Impact**: Autonomous goal execution halts after the first batch of turns, requiring manual user intervention to resume.
- **Remediation**: If the goal remains active (`snapshot.continuation.action === "continue"`), re-arm `scheduleFromIdle()` upon completing a scheduled batch.

---

### 3.2. `reopen_requirement` Omits `progressRevision` Bump, Forcing False Stall
- **Files**:
  - `packages/coding-agent/src/core/goals/goal-state.ts:483-493`
  - `packages/coding-agent/src/core/goals/goal-session-controller.ts:267-275`
- **Root Cause**:
  `reopen_requirement` resets `stallTurns = 0` but fails to increment `progressRevision`. In `persistContinuationPass()`, `state.progressRevision <= pass.progressRevision` evaluates to true, causing the host to immediately apply a `no_progress` penalty.
- **Impact**: An agent is penalized with a stall turn on the exact step it makes progress by reopening a requirement.
- **Remediation**: Increment `newState.progressRevision = (state.progressRevision ?? 0) + 1` in the `reopen_requirement` reducer.

---

### 3.3. Phantom Continuation Turn Charged on Token Floor Rejection
- **Files**:
  - `packages/coding-agent/src/core/goal-loop-controller.ts:153-169`
- **Root Cause**:
  When `admitProviderRequest` rejects with `GoalBudgetExhaustedError` before turn admission, `continueGoalLoop` catches the error, increments `turnsSubmitted++`, and persists `turns: 1` in pass accounting.
- **Impact**: Goal accounting records a completed provider turn when zero provider calls were made.
- **Remediation**: Avoid incrementing `turnsSubmitted` and recording pass accounting when admission fails prior to execution.

---

### 3.4. Pipeline Increment Deadlocked by Future Open Task Steps
- **Files**:
  - `packages/coding-agent/src/core/pipelines/increment.ts:28-34, 45-50`
- **Root Cause**:
  `linkedOpenStepIds` checks whether *any* open task step in the session references *any* requirement of the goal.
- **Impact**: Pending task steps defined for future pipeline stages block `pipeline increment` on the current stage.
- **Remediation**: Scope open step verification to requirements linked to the specific stage being completed.

---

### 3.5. Pipeline Stage Scanner Rejects Directory Artifacts
- **Files**:
  - `packages/coding-agent/src/core/pipelines/run-state.ts:22-39`
- **Root Cause**:
  `scanStageOutput()` filters entries strictly with `statSync(path).isFile()`, ignoring subdirectories and nested files.
- **Impact**: Stages outputting directory structures (`output/dist/`, `output/src/`) are treated as empty, preventing stage advancement.
- **Remediation**: Recursively discover nested files or treat subdirectories as valid stage artifacts.

---

### 3.6. Standalone Pipelines Block Unrelated Goals
- **Files**:
  - `packages/coding-agent/src/core/goals/goal-tool-core.ts:349-358`
- **Root Cause**:
  When checking active pipelines before goal completion, `!activePipeline.goalId` is treated as joined to the goal.
- **Impact**: An unlinked background pipeline prevents unrelated interactive goals from completing.
- **Remediation**: Require `activePipeline.goalId === state.goalId` before blocking goal completion.

---

### 3.7. `advanceTaskSteps` Halts on Blocked Steps & Falsely Claims Completion
- **Files**:
  - `packages/coding-agent/src/core/pipelines/increment.ts:123-147`
- **Root Cause**:
  In `advanceTaskSteps()`, if the step following the current step is `blocked`, `following.status === "pending"` is false. The function falls through to return `completed: true, detail: "No further pending steps."`.
- **Impact**: Checklists with blocked intermediate steps are prematurely marked complete, stalling subsequent pending steps.
- **Remediation**: Return `completed: false` with blocked details when the following step is `blocked`.

---

## 4. Autonomy Gating & Security Envelope

### 4.1. Core Tools Blocked by `unknown_tool_capability` Under Capability Envelopes
- **Files**:
  - `packages/coding-agent/src/core/autonomy/gates.ts:194-201`
  - `packages/coding-agent/src/core/tool-capability-policy.ts:26-44`
- **Root Cause**:
  `evaluateToolGate` enforces `hasCapabilityPolicyForTool(toolName)`. `TOOL_CAPABILITY_POLICIES` lacks classifications for `task_steps`, `pipeline`, `tool_task`, `worktree_sync`, `ask_question`, `artifact_retrieve`, and `context_scout`.
- **Impact**: In any subagent or session with an active `CapabilityEnvelope`, invoking these tools is blocked with `unknown_tool_capability`.
- **Remediation**: Add explicit capability policies for all built-in core harness tools in `tool-capability-policy.ts`.

---

### 4.2. `evaluateToolGate` Bypasses `deniedPaths` and Blocks Empty `allowedPaths`
- **Files**:
  - `packages/coding-agent/src/core/autonomy/gates.ts:72-103, 142-191`
  - `packages/coding-agent/src/core/autonomy/envelope-enforcement.ts:45-68`
- **Root Cause**:
  1. `extractCandidatePaths` only checks `obj.path` for 6 tools, ignoring `directory`, `paths`, `file_path`, `cwd`, and `target`.
  2. The path gate in `gates.ts:143` is conditioned on `if (paths.length > 0 && envelope.allowedPaths)`. If `allowedPaths` is omitted (open workspace with denylist), `deniedPaths` is never checked.
  3. If `allowedPaths` is `[]`, `gates.ts` executes zero iterations and returns `path_outside_allowed_roots`, blocking all tool calls.
- **Impact**: Sensitive files in `deniedPaths` (e.g. `.git`, credentials) are unprotected when `allowedPaths` is omitted; open workspaces with `allowedPaths: []` are completely non-functional.
- **Remediation**: Align `gates.ts` with `envelope-enforcement.ts`: extract all path arguments, check `deniedPaths` first, and treat empty/absent `allowedPaths` as unrestricted workspace access.

---

## 5. Priority & Remediation Plan

| Priority | Issue ID | Area | Action |
|:---|:---|:---|:---|
| **P0 - Critical** | **1.1** | Delegation | Fix pre-yield deadlock check in `worker-agent-control-coordinator.ts` |
| **P0 - Critical** | **2.1** | Compaction | Gate submission leases in `ForegroundRecoveryController` during active compaction |
| **P0 - Critical** | **2.2** | Session | Prevent submission lease leak on custom message turn rejection |
| **P0 - Critical** | **4.1** | Autonomy | Register core tools in `TOOL_CAPABILITY_POLICIES` to unblock envelope execution |
| **P0 - Critical** | **4.2** | Autonomy | Fix `deniedPaths` bypass and `allowedPaths: []` blanket block in `evaluateToolGate` |
| **P1 - High** | **3.1** | Goals | Reschedule `scheduleFromIdle` after `runScheduled` reaches batch turn cap |
| **P1 - High** | **3.2** | Goals | Bump `progressRevision` on `reopen_requirement` to eliminate false stalls |
| **P1 - High** | **3.7** | Tasks | Fix `advanceTaskSteps` to not declare completion on blocked steps |
| **P1 - High** | **2.3** | Tasks | Fix task ID collision and loss on session fork/branch |
| **P1 - High** | **2.4** | Processes | Defer process settlement to stream `close` in `PersistentProcessCoordinator` |
| **P2 - Medium** | **1.2** | Mailbox | Perform final disk read on `SessionRootMailbox.waitForReplies` timeout |
| **P2 - Medium** | **2.5** | Shell | Handle pre-aborted signals during cold shell engine spawn |
| **P2 - Medium** | **3.3** | Goals | Prevent phantom turn charge on token floor rejection |
| **P2 - Medium** | **3.4** | Pipelines | Scope pipeline open task step check to current stage requirements |
| **P2 - Medium** | **3.5** | Pipelines | Support directory outputs in `scanStageOutput` |
| **P2 - Medium** | **3.6** | Goals | Scope pipeline completion gate strictly to linked goal IDs |
