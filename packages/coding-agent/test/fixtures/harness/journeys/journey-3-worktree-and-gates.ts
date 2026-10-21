import "../builtin-install.ts";
import { basename } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { canonicalPathScopeIdentity } from "../../../../src/core/autonomy/path-scope.ts";
import { WorkerConversationStore } from "../../../../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../../../../src/core/delegation/worker-lifecycle.ts";
import { WorkerRecoveryCoordinator } from "../../../../src/core/delegation/worker-recovery-coordinator.ts";
import {
	applyGoalEvent,
	createGoalState,
	type GoalEvent,
	type GoalState,
} from "../../../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import {
	WIN32_TRANSIENT_RETRY_MAX_MS,
	WIN32_TRANSIENT_RETRY_MIN_MS,
} from "../../../../src/core/util/win32-transient-fs.ts";
import { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import type { ScriptedRequest, ScriptStep } from "../scripted-provider.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, harnessPath, projectPath, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	agentIdForTrack,
	assertBatchOk,
	assertRefused,
	bindE0Completion,
	bindE0Request,
	COMPLETION_REQUIREMENT_TEXT,
	type ConversationRecord,
	CRITERION_STATEMENT_PREFIX,
	checkCompletionItems,
	checkEvidenceMarkers,
	conflictBlockIn,
	currentRequestCarries,
	durableGoalEvidenceIds,
	dynamicCalls,
	type E0Counters,
	evidenceIdsOf,
	expectOwnerWords,
	isGateCommandRefusal,
	isStaleRefusal,
	LIMITS_PATH,
	lanesOf,
	lastToolResultDetails,
	latestAgentIdForTrack,
	latestBatchResults,
	legendLinesOf,
	legendPath,
	matchedSubmitReceipt,
	OWNER_DRAFT_DIRTY,
	requirementIdOf,
	toolOutcomes,
	utf8Text,
	zeroE0Counters,
} from "./shared.ts";

export async function runJourney3WorktreeAndGatesPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const integrated = createBarrier();
	const workerMayEdit = createBarrier();
	const handedOff = createBarrier();
	let rootSession: AgentSession | undefined;
	let workerLaneKey: string | undefined;
	let mainBeforeRefusal: string | undefined;
	let mainBeforeStale: string | undefined;
	let mainAfterLand: string | undefined;
	let legendAtIntegration: string[] = [];
	const sessionOf = (): AgentSession => {
		if (rootSession === undefined) throw new Error("the root session is not created yet");
		return rootSession;
	};
	const laneKeyOrThrow = (): string => {
		if (workerLaneKey === undefined) throw new Error("the worker lane key was not read from the status details");
		return workerLaneKey;
	};
	const checkoutHandoffs = (request: ScriptedRequest): void => {
		if (!JSON.stringify(request.context.messages).includes("Background worker terminal handoff")) {
			throw new Error("the worker's terminal handoff is not in the root turn");
		}
	};
	// The worker: held at its first request until the root has committed its own lane; then edits its lane and reports.
	world.provider.enqueue(
		"worker-a",
		{
			name: "worker-edit",
			gate: workerMayEdit.promise,
			reply: {
				content: [
					{
						type: "toolCall",
						id: "worker-edit-1",
						name: "edit",
						arguments: {
							path: "src/limits.ts",
							edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		calls("worker-report", [
			{
				id: "worker-report-1",
				name: "submit_report",
				arguments: {
					status: "completed",
					summary: "Set MAX_RETRIES to 5 in my lane.",
					changes: [{ file: "src/limits.ts", what: "Raises MAX_RETRIES to 5 in the retries lane." }],
				},
			},
		]),
	);
	// Prompt one: the root creates its two lanes, starts the worker on the request-visible retries checkout, reads the lane
	// identities from the structured status, and works its own lane while the worker is held at its first request.
	world.provider.enqueue(
		"root",
		calls("goal-start", [
			{
				id: "goal-1",
				name: "goal",
				arguments: {
					action: "start",
					goalId: "retries-goal",
					userGoal: "Set MAX_RETRIES to 5 and keep the owner's draft.",
				},
			},
		]),
		calls("create-rootwork-lane", [
			{
				id: "lane-rootwork",
				name: "worktree_sync",
				arguments: { action: "create_lane", laneKey: "rootwork", goalId: "retries-goal" },
			},
		]),
		calls("create-retries-lane", [
			{
				id: "lane-retries",
				name: "worktree_sync",
				arguments: { action: "create_lane", laneKey: "retries", goalId: "retries-goal" },
			},
		]),
		dynamicCalls(
			"start-worker",
			(request) => {
				const retries = legendPath(request, "p/retries");
				return [
					{
						id: "start-worker-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							path: retries,
							writePaths: [`${retries}/src/limits.ts`],
							instructions: "Set MAX_RETRIES to 5 in src/limits.ts of your checkout, then submit your report.",
						},
					},
				];
			},
			(request) => assertBatchOk(request, "create-retries-lane"),
		),
		{
			name: "status-admitted",
			check: (request) => {
				assertBatchOk(request, "start-worker");
				if (!latestBatchResults(request).some((result) => result.text.includes("delegate started (running)"))) {
					throw new Error("the worker was not admitted");
				}
			},
			reply: {
				content: [
					{ type: "toolCall", id: "status-1", name: "worktree_sync", arguments: { action: "status" } },
					{
						type: "toolCall",
						id: "mixed-read-fail-j3",
						name: "read",
						arguments: { path: projectPath("src", "does-not-exist.ts") },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "identities-checked",
			check: (request) => {
				// The batch is mixed on purpose: the status must succeed, and the missing-file read must be the one refused call.
				const statusBatch = latestBatchResults(request);
				if (statusBatch.some((result) => result.toolName === "worktree_sync" && result.isError))
					throw new Error(`status-admitted: the worktree status failed: ${JSON.stringify(statusBatch)}`);
				if (!statusBatch.some((result) => result.toolName === "read" && result.isError))
					throw new Error(`the mixed batch's missing-file read did not fail: ${JSON.stringify(statusBatch)}`);
				const details = lastToolResultDetails(sessionOf(), "worktree_sync");
				// Structured output round-trips: no credential placeholder replaces a lane key or path.
				if (JSON.stringify(details).includes("<mocked:")) {
					throw new Error(`the status details carry a redacted field: ${JSON.stringify(details)}`);
				}
				const lanes = lanesOf(details);
				const agent = agentIdForTrack(request, "worker-a");
				const retries = legendPath(request, "p/retries");
				const bound = lanes.filter((lane) => lane.boundLaneId !== undefined);
				const root = lanes.filter((lane) => lane.boundLaneId === undefined);
				if (lanes.length !== 2 || bound.length !== 1 || bound[0]?.boundLaneId !== agent) {
					throw new Error(`worker and root lanes are not separate: ${JSON.stringify(lanes)} agent ${agent}`);
				}
				if (bound[0]?.laneKey !== "retries" || bound[0]?.worktreePath !== retries) {
					throw new Error(`the worker is not bound to its requested checkout: ${JSON.stringify(bound)}`);
				}
				if (root[0]?.laneKey !== "rootwork")
					throw new Error(`the root lane is not rootwork: ${JSON.stringify(root)}`);
				// The lane key is read back from the structured output, and later steps use that value.
				workerLaneKey = bound[0].laneKey;
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "alias-negative-1",
						name: "edit",
						arguments: {
							path: "p/rootwork/src/limits.ts",
							edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 4" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		dynamicCalls(
			"edit-rootwork",
			(request) => [
				{
					id: "edit-rootwork-1",
					name: "edit",
					arguments: {
						path: `${legendPath(request, "p/rootwork")}/src/limits.ts`,
						edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 4" }],
					},
				},
			],
			(request) => assertRefused(request, "the extrapolated alias", "Unminted path alias"),
		),
		calls("commit-rootwork", [
			{
				id: "add-rootwork",
				name: "worktree_sync",
				arguments: { action: "git_add", laneKey: "rootwork", paths: ["src/limits.ts"] },
			},
			{
				id: "commit-rootwork",
				name: "worktree_sync",
				arguments: { action: "git_commit", laneKey: "rootwork", message: "Raise MAX_RETRIES to 4" },
			},
		]),
		{
			name: "rootwork-committed",
			check: (request) => {
				assertBatchOk(request, "commit-rootwork");
				// The worker is released only now: its lane edit overlaps the root's committed lane work.
				workerMayEdit.release();
			},
			reply: {
				content: [{ type: "text", text: "Rootwork is committed; the worker is still working in its lane." }],
			},
		},
	);
	// The worker's terminal handoff starts a root turn: the worker's lane is committed, its first land is refused by the
	// gate, the gate is opened explicitly, and the lane lands at epoch 1; the stale rootwork land is then refused.
	world.provider.enqueue(
		"root",
		dynamicCalls(
			"handoff-received",
			() => [
				{
					id: "add-worker-1",
					name: "worktree_sync",
					arguments: { action: "git_add", laneKey: laneKeyOrThrow(), paths: ["src/limits.ts"] },
				},
				{
					id: "commit-worker-1",
					name: "worktree_sync",
					arguments: { action: "git_commit", laneKey: laneKeyOrThrow(), message: "Set MAX_RETRIES to 5" },
				},
			],
			(request) => {
				checkoutHandoffs(request);
				handedOff.release();
			},
		),
		dynamicCalls(
			"land-worker-refused",
			() => [
				{
					id: "land-worker-1",
					name: "worktree_sync",
					arguments: { action: "land", laneKey: laneKeyOrThrow() },
				},
			],
			(request) => {
				assertBatchOk(request, "handoff-received");
				mainBeforeRefusal = world.git.refSha("refs/heads/main");
			},
		),
		dynamicCalls(
			"land-worker-positive",
			() => [
				{
					id: "land-worker-2",
					name: "worktree_sync",
					arguments: { action: "land", laneKey: laneKeyOrThrow() },
				},
			],
			(request) => {
				assertBatchOk(request, "land-worker-refused");
				if (!isGateCommandRefusal(lastToolResultDetails(sessionOf(), "worktree_sync"))) {
					throw new Error("the worker lane's first land was not refused by the gate");
				}
				if (world.git.refSha("refs/heads/main") !== mainBeforeRefusal) throw new Error("a refused land moved main");
				// The owner-level opt-out, recorded per land event, then the positive land runs with the gate off.
				world.settingsManager.applyOverrides({ worktreeSync: { gate: "off" } });
			},
		),
		{
			name: "worker-landed",
			check: (request) => {
				const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
				if (!landed?.text.includes("LANDED: epoch 1")) {
					throw new Error(`the worker lane did not land at epoch 1: ${landed?.text ?? "no land"}`);
				}
				mainBeforeStale = world.git.refSha("refs/heads/main");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "land-rootwork-stale",
						name: "worktree_sync",
						arguments: { action: "land", laneKey: "rootwork" },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "stale-refused",
			check: (request) => {
				assertBatchOk(request, "land-rootwork-stale");
				if (!isStaleRefusal(lastToolResultDetails(sessionOf(), "worktree_sync"))) {
					throw new Error(
						`the rootwork land was not refused as stale: ${JSON.stringify(lastToolResultDetails(sessionOf(), "worktree_sync"))}`,
					);
				}
				if (world.git.refSha("refs/heads/main") !== mainBeforeStale)
					throw new Error("a refused stale land moved main");
			},
			reply: {
				content: [{ type: "text", text: "The worker lane landed; the rootwork lane is behind main." }],
			},
		},
	);
	// Resolution turn: the rootwork lane syncs against the landed worker lane, the conflict is read and resolved through the
	// request-visible legend path, then the lane lands and the worker's landing is replayed.
	world.provider.enqueue(
		"root",
		calls("sync-rootwork", [
			{ id: "sync-rootwork-1", name: "worktree_sync", arguments: { action: "sync", laneKey: "rootwork" } },
		]),
		dynamicCalls(
			"read-conflict",
			(request) => [
				{
					id: "read-conflict-1",
					name: "read",
					arguments: { path: `${legendPath(request, "p/rootwork")}/src/limits.ts` },
				},
			],
			(request) => {
				const sync = latestBatchResults(request).find((result) => result.toolName === "worktree_sync");
				if (!sync?.text.toLowerCase().includes("conflict")) {
					throw new Error(`sync did not report a conflict: ${sync?.text ?? "no sync result"}`);
				}
			},
		),
		dynamicCalls(
			"resolve-conflict",
			(request) => [
				{
					id: "resolve-conflict-1",
					name: "edit",
					arguments: {
						path: `${legendPath(request, "p/rootwork")}/src/limits.ts`,
						edits: [{ oldText: conflictBlockIn(request), newText: "export const MAX_RETRIES = 5;" }],
					},
				},
			],
			(request) => {
				const read = latestBatchResults(request).find((result) => result.toolName === "read");
				if (!read?.text.includes("<<<<<<< HEAD"))
					throw new Error(`the conflicted file was not shown: ${read?.text ?? "no read"}`);
			},
		),
		calls("continue-rootwork", [
			{
				id: "continue-rootwork-1",
				name: "worktree_sync",
				arguments: { action: "continue", laneKey: "rootwork" },
			},
		]),
		calls("land-rootwork", [
			{ id: "land-rootwork-1", name: "worktree_sync", arguments: { action: "land", laneKey: "rootwork" } },
		]),
		dynamicCalls(
			"replay-worker-landing",
			() => [
				{
					id: "replay-worker-1",
					name: "worktree_sync",
					arguments: { action: "land", laneKey: laneKeyOrThrow() },
				},
			],
			(request) => {
				assertBatchOk(request, "land-rootwork");
				const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
				if (!landed?.text.includes("LANDED: epoch 2")) {
					throw new Error(
						`rootwork did not land at epoch 2: ${landed?.text ?? "no land"}\n${toolOutcomes(sessionOf())}`,
					);
				}
				mainAfterLand = world.git.refSha("refs/heads/main");
			},
		),
		{
			name: "integrated",
			check: (request) => {
				const replayed = latestBatchResults(request).find((result) => result.toolName === "worktree_sync");
				if (replayed?.text.includes("LANDED")) throw new Error(`a replayed land landed again: ${replayed.text}`);
				if (world.git.refSha("refs/heads/main") !== mainAfterLand) throw new Error("a replayed land moved main");
				legendAtIntegration = legendLinesOf(request);
				integrated.release();
			},
			reply: {
				content: [
					{
						type: "text",
						text: "Both lanes are integrated; MAX_RETRIES is 5 and the owner's draft is untouched.",
					},
				],
			},
		},
	);

	const created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const session = created.session;
	rootSession = session;
	trace.mark("root", "session.created");
	// Judgments per turn: the setup turn asks the completion state claims and two read-output claims; the resolution turn
	// asks the steering family. Each phase declares exactly what its turns ask.
	const setupJudgments = {
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		action_accomplished_step: { kind: "noul", probability: 0.02 },
		conclusions_supported: { kind: "noul", probability: 0.97 },
		scope_violation: { kind: "noul", probability: 0.02 },
		unrelated_behavior_change: { kind: "noul", probability: 0.02 },
		replan_required: { kind: "noul", probability: 0.02 },
		next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
		states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
		states_committed: { kind: "noul", probability: 0.02 },
		states_pushed: { kind: "noul", probability: 0.02 },
		states_published: { kind: "noul", probability: 0.02 },
		states_files_changed: { kind: "noul", probability: 0.97 },
	} as const;
	const resolveJudgments = {
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		step_relevant: { kind: "noul", probability: 0.97 },
		evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
		unsupported_assumption_present: { kind: "noul", probability: 0.02 },
		route: { kind: "choice", choice: "inspect", confidence: 0.97 },
		action_accomplished_step: { kind: "noul", probability: 0.02 },
		conclusions_supported: { kind: "noul", probability: 0.97 },
		scope_violation: { kind: "noul", probability: 0.02 },
		unrelated_behavior_change: { kind: "noul", probability: 0.02 },
		replan_required: { kind: "noul", probability: 0.02 },
		next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
	} as const;
	// Owner-word oracle for each J3 phase: the owner words System One classifies are this phase's own inputs, and the previous
	// intent is the native ledger's. The expected values come from scenario literals and the session's entries.
	const ownerWords = (...userRequests: string[]) =>
		expectOwnerWords({
			sessionManager: () => created.sessionManager,
			userRequests,
			optionalToolNames: ["secret_store"],
		});
	world.systemOne.enterPhase("mixed-setup", setupJudgments, {
		expect: ownerWords("Set MAX_RETRIES to 5: start a worker on its lane, edit the rootwork lane to 4, commit it."),
	});
	await withDeadline(
		trace,
		"integration setup turn",
		session.prompt("Set MAX_RETRIES to 5: start a worker on its lane, edit the rootwork lane to 4, commit it."),
		120_000,
	).catch((error: unknown) => {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
	});
	// The durable batch: the create receipt, the status result and the failing read are persisted under their own call ids, in call order.
	const j3Batch = created.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			["lane-retries", "status-1", "mixed-read-fail-j3"].includes(entry.message.toolCallId)
				? [entry.message]
				: [],
		);
	expect(
		j3Batch.map((message) => ({
			toolCallId: message.toolCallId,
			isError: message.isError,
			failureRecord:
				typeof message.details === "object" && message.details !== null && "piToolFailureMemory" in message.details,
		})),
		"the durable batch pairs each call with its own result and outcome",
	).toEqual([
		{ toolCallId: "lane-retries", isError: false, failureRecord: false },
		{ toolCallId: "status-1", isError: false, failureRecord: false },
		{ toolCallId: "mixed-read-fail-j3", isError: true, failureRecord: true },
	]);
	// The durable receipt link: the status lane for the retries key reports the checkout that the persisted create result named.
	const createText = (j3Batch[0]?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
	const retriesLane = lanesOf(j3Batch[1]?.details).find((lane) => lane.laneKey === "retries");
	expect(retriesLane, "the durable status names the retries lane").toBeDefined();
	expect(createText, "the durable create result names the checkout the status lane reports").toContain(
		String(retriesLane?.worktreePath),
	);
	await withDeadline(trace, "worker handoff", handedOff.promise, 90_000);
	await withDeadline(trace, "worker handoff turn settled", session.waitForForegroundIdle(), 90_000);
	world.systemOne.enterPhase("mixed-resolve", resolveJudgments, {
		expect: ownerWords("Sync rootwork, resolve the conflict, land it, then replay the worker landing."),
	});
	await withDeadline(
		trace,
		"resolution turn",
		session.prompt("Sync rootwork, resolve the conflict, land it, then replay the worker landing."),
		120_000,
	).catch((error: unknown) => {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
	});
	await withDeadline(trace, "integration released", integrated.promise, 5_000);

	// Stale replacement after integration. An external atomic save renames a new node over the notes file while a
	// descriptor opened earlier is still held: the root's edit from its earlier read is refused, the held descriptor
	// keeps the bytes of the node it opened, and the path shows the replacement.
	const notesPath = projectPath("src", "notes.md");
	let heldDescriptor: number | undefined;
	// Late attempt through the real identity fence. A third worker holds its first request at a gate and ignores the request abort. The owner
	// force-suspends the exact attempt while that request is held and queues the valid-current run behind the physical hold. The stale
	// terminal is emitted after the abort, and only then does the valid-current write run. The stale edit never reaches the lane.
	// The resumed run reports incompletely (matched host receipt) and ends on plaintext with no replacement: the terminal claim keeps
	// the typed incomplete report, adverse and not unparseable. A follow-up on the same persistent agent then writes the module and
	// reports truthfully, and that handoff must carry the admitted identity.
	const lateReached = createBarrier();
	const lateMayEmit = createBarrier();
	const lateTerminal = createBarrier();
	let staleTerminalEmitted = false;
	let lateWriteAfterStaleTerminal = false;
	const lateCurrentStarted = createBarrier();
	const lateAdverse = createBarrier();
	const lateRepairStarted = createBarrier();
	const lateHanded = createBarrier();
	let lateAgentId: string | undefined;
	let lateLane: string | undefined;
	let lateLaneBefore: string | undefined;
	let lateRepairTaskId: string | undefined;
	// Claim-delivery judgments: System One asks for these only while a worker's claim is delivered, so only late-attempt declares them.
	const lateClaimJudgments = {
		states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
		states_committed: { kind: "noul", probability: 0.02 },
		states_pushed: { kind: "noul", probability: 0.02 },
		states_published: { kind: "noul", probability: 0.02 },
		states_files_changed: { kind: "noul", probability: 0.02 },
	} as const;
	const lateJudgments = {
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		step_relevant: { kind: "noul", probability: 0.97 },
		evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
		unsupported_assumption_present: { kind: "noul", probability: 0.02 },
		route: { kind: "choice", choice: "reason", confidence: 0.97 },
		action_accomplished_step: { kind: "noul", probability: 0.97 },
		conclusions_supported: { kind: "noul", probability: 0.97 },
		scope_violation: { kind: "noul", probability: 0.02 },
		unrelated_behavior_change: { kind: "noul", probability: 0.02 },
		replan_required: { kind: "noul", probability: 0.02 },
		next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
	} as const;
	// Each correction is bound to the current host request (the suffix after the newest assistant turn), not the whole history.
	// The review quotes each unexplained file as one span (worker-report.ts judgeSubmittedReport, bounded-line.ts quotedSpan):
	// `src/late.ts` holds no `'`, so it is `'src/late.ts'`, which the request's JSON leaves unescaped.
	const reviewLine = "changed files with no explanation: 'src/late.ts'";
	const recordedLine = "Files the host recorded as changed: 'src/late.ts'";
	world.systemOne.enterPhase(
		"late-attempt",
		{ ...lateJudgments, ...lateClaimJudgments },
		{ expect: ownerWords("Start a late worker on a third lane.") },
	);
	world.provider.enqueue(
		"worker-b",
		{
			name: "late-edit",
			gate: lateMayEmit.promise,
			ignoresAbort: true,
			check: () => {
				lateReached.release();
			},
			onTerminal: () => {
				staleTerminalEmitted = true;
				lateTerminal.release();
			},
			reply: {
				content: [
					{ type: "text", text: "LATE-STALE-TEXT: the late edit is ready." },
					{
						type: "toolCall",
						id: "late-edit-1",
						name: "edit",
						arguments: {
							path: "src/limits.ts",
							edits: [{ oldText: "MAX_RETRIES = 5", newText: "MAX_RETRIES = 7" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "late-write",
			check: () => {
				if (!staleTerminalEmitted) {
					throw new Error("the valid-current write started before the stale terminal was emitted");
				}
				lateWriteAfterStaleTerminal = true;
				lateCurrentStarted.release();
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "late-write-1",
						name: "write",
						arguments: { path: "src/late.ts", content: "export const LATE = true;\n" },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "late-incomplete",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "late-report-0",
						name: "submit_report",
						arguments: { status: "completed", summary: "LATE-INCOMPLETE-REPORT: the module is written." },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "late-correction",
			check: (request) => {
				if (!currentRequestCarries(request, "REPORT REVIEW") || !currentRequestCarries(request, reviewLine)) {
					throw new Error("the repair request does not review the unreported change");
				}
				if (!matchedSubmitReceipt(request, "late-report-0")) {
					throw new Error("the incomplete report has no matched completed host receipt for its call");
				}
			},
			reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-CORRECTION: the module is written." }] },
		},
		{
			name: "late-correction-final",
			check: (request) => {
				if (
					!currentRequestCarries(request, "REPORT REQUEST") ||
					!currentRequestCarries(request, "You declared the task done.") ||
					!currentRequestCarries(request, recordedLine)
				) {
					throw new Error("the second request is not the generic report request for the recorded change");
				}
			},
			reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-FINAL: no report follows." }] },
		},
		{
			name: "late-correction-3",
			check: (request) => {
				if (
					!currentRequestCarries(request, "REPORT REQUEST") ||
					!currentRequestCarries(
						request,
						"You answered in text. Submit the same report with the submit_report tool",
					) ||
					!currentRequestCarries(request, recordedLine)
				) {
					throw new Error("the third request is not the repeated report request for the recorded change");
				}
			},
			reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-ROUND-3: no report follows." }] },
		},
	);
	world.provider.enqueue(
		"root",
		calls("create-late-lane", [
			{
				id: "create-late-1",
				name: "worktree_sync",
				arguments: { action: "create_lane", laneKey: "late", goalId: "retries-goal" },
			},
		]),
		dynamicCalls(
			"start-late",
			(request) => {
				const late = legendPath(request, "p/late");
				lateLane = late;
				lateLaneBefore = utf8Text(world.io.readFileSync(`${late}/src/limits.ts`, "utf8"));
				return [
					{
						id: "start-late-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-b" },
							path: late,
							writePaths: [`${late}/src/limits.ts`, `${late}/src/late.ts`],
							instructions: "Set MAX_RETRIES to 7 in src/limits.ts of your checkout, then submit your report.",
						},
					},
				];
			},
			(request) => assertBatchOk(request, "create-late-lane"),
		),
		{
			name: "late-started",
			check: (request) => {
				assertBatchOk(request, "start-late");
				lateAgentId = latestAgentIdForTrack(request, "worker-b");
			},
			reply: { content: [{ type: "text", text: "The late worker is running." }] },
		},
		{
			name: "late-adverse",
			check: (request) => {
				const adverse = request.context.messages
					.map((message) => JSON.stringify(message))
					.find((text) => text.includes("LATE-INCOMPLETE-REPORT") && text.includes("terminal handoff"));
				if (adverse === undefined) {
					throw new Error("the incomplete run's terminal handoff does not carry its typed incomplete report");
				}
				if (adverse.includes("unparseable_output")) {
					throw new Error("the incomplete run's terminal claim degraded to unparseable output");
				}
				const view = session.backgroundLanes.listWorkerAgents().find((agent) => agent.agentId === lateAgentId);
				if (view?.hostVerdict?.verdict !== "needs_more") {
					throw new Error(`the host verdict of the incomplete run is ${view?.hostVerdict?.verdict ?? "absent"}`);
				}
				lateAdverse.release();
			},
			reply: { content: [{ type: "text", text: "The late worker ended incomplete." }] },
		},
		{
			name: "late-handoff",
			check: (request) => {
				const truthful = request.context.messages
					.map((message) => JSON.stringify(message))
					.find((text) => text.includes("LATE-CURRENT-REPORT") && text.includes("terminal handoff"));
				if (truthful === undefined) {
					throw new Error("the follow-up's report did not reach the foreground root");
				}
				// Two facts, asserted separately. The typed report is accepted by the host (Claim Status completed, Host verdict accepted).
				// The overall line is partial because the lane holds this worker's uncommitted change (host finding, intentional).
				// The handoff bounds each blocker value to 240 characters, keeping its head and tail around one elision (worker-claim.ts
				// handoffClaimValue, bounded-line.ts boundedText). The head budget is ceil((240 - 1) / 2) = 120 and the lane finding's
				// opening clause through the quoted lane key ends at character 63, so the visible integration note keeps it whole.
				const identity = `- ${lateRepairTaskId}: partial reason=worker_host_findings`;
				if (
					lateRepairTaskId === undefined ||
					!truthful.includes(identity) ||
					!truthful.includes("Claim Status: completed") ||
					!truthful.includes("Host verdict: accepted") ||
					truthful.split("LATE-CURRENT-REPORT").length !== 2 ||
					!truthful.includes("Changed Files (untrusted worker evidence)") ||
					!truthful.includes("src/late.ts") ||
					!truthful.includes("worker_lane: this worker worked in its own worktree lane 'late'") ||
					truthful.includes("unparseable_output")
				) {
					throw new Error(
						`the follow-up's claim is not the admitted accepted claim of ${lateRepairTaskId ?? "no task"}: ${truthful.slice(0, 4000)}`,
					);
				}
				lateHanded.release();
			},
			reply: { content: [{ type: "text", text: "The late report is reported." }] },
		},
	);
	await withDeadline(trace, "late worker started", session.prompt("Start a late worker on a third lane."));
	trace.mark("root", "late.started");
	await withDeadline(trace, "late request held", lateReached.promise, 60_000);
	if (lateAgentId === undefined || lateLane === undefined || lateLaneBefore === undefined) {
		throw new Error("the late worker identity or lane was not captured");
	}
	expect(lateLaneBefore, "the late lane was created from the landed value 5").toBe("export const MAX_RETRIES = 5;\n");
	const suspended = session.backgroundLanes.interruptWorkerAgent(lateAgentId, undefined, { force: true });
	expect(suspended, "the exact attempt is force-suspended while its request is held").toEqual({
		interrupted: true,
		mode: "suspend",
	});
	// The valid current attempt is queued behind the stale attempt's physical hold and runs no request before the stale terminal.
	const queued = session.backgroundLanes.resumeWorkerAgent(lateAgentId);
	expect(queued.started, "the valid current attempt is queued behind the physical hold").toBe(true);
	expect(world.provider.reached, "no valid current request runs while the stale attempt is held").not.toContain(
		"worker-b:late-write",
	);
	lateMayEmit.release();
	await withDeadline(trace, "late terminal emitted", lateTerminal.promise, 60_000);
	expect(
		world.provider.terminals.filter((terminal) => terminal.modelId === "worker-b" && terminal.ignoredRequestAbort),
		"the late terminal was emitted after the abort it ignored",
	).toEqual([expect.objectContaining({ requestAborted: true, ignoredRequestAbort: true, stopReason: "toolUse" })]);
	expect(world.io.readFileSync(`${lateLane}/src/limits.ts`, "utf8"), "the fence drops the late edit").toBe(
		lateLaneBefore,
	);
	expect(
		JSON.stringify(world.provider.requests.filter((request) => request.model.id === "root")),
		"no root turn sees the stale terminal",
	).not.toContain("LATE-STALE-TEXT");
	await withDeadline(trace, "resumed run writes", lateCurrentStarted.promise, 60_000);
	await withDeadline(trace, "incomplete run ends adverse", lateAdverse.promise, 60_000);
	await withDeadline(trace, "adverse foreground settled", session.waitForForegroundIdle(), 60_000);
	trace.mark("root", "late.adverse");
	// Native durable-reader control on the adverse attempt: the production lifecycle reopens the persisted event store, the store
	// opens the attempt's persisted conversation, and the real recovery coordinator reads its terminal completion. Only that read
	// is invoked: every scheduling and publication port throws if reached. This is a durable-reader control, not a normal resume.
	const adverseProjection = session.backgroundLanes.getTaskRuntimeSnapshot();
	if (adverseProjection === undefined) throw new Error("the task runtime projection is not readable");
	// The adverse attempt is the one terminal attempt of the late agent: any other match is ambiguous and refuses the control.
	const lateTerminalAttempts = Object.values(adverseProjection.attempts).filter(
		(attempt) => (attempt.agentId ?? attempt.dispatch.logicalLaneId) === lateAgentId && attempt.status !== "queued",
	);
	if (lateTerminalAttempts.length !== 1) {
		throw new Error(`the late agent has ${lateTerminalAttempts.length} terminal attempts, not exactly one`);
	}
	const adverseAttempt = lateTerminalAttempts[0];
	if (adverseAttempt === undefined) throw new Error("the adverse attempt is not in the projection");
	const adverseBindingKey = adverseAttempt.agentId ?? adverseAttempt.dispatch.logicalLaneId;
	if (adverseBindingKey === undefined) throw new Error("the adverse attempt names no agent");
	const adverseBinding = adverseProjection.agents[adverseBindingKey];
	if (adverseBinding?.resumeContext === undefined)
		throw new Error("the adverse agent has no persisted resume context");
	const unusedPort = (name: string) => (): never => {
		throw new Error(`the recovery reader control must not invoke ${name}`);
	};
	const readerWarnings: string[] = [];
	const readerLifecycle = new WorkerLifecycle({
		agentDir: world.agentDir,
		sessionId: created.sessionManager.getSessionId(),
	});
	const readerCoordinator = new WorkerRecoveryCoordinator({
		timers: world.timers.port("orchestration"),
		lifecycle: readerLifecycle,
		scheduler: { enqueue: unusedPort("scheduler.enqueue") },
		recoverWriteReservations: unusedPort("recoverWriteReservations"),
		publishTerminalRecord: unusedPort("publishTerminalRecord"),
		dispatchVerification: unusedPort("dispatchVerification"),
		recoverTaskBearingMailboxTurns: unusedPort("recoverTaskBearingMailboxTurns"),
		recoverSessionRootReplies: unusedPort("recoverSessionRootReplies"),
		warn: (message) => {
			readerWarnings.push(message);
		},
	});
	const adverseConversation = new WorkerConversationStore().open({
		agentDir: world.agentDir,
		resumeContext: adverseBinding.resumeContext,
		expectedLogicalAgentId: adverseBinding.contextOrigin?.logicalAgentId ?? adverseBinding.agentId,
	});
	const recovered = readerCoordinator.recoveredTerminalCompletion(adverseConversation, adverseAttempt.attemptId);
	expect(recovered?.attemptId, "the recovered completion names the exact adverse attempt").toBe(
		adverseAttempt.attemptId,
	);
	expect(recovered?.submittedReport?.summary, "the recovered report is the typed incomplete report").toContain(
		"LATE-INCOMPLETE-REPORT",
	);
	expect(
		readerCoordinator.recoveredTerminalCompletion(adverseConversation, "attempt-foreign-not-in-transcript"),
		"a foreign attempt id is refused",
	).toBeUndefined();
	expect(readerWarnings, "the reader control emits no warnings").toEqual([]);

	// The same persistent agent takes a new turn: its write is the current evidence, and its truthful report is the admitted repair.
	// The old phase is physically queued-empty before the distinct repair is appended: no worker-b step from it can serve the follow-up.
	expect(
		world.provider.getPendingStepNames("worker-b"),
		"the old worker-b phase is fully drained before the repair is appended",
	).toEqual([]);
	world.provider.enqueue(
		"worker-b",
		{
			name: "late-repair-write",
			check: () => {
				lateRepairStarted.release();
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "late-repair-write-1",
						name: "write",
						arguments: { path: "src/late.ts", content: "export const LATE = true;\n" },
					},
				],
				stopReason: "toolUse",
			},
		},
		calls("late-current", [
			{
				id: "late-report-1",
				name: "submit_report",
				arguments: {
					status: "completed",
					summary: "LATE-CURRENT-REPORT: the lane is reported.",
					changes: [{ file: "src/late.ts", what: "Exports the LATE flag from the late module." }],
				},
			},
		]),
	);
	// Readiness through the existing public wait: idle is reported only once the specialist is settled, so the repair never
	// races release of the adverse attempt's tools and resource holds. The public ready predicate does not join the outer
	// execution promise tail or registry deregistration. The adverse attempt stays the single terminal attempt of this agent.
	const lateReady = await withDeadline(
		trace,
		"late agent idle before repair",
		session.backgroundLanes.waitForWorkerAgent(lateAgentId, 60_000),
		70_000,
	);
	expect(lateReady.timedOut, "the late agent settles inside its wait").toBe(false);
	expect(lateReady.status, "the late agent is idle before the repair").toBe("idle");
	expect(
		Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})
			.filter(
				(attempt) =>
					(attempt.agentId ?? attempt.dispatch.logicalLaneId) === lateAgentId && attempt.status !== "queued",
			)
			.map((attempt) => attempt.attemptId),
		"the adverse attempt is still the one terminal attempt after the wait",
	).toEqual([adverseAttempt.attemptId]);
	const repair = session.backgroundLanes.followUpSessionRootWorkerAgent(
		lateAgentId,
		"Submit the corrected report with the module change.",
		{
			idempotencyKey: "late-repair-1",
		},
	);
	expect(repair.started, "the follow-up admits a new turn on the same persistent agent").toBe(true);
	lateRepairTaskId = repair.record?.laneId;
	if (lateRepairTaskId === undefined) throw new Error("the follow-up admitted no task");
	await withDeadline(trace, "repair write starts", lateRepairStarted.promise, 60_000);
	await withDeadline(trace, "truthful handoff", lateHanded.promise, 60_000);
	await withDeadline(trace, "late handoff settled", session.waitForForegroundIdle(), 60_000);
	const admitted = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
		(attempt) => attempt.taskId === lateRepairTaskId,
	);
	expect(
		admitted.map((attempt) => attempt.status),
		"the admitted current attempt is partial: the host finding holds the uncommitted lane change",
	).toEqual(["partial"]);
	// Native proof of the admitted repair. The handoff renders each blocker clipped, so the uncommitted integration finding is read
	// from the persisted result in full, with the exact marker, and from the agent's latest host verdict.
	const repairResult = session.backgroundLanes.getWorkerResult(lateRepairTaskId);
	expect(repairResult?.status, "the repair result is partial because of the host finding").toBe("partial");
	expect(repairResult?.summary, "the repair result carries the current report").toContain("LATE-CURRENT-REPORT");
	expect(
		repairResult?.errors.map((error) => error.message),
		"the host finding names the lane and the uncommitted integration change",
	).toEqual(expect.arrayContaining([expect.stringContaining("its changes are there: uncommitted changes")]));
	const lateSnapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	const lateView = session.backgroundLanes.listWorkerAgents().find((agent) => agent.agentId === lateAgentId);
	const lateDiagnostic = JSON.stringify({
		view: {
			hostVerdict: lateView?.hostVerdict,
			lastResult: lateView?.lastResult,
			dispatch: lateView?.dispatch,
			recommendedDisposition: lateView?.recommendedDisposition,
		},
		attempts: Object.values(lateSnapshot?.attempts ?? {})
			.filter((attempt) => (attempt.agentId ?? attempt.dispatch.logicalLaneId) === lateAgentId)
			.map((attempt) => ({
				attemptId: attempt.attemptId,
				taskId: attempt.taskId,
				status: attempt.status,
				logicalLaneId: attempt.dispatch.logicalLaneId,
				result: attempt.result?.status,
			})),
		repairTaskId: lateRepairTaskId,
	});
	expect(lateView?.hostVerdict?.verdict, `the agent's latest report is accepted by the host: ${lateDiagnostic}`).toBe(
		"accepted",
	);
	// The superseded adverse turn's unreported-change finding must not survive into the current view's verdict or advice.
	expect(
		JSON.stringify({ missing: lateView?.hostVerdict?.missing ?? [], advice: lateView?.recommendedDisposition }),
		"the latest view carries no reason from the superseded unreported-change turn",
	).not.toMatch(/unreported|no explanation/);
	expect(world.io.readFileSync(`${lateLane}/src/limits.ts`, "utf8"), "the stale edit never reached the limits").toBe(
		lateLaneBefore,
	);
	expect(world.io.readFileSync(`${lateLane}/src/late.ts`, "utf8"), "the current attempt wrote its module").toBe(
		"export const LATE = true;\n",
	);
	expect(lateWriteAfterStaleTerminal, "the valid-current write ran after the stale terminal").toBe(true);
	trace.mark("root", "late.reported");

	// E10 (one shared checkout, explicit overlapping write scopes): two writers name overlapping extra roots, so the second
	// waits on the reservation its start receipt names; a disjoint writer completes beside the held one; an out-of-scope write
	// is refused and leaves a pre-existing sentinel unchanged. Every start is bound to its own lane, task and attempt.
	const E10_MODEL = "worker-c";
	const E10_SHARED = projectPath("e10", "shared");
	const E10_NESTED = `${E10_SHARED}/nested`;
	const E10_C_SCOPE = projectPath("e10", "other", "c");
	const E10_D_SCOPE = projectPath("e10", "other", "d");
	const E10_OUTSIDE = harnessPath("e10-outside", "d.txt");
	const E10_SENTINEL = "E10-SENTINEL\n";
	const E10_INSTRUCTIONS = {
		a: "E10-WORKER-A writes its file in the shared checkout and reports.",
		b: "E10-WORKER-B writes its nested file in the shared checkout and reports.",
		c: "E10-WORKER-C writes its file beside the held scope and reports.",
		d: "E10-WORKER-D attempts an out-of-scope write and reports.",
	} as const;
	const E10_SUMMARIES = {
		a: "E10 A wrote its file.",
		b: "E10 B wrote its file.",
		c: "E10 C wrote its file.",
		d: "E10 D reported its refusal.",
	} as const;
	// Handoffs wake the root in this order: C completes first while A and D hold, then D, then A, then B.
	const E10_WAKE_ORDER = ["c", "d", "a", "b"] as const;
	const e10ReleaseA = createBarrier();
	const e10ReleaseD = createBarrier();
	const e10ReleaseC = createBarrier();
	const e10Woke = { a: createBarrier(), b: createBarrier(), c: createBarrier(), d: createBarrier() };
	// A worker's tail is joined by the foreground submission epoch its wake turn ran under: that epoch is released with no active run.
	const e10Tails = { c: createBarrier(), d: createBarrier() };
	const e10Epochs: Partial<Record<"c" | "d", { readonly epoch: number; readonly requestSequence: number }>> = {};
	const e10TailDone: Record<"c" | "d", boolean> = { c: false, d: false };
	let e10ATerminal = false;
	let e10BFirstRequest:
		| Array<{
				readonly taskId: string;
				readonly attemptId: string;
				readonly ownerId: string;
				readonly fencingToken: number;
				readonly writeScopes: string[];
		  }>
		| undefined;
	let e10BAttemptLease: { readonly ownerId: string; readonly fencingToken: number } | undefined;
	const e10Matches = (marker: string) => (request: ScriptedRequest) =>
		JSON.stringify(request.context.messages).includes(marker);
	const e10Report = (
		id: string,
		key: keyof typeof E10_SUMMARIES,
		changes: readonly { readonly file: string; readonly what: string }[] = [],
		status: "completed" | "blocked" = "completed",
	): ScriptStep => ({
		name: `e10-${key}-report`,
		reply: {
			content: [
				{
					type: "toolCall",
					id,
					name: "submit_report",
					arguments: { status, summary: E10_SUMMARIES[key], changes: [...changes] },
				},
			],
			stopReason: "toolUse",
		},
	});
	world.provider.enqueueTrack(
		"e10-a",
		E10_MODEL,
		e10Matches("E10-WORKER-A"),
		{
			name: "e10-a-write",
			gate: e10ReleaseA.promise,
			reply: {
				content: [
					{
						type: "toolCall",
						id: "e10-a-write-1",
						name: "write",
						arguments: { path: `${E10_SHARED}/a.txt`, content: "A-WRITTEN\n" },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			...e10Report("e10-a-report-1", "a", [{ file: `${E10_SHARED}/a.txt`, what: "Writes the shared file." }]),
			onTerminal: () => {
				e10ATerminal = true;
			},
		},
	);
	world.provider.enqueueTrack(
		"e10-b",
		E10_MODEL,
		e10Matches("E10-WORKER-B"),
		{
			name: "e10-b-write",
			check: () => {
				// Physical, not wire: the held writer's reservation lease must be gone before this request is admitted.
				const held = session.getResourceSnapshot().workers?.reservations.heldLeases ?? [];
				if (held.some((lease) => lease.taskId === e10Start("e10-start-a-1").laneId)) {
					throw new Error("the second writer reached a request while the held writer's lease is still held");
				}
				e10BFirstRequest = held.map((lease) => ({
					taskId: lease.taskId,
					attemptId: lease.attemptId,
					ownerId: lease.ownerId,
					fencingToken: lease.fencingToken,
					writeScopes: [...lease.writeScopes],
				}));
				e10BAttemptLease = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})
					.filter((attempt) => attempt.taskId === e10Start("e10-start-b-1").laneId)
					.map((attempt) => attempt.lease)
					.find((lease) => lease !== undefined);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "e10-b-write-1",
						name: "write",
						arguments: { path: `${E10_NESTED}/b.txt`, content: "B-WRITTEN\n" },
					},
				],
				stopReason: "toolUse",
			},
		},
		e10Report("e10-b-report-1", "b", [{ file: `${E10_NESTED}/b.txt`, what: "Writes the nested file." }]),
	);
	world.provider.enqueueTrack(
		"e10-c",
		E10_MODEL,
		e10Matches("E10-WORKER-C"),
		{
			name: "e10-c-write",
			gate: e10ReleaseC.promise,
			reply: {
				content: [
					{
						type: "toolCall",
						id: "e10-c-write-1",
						name: "write",
						arguments: { path: `${E10_C_SCOPE}/c.txt`, content: "C-WRITTEN\n" },
					},
				],
				stopReason: "toolUse",
			},
		},
		e10Report("e10-c-report-1", "c", [{ file: `${E10_C_SCOPE}/c.txt`, what: "Writes the disjoint file." }]),
	);
	world.provider.enqueueTrack(
		"e10-d",
		E10_MODEL,
		e10Matches("E10-WORKER-D"),
		{
			name: "e10-d-write",
			gate: e10ReleaseD.promise,
			reply: {
				content: [
					{
						type: "toolCall",
						id: "e10-d-write-1",
						name: "write",
						arguments: { path: E10_OUTSIDE, content: "D-OUTSIDE\n" },
					},
				],
				stopReason: "toolUse",
			},
		},
		e10Report("e10-d-report-1", "d", [], "blocked"),
	);
	// A start while a compatible writer runs is refused as busy unless parallelWork names the running agents it is independent of.
	// The agent ids come from the earlier start receipts, read when this request is made.
	const e10StartCall = (
		key: keyof typeof E10_INSTRUCTIONS,
		writePaths: readonly string[],
		independentKeys: readonly (keyof typeof E10_INSTRUCTIONS)[] = [],
	) =>
		dynamicCalls(`e10-start-${key}`, () => [
			{
				id: `e10-start-${key}-1`,
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: E10_MODEL },
					instructions: E10_INSTRUCTIONS[key],
					writePaths: [...writePaths],
					...(independentKeys.length > 0
						? {
								parallelWork: {
									independentOf: independentKeys.map((other) => e10Start(`e10-start-${other}-1`).agentId),
									justification: `Overlapping writer on the one shared checkout: ${E10_INSTRUCTIONS[key]}`,
								},
							}
						: {}),
				},
			},
		]);
	const e10WakeSteps = E10_WAKE_ORDER.map((key, index): ScriptStep => {
		const delivered = E10_WAKE_ORDER.slice(0, index + 1);
		return {
			name: `e10-wake-${key}`,
			check: (request) => {
				const serialized = JSON.stringify(request.context.messages);
				for (const other of E10_WAKE_ORDER) {
					const present = serialized.includes(E10_SUMMARIES[other]);
					if (delivered.includes(other) !== present) {
						throw new Error(
							`the wake for ${key} expects ${other} ${delivered.includes(other) ? "present" : "absent"}`,
						);
					}
				}
				if (key === "c" || key === "d") {
					const activity = session.getForegroundActivity();
					if (activity.epoch === undefined) throw new Error(`the ${key} wake turn runs under no submission epoch`);
					e10Epochs[key] = { epoch: activity.epoch, requestSequence: request.sequence };
				}
				e10Woke[key].release();
			},
			reply: { content: [{ type: "text", text: `Writer ${key} is reported.` }] },
		};
	});
	world.provider.enqueue(
		"root",
		e10StartCall("a", [E10_SHARED]),
		e10StartCall("b", [E10_NESTED], ["a"]),
		e10StartCall("c", [E10_C_SCOPE], ["a", "b"]),
		e10StartCall("d", [E10_D_SCOPE], ["a", "b", "c"]),
		{
			name: "e10-started",
			reply: { content: [{ type: "text", text: "The overlapping writers are started." }] },
		},
		...e10WakeSteps,
	);
	// The durable start receipt of one call: whether it started, its skip reason, and the exact agent and lane it names.
	const e10Start = (
		toolCallId: string,
	): { started: boolean; skipReason?: string; agentId: string; laneId: string; text: string } => {
		const entry = created.sessionManager
			.getBranch()
			.find(
				(candidate) =>
					candidate.type === "message" &&
					candidate.message.role === "toolResult" &&
					candidate.message.toolCallId === toolCallId,
			);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error(`no durable start result for ${toolCallId}`);
		}
		const details = entry.message.details as
			| { started?: unknown; skipReason?: unknown; agentId?: unknown; laneId?: unknown }
			| undefined;
		if (typeof details?.agentId !== "string" || typeof details.laneId !== "string") {
			throw new Error(`the start result ${toolCallId} carries no agent or lane id`);
		}
		return {
			started: details.started === true,
			...(typeof details.skipReason === "string" ? { skipReason: details.skipReason } : {}),
			agentId: details.agentId,
			laneId: details.laneId,
			text: entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
		};
	};
	// The attempt a lane names: the task's own attempt. The lane id is the task id, so a reused agent's older attempts never match.
	const e10AttemptOf = (laneId: string) =>
		Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})
			.filter((attempt) => attempt.taskId === laneId)
			.at(-1);
	const e10HeldLease = (laneId: string) =>
		(session.getResourceSnapshot().workers?.reservations.heldLeases ?? []).find((lease) => lease.taskId === laneId);
	const e10Held = (): string[] =>
		(session.getResourceSnapshot().workers?.reservations.heldLeases ?? []).map((lease) => lease.taskId).sort();
	// The persisted completion of a wake: the handoff entry in the root branch, then the next assistant entry.
	const e10WakeCompletion = (summary: string): { readonly stopReason: string | undefined; readonly text: string } => {
		const branch = created.sessionManager.getBranch();
		const delivered = branch.findIndex(
			(entry) => entry.type === "custom_message" && JSON.stringify(entry).includes(summary),
		);
		if (delivered < 0) throw new Error(`no persisted handoff carries ${summary}`);
		const completion = branch
			.slice(delivered + 1)
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (completion?.type !== "message" || completion.message.role !== "assistant") {
			throw new Error(`no persisted assistant completion follows ${summary}`);
		}
		return {
			stopReason: completion.message.stopReason,
			text: completion.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
		};
	};
	const e10ToolResultError = (toolCallId: string): boolean | undefined => {
		for (const [path, content] of world.io.fileEntries()) {
			if (!path.includes("worker-conversations") || !path.endsWith(".jsonl")) continue;
			for (const line of content.split("\n")) {
				if (!line.includes(toolCallId)) continue;
				// The persisted entry wraps its message; the message itself carries the role, call id and error flag.
				const entry = JSON.parse(line) as ConversationRecord & { readonly message?: ConversationRecord };
				const message: ConversationRecord = entry.message ?? entry;
				if (message.role === "toolResult" && message.toolCallId === toolCallId) return message.isError;
			}
		}
		return undefined;
	};
	// Observer seam: the activity listener is subscribed before the wake turns. A tail is joined when its captured epoch is
	// released and no foreground run is active; no timer, poll, or global-idle wait is involved while A and D hold.
	const offE10Tail = session.subscribeForegroundActivity(() => {
		for (const key of ["c", "d"] as const) {
			const captured = e10Epochs[key];
			if (captured === undefined || e10TailDone[key]) continue;
			if (session.getForegroundActivity().epoch === captured.epoch) continue;
			if (session.getResourceSnapshot().foregroundRecovery.activeRuns !== 0) continue;
			e10TailDone[key] = true;
			e10Tails[key].release();
		}
	});
	world.systemOne.enterPhase(
		"e10",
		{
			changes_model_pools: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "inspect", confidence: 0.97 },
			action_accomplished_step: { kind: "noul", probability: 0.02 },
			conclusions_supported: { kind: "noul", probability: 0.97 },
			scope_violation: { kind: "noul", probability: 0.02 },
			unrelated_behavior_change: { kind: "noul", probability: 0.02 },
			replan_required: { kind: "noul", probability: 0.02 },
			next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
			states_committed: { kind: "noul", probability: 0.02 },
			states_pushed: { kind: "noul", probability: 0.02 },
			states_published: { kind: "noul", probability: 0.02 },
			states_files_changed: { kind: "noul", probability: 0.97 },
		},
		{
			expect: ownerWords("Start the overlapping writers on the shared checkout."),
		},
	);
	try {
		await withDeadline(
			trace,
			"E10 start turn",
			session.prompt("Start the overlapping writers on the shared checkout."),
			120_000,
		);
		e10ReleaseC.release();
		// C is released only after the start prompt's full tail has returned: its wake is not folded into that turn.
		// Immediate receipts, before any wait on the held writers: every start is accepted with its agent and lane. A and D run
		// gated; B's receipt names the reservation it waits on, and the held lease carries A's own attempt and scope.
		const e10StartA = e10Start("e10-start-a-1");
		const e10StartB = e10Start("e10-start-b-1");
		const e10StartC = e10Start("e10-start-c-1");
		const e10StartD = e10Start("e10-start-d-1");
		expect(
			{ a: e10StartA.started, b: e10StartB.started, c: e10StartC.started, d: e10StartD.started },
			"each start receipt records an accepted start",
		).toEqual({ a: true, b: true, c: true, d: true });
		expect(
			[e10StartA.skipReason, e10StartB.skipReason, e10StartC.skipReason, e10StartD.skipReason],
			"no start receipt carries a skip reason",
		).toEqual([undefined, undefined, undefined, undefined]);
		expect(e10StartB.text, "B's receipt names the reservation it waits on").toContain("waiting: write_reservation: ");
		expect(e10StartB.text, "B's wait is on a worker of this session").toContain("held by a worker of this session");
		const laneA = e10StartA.laneId;
		const laneB = e10StartB.laneId;
		const laneD = e10StartD.laneId;
		expect(
			{
				a: e10AttemptOf(laneA)?.status,
				b: e10AttemptOf(laneB)?.status,
				d: e10AttemptOf(laneD)?.status,
			},
			"right after the start turn A and D run gated and B waits behind A",
		).toEqual({ a: "running", b: "queued", d: "running" });
		expect(e10HeldLease(laneA)?.attemptId, "A's held lease is A's own attempt").toBe(e10AttemptOf(laneA)?.attemptId);
		expect(e10HeldLease(laneA)?.writeScopes, "A's held lease covers the shared scope").toContain(
			canonicalPathScopeIdentity(E10_SHARED),
		);
		expect(e10HeldLease(laneD)?.writeScopes, "D's held lease covers its own scope").toContain(
			canonicalPathScopeIdentity(E10_D_SCOPE),
		);
		await withDeadline(trace, "C reported", e10Woke.c.promise, 90_000).catch((error: unknown) => {
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
		});
		await withDeadline(trace, "C tail released", e10Tails.c.promise, 90_000);
		expect(
			e10WakeCompletion(E10_SUMMARIES.c),
			"C's persisted completion after its handoff is the scripted stop and answer",
		).toEqual({ stopReason: "stop", text: "Writer c is reported." });
		const laneC = e10StartC.laneId;
		// C readiness through the existing public wait, after its handoff and tail proofs above: idle only once its specialist settles.
		const cBefore = { taskId: e10AttemptOf(laneC)?.taskId, attemptId: e10AttemptOf(laneC)?.attemptId };
		const cReady = await withDeadline(
			trace,
			"C agent idle after its tail",
			session.backgroundLanes.waitForWorkerAgent(e10StartC.agentId, 60_000),
			70_000,
		);
		expect(cReady.timedOut, "C settles inside its wait").toBe(false);
		expect(cReady.status, "C is idle after its tail").toBe("idle");
		expect(
			{ taskId: e10AttemptOf(laneC)?.taskId, attemptId: e10AttemptOf(laneC)?.attemptId },
			"C keeps its exact task and attempt",
		).toEqual(cBefore);
		// The completed disjoint writer proves the held scope did not block it; A and D stay held; B still waits.
		expect(
			{
				a: e10AttemptOf(laneA)?.status,
				b: e10AttemptOf(laneB)?.status,
				c: e10AttemptOf(laneC)?.status,
				d: e10AttemptOf(laneD)?.status,
			},
			"at C's tail A and D hold, B waits behind A, and C completed",
		).toEqual({ a: "running", b: "queued", c: "completed", d: "running" });
		expect(e10Held(), "the held leases are A's and D's lanes only").toEqual([laneA, laneD].sort());
		e10ReleaseD.release();
		await withDeadline(trace, "D reported", e10Woke.d.promise, 90_000);
		await withDeadline(trace, "D tail released", e10Tails.d.promise, 90_000);
		expect(
			e10WakeCompletion(E10_SUMMARIES.d),
			"D's persisted completion after its handoff is the scripted stop and answer",
		).toEqual({ stopReason: "stop", text: "Writer d is reported." });
		// D's out-of-scope write is refused by the file gate, persisted as an error result, and leaves the pre-existing sentinel.
		expect(e10AttemptOf(laneD)?.status, "D's honest blocked report is its native adverse terminal").toBe("blocked");
		expect(e10ToolResultError("e10-d-write-1"), "the out-of-scope write is refused").toBe(true);
		expect(world.io.existsSync(E10_OUTSIDE), "the sentinel outside the scope still exists").toBe(true);
		expect(String(world.io.readFileSync(E10_OUTSIDE, "utf8")), "the refused write leaves the sentinel bytes").toBe(
			E10_SENTINEL,
		);
		expect(e10AttemptOf(laneB)?.status, "B still waits behind A after D's terminal").toBe("queued");
		// Release A: its terminal ends the hold, and the release event admits B; B's first request is after A's terminal.
		e10ReleaseA.release();
		await withDeadline(trace, "A reported", e10Woke.a.promise, 90_000);
		await withDeadline(trace, "B reported", e10Woke.b.promise, 90_000);
		expect(e10ATerminal, "the held writer reached its wire terminal first").toBe(true);
		expect(
			e10BFirstRequest?.some((lease) => lease.taskId === e10StartA.laneId),
			"A's physical lease is absent when B's first request runs",
		).toBe(false);
		expect(
			e10BFirstRequest
				?.filter((lease) => lease.taskId === laneB)
				.map((lease) => ({
					attemptId: lease.attemptId,
					nested: lease.writeScopes.some(
						(scope) => scope === canonicalPathScopeIdentity(projectPath("e10", "shared", "nested")),
					),
				})),
			"B's physical lease at its first request is its own attempt over its nested scope",
		).toEqual([{ attemptId: e10AttemptOf(laneB)?.attemptId, nested: true }]);
		// The reservation lease carries the admitted attempt's own lease fence and owner, observed at its first request.
		expect(
			e10BFirstRequest
				?.filter((lease) => lease.taskId === laneB)
				.map((lease) => ({
					attemptId: lease.attemptId,
					ownerId: lease.ownerId,
					fencingToken: lease.fencingToken,
				})),
			"B's physical lease carries its own admitted attempt's owner and fence",
		).toEqual([
			{
				attemptId: e10AttemptOf(laneB)?.attemptId,
				ownerId: e10BAttemptLease?.ownerId,
				fencingToken: e10BAttemptLease?.fencingToken,
			},
		]);
		// All four admitted agents, after every A-D handoff proof above: idle through the existing public batch wait, before the final global idle.
		const admittedAgentIds = [e10StartA.agentId, e10StartB.agentId, e10StartC.agentId, e10StartD.agentId];
		const admittedIdentities = () =>
			[laneA, laneB, laneC, laneD].map((lane) => ({
				taskId: e10AttemptOf(lane)?.taskId,
				attemptId: e10AttemptOf(lane)?.attemptId,
			}));
		const admittedBefore = admittedIdentities();
		const admittedReady = await withDeadline(
			trace,
			"A-D agents idle after every handoff",
			session.backgroundLanes.waitForWorkerAgents(admittedAgentIds, "all", 60_000),
			70_000,
		);
		expect(admittedReady.timedOut, "the four admitted agents settle inside their wait").toBe(false);
		expect(admittedReady.statuses, "the wait reports exactly the four admitted agents").toHaveLength(4);
		expect(
			admittedAgentIds.map((agentId) => admittedReady.statuses.find((status) => status.agentId === agentId)?.status),
			"all four admitted agents are idle",
		).toEqual(["idle", "idle", "idle", "idle"]);
		expect(admittedIdentities(), "the four exact task and attempt identities are unchanged").toEqual(admittedBefore);
		await withDeadline(trace, "E10 settled", session.waitForForegroundIdle(), 90_000);
		offE10Tail();
		expect(
			{
				a: e10AttemptOf(laneA)?.status,
				b: e10AttemptOf(laneB)?.status,
				c: e10AttemptOf(laneC)?.status,
				d: e10AttemptOf(laneD)?.status,
			},
			"every writer reaches its native terminal once the held scope is released",
		).toEqual({ a: "completed", b: "completed", c: "completed", d: "blocked" });
		expect(e10Held(), "no lease remains after the overlap settles").toEqual([]);
		// Same-model identities: four workers share one provider model; each exact attempt is its own grant, routed by its own context.
		const grants = [laneA, laneB, laneC, laneD].map((lane) => e10AttemptOf(lane)?.grantId);
		expect(
			grants.every((grant) => typeof grant === "string"),
			"every attempt carries its own grant",
		).toBe(true);
		expect(new Set(grants).size, "the four grants are distinct").toBe(4);
		const e10Runtime = session.backgroundLanes.getTaskRuntimeSnapshot();
		const e10Agents = [e10StartA, e10StartB, e10StartC, e10StartD].map((start) => e10Runtime?.agents[start.agentId]);
		expect(
			new Set([laneA, laneB, laneC, laneD].map((lane) => e10AttemptOf(lane)?.attemptId)).size,
			"four distinct attempts",
		).toBe(4);
		expect(
			new Set(e10Agents.map((agent) => agent?.resumeContext.sessionId)).size,
			"four distinct resume identities",
		).toBe(4);
		expect(
			new Set(e10Agents.map((agent) => agent?.resumeContext.modelRef)).size,
			"all four agents run one provider model",
		).toBe(1);
		expect(e10Agents[0]?.resumeContext.modelRef, "the shared model is recorded on each agent").toEqual(
			expect.any(String),
		);
		expect(
			world.provider.reached.filter((entry) => entry.startsWith("e10-")).map((entry) => entry.split(":")[0]),
			"each request routed to its own track by its own context",
		).toEqual(expect.arrayContaining(["e10-a", "e10-b", "e10-c", "e10-d"]));
		expect(String(world.io.readFileSync(`${E10_SHARED}/a.txt`, "utf8")), "A wrote its scope").toBe("A-WRITTEN\n");
		expect(String(world.io.readFileSync(`${E10_NESTED}/b.txt`, "utf8")), "B wrote its scope").toBe("B-WRITTEN\n");
		expect(String(world.io.readFileSync(`${E10_C_SCOPE}/c.txt`, "utf8")), "C wrote its scope").toBe("C-WRITTEN\n");
	} catch (error) {
		// A failed proof must not leave a producer gated: the writers this block holds join, and the failure still propagates.
		e10ReleaseC.release();
		offE10Tail();
		e10ReleaseA.release();
		e10ReleaseD.release();
		throw error;
	}
	// Integration and completion: the late lane's module lands, both delegated workers retire, and the goal completes on the
	// host after a passing run is recorded as evidence. The orchestration journey also checks active-lane refusal.
	const e12PersistGates: Array<{
		readonly cwd: string;
		readonly command: string;
		readonly tip: string | undefined;
	}> = [];
	// E12 gate steps are queued first: the shell queue is FIFO and the gate runs before the integration vitest run.
	const E12_GATE = "npm run check";
	const e12Reached = createBarrier();
	const e12Release = createBarrier();
	const e12OwnerReached = createBarrier();
	const e12OwnerRelease = createBarrier();
	let e12LanePath: string | undefined;
	const e12ToolText = (toolCallId: string): string => {
		const entry = created.sessionManager
			.getBranch()
			.find(
				(candidate) =>
					candidate.type === "message" &&
					candidate.message.role === "toolResult" &&
					candidate.message.toolCallId === toolCallId,
			);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error(`no durable tool result for ${toolCallId}`);
		}
		return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	};
	const e12LandCall = (id: string) => ({
		id,
		name: "worktree_sync",
		arguments: { action: "land", laneKey: "e12" },
	});
	world.shell.enqueue(
		{ name: "e12-gate-fails", command: E12_GATE, output: "check failed", exitCode: 1 },
		{
			name: "e12-gate-tip-moves",
			command: E12_GATE,
			output: "check passed",
			exitCode: 0,
			check: () => {
				e12Reached.release();
			},
			gate: e12Release.promise,
		},
		{
			name: "e12-gate-passes",
			command: E12_GATE,
			output: "check passed",
			exitCode: 0,
			check: () => e12OwnerReached.release(),
			gate: e12OwnerRelease.promise,
		},
	);
	const integrateVitest = "vitest run test/limits.test.ts";
	let integrationAdmission:
		| { readonly mainSha: string | undefined; readonly limits: string; readonly late: string }
		| undefined;
	const integrationVitestOutput = ["Test Files  1 passed (1)\n", "Tests  1 passed (1)\n"];
	const e0Counters: E0Counters = zeroE0Counters();
	world.systemOne.enterPhase(
		"integrate",
		{
			...lateJudgments,
		},
		{
			expect: (request) => {
				ownerWords("Integrate the late lane's module.")(request);
				const controller = session.systemOneController;
				if (controller === undefined) throw new Error("the E0 integrate phase has no bound System One controller");
				bindE0Request(request, controller.store.snapshot(), session.messages.length, e0Counters);
			},
		},
	);
	world.provider.enqueue(
		"root",
		calls("integrate-late", [
			{
				id: "add-late-1",
				name: "worktree_sync",
				arguments: { action: "git_add", laneKey: "late", paths: ["src/late.ts"] },
			},
			{
				id: "commit-late-1",
				name: "worktree_sync",
				arguments: { action: "git_commit", laneKey: "late", message: "Add the late module" },
			},
		]),
		{
			name: "land-late",
			check: (request) => {
				assertBatchOk(request, "integrate-late");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "land-late-1",
						name: "worktree_sync",
						arguments: { action: "land", laneKey: "late" },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "late-landed",
			check: (request) => {
				const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
				if (!landed) throw new Error(`the late lane did not land: ${JSON.stringify(latestBatchResults(request))}`);
			},
			reply: { content: [{ type: "text", text: "The late module landed." }] },
		},
	);
	await withDeadline(trace, "integration turn", session.prompt("Integrate the late lane's module."));
	if (world.systemOne.enabled) {
		expect(e0Counters.preflight, "the integrate turn's preflight is bound to its admitted boundary").toBeGreaterThan(
			0,
		);
		expect(
			e0Counters.postflight,
			"the integrate turn's postflight is bound to its admitted boundary",
		).toBeGreaterThan(0);
		// The integrate turn makes no tool-gate request, so the tool-gate stage is not exercised here. Evidence rows are not
		// asserted in this phase: the preflight may legitimately carry none before verification evidence is admitted.
	} else {
		expect(e0Counters, "off runs no System One and binds nothing").toEqual(zeroE0Counters());
	}
	trace.mark("root", "late.integrated");
	// E12 (executed worktree gate): a lane lands only through the gate command run in its worktree at its exact tip. A refused
	// gate leaves main unchanged; a tip that moves while the gate runs is refused, not merged; a gate that passes at the
	// unchanged tip lands it. The gate command is the owner's trusted setting, run by the shell port.
	world.settingsManager.applyOverrides({ worktreeSync: { gate: "on", gateCommand: E12_GATE } });
	world.provider.enqueue(
		"root",
		calls("e12-create", [
			{
				id: "e12-create-1",
				name: "worktree_sync",
				arguments: { action: "create_lane", laneKey: "e12", goalId: "retries-goal" },
			},
		]),
		dynamicCalls("e12-write", (request) => {
			e12LanePath = legendPath(request, "p/e12");
			return [
				{
					id: "e12-write-1",
					name: "write",
					arguments: { path: `${e12LanePath}/src/e12.ts`, content: "export const E12 = 1;\n" },
				},
			];
		}),
		calls("e12-commit", [
			{
				id: "e12-add-1",
				name: "worktree_sync",
				arguments: { action: "git_add", laneKey: "e12", paths: ["src/e12.ts"] },
			},
			{
				id: "e12-commit-1",
				name: "worktree_sync",
				arguments: { action: "git_commit", laneKey: "e12", message: "Add the E12 module" },
			},
		]),
		calls("e12-land-refused", [e12LandCall("e12-land-1")]),
		{
			name: "e12-refused-read",
			reply: { content: [{ type: "text", text: "The gate refused the first land." }] },
		},
		calls("e12-land-moved", [e12LandCall("e12-land-2")]),
		{ name: "e12-moved-read", reply: { content: [{ type: "text", text: "The gate refused the moved tip." }] } },
		calls("e12-land-passes", [e12LandCall("e12-land-3")]),
		{ name: "e12-landed-read", reply: { content: [{ type: "text", text: "The unchanged tip landed." }] } },
	);
	world.systemOne.enterPhase(
		"e12",
		{
			changes_model_pools: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "inspect", confidence: 0.97 },
			action_accomplished_step: { kind: "noul", probability: 0.02 },
			conclusions_supported: { kind: "noul", probability: 0.97 },
			scope_violation: { kind: "noul", probability: 0.02 },
			unrelated_behavior_change: { kind: "noul", probability: 0.02 },
			replan_required: { kind: "noul", probability: 0.02 },
			next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
		},
		{
			expect: ownerWords(
				"Create the e12 lane, commit its module, and land it through the gate.",
				"Land the e12 lane again while its gate runs.",
				"Land the e12 lane once its gate passes.",
				"Revise the e12 module and recover its checkout record.",
				"Reconcile the checkout record.",
			),
		},
	);
	const e12MainBefore = world.git.refSha("refs/heads/main");
	await withDeadline(
		trace,
		"E12 create, commit and refused land",
		session.prompt("Create the e12 lane, commit its module, and land it through the gate."),
		120_000,
	);
	expect(e12ToolText("e12-land-1"), "the gate command failed at the lane tip").toContain(
		"gate command failed (exit 1)",
	);
	expect(world.git.refSha("refs/heads/main"), "a refused gate leaves main unchanged").toBe(e12MainBefore);
	// The lane tip moves while its gate runs: the external writer commits in the lane, and only then is the gate released.
	const movedLanding = session.prompt("Land the e12 lane again while its gate runs.");
	await withDeadline(trace, "E12 gate reached", e12Reached.promise, 90_000);
	if (e12LanePath === undefined) throw new Error("the e12 lane path was never read from the request legend");
	world.io.writeFileSync(`${e12LanePath}/src/e12-late.ts`, "export const E12_LATE = 1;\n");
	const added = world.git.run(["add", "src/e12-late.ts"], e12LanePath, {});
	const committed = world.git.run(["commit", "-m", "External E12 change during the gate"], e12LanePath, {});
	if (added.code !== 0 || committed.code !== 0) {
		throw new Error(`the external lane commit failed: ${added.stderr}${committed.stderr}`);
	}
	e12Release.release();
	await withDeadline(trace, "E12 moved landing", movedLanding, 120_000);
	expect(e12ToolText("e12-land-2"), "a tip that moved during the gate is refused, not merged").toContain(
		"changed during the gate",
	);
	expect(world.git.refSha("refs/heads/main"), "the moved tip leaves main unchanged").toBe(e12MainBefore);
	// The unchanged tip's gate is held while the owner stages an unrelated tracked file in the hub. G6 allows unrelated
	// hub changes; refreshing the landed checkout must preserve both their bytes and their staged index identity.
	const ownerNotesBefore = String(world.io.readFileSync(notesPath, "utf8"));
	const ownerNotesStaged = "E12 owner notes staged during the land gate.\n";
	const ownerNotesIndex = () => {
		const status = world.git.run(["status", "--porcelain=v2", "-z"], HARNESS_PROJECT_CWD, {});
		if (status.code !== 0) throw new Error(`cannot read the owner's index: ${status.stderr}`);
		return status.stdout.split("\0").find((row) => row.endsWith(" src/notes.md"));
	};
	const passingLanding = session.prompt("Land the e12 lane once its gate passes.");
	let stagedIndex: string | undefined;
	try {
		await withDeadline(trace, "E12 passing gate reached before owner staging", e12OwnerReached.promise, 90_000);
		expect(world.git.refSha("refs/heads/main"), "the held gate has not moved main").toBe(e12MainBefore);
		world.io.writeFileSync(notesPath, ownerNotesStaged);
		const staged = world.git.run(["add", "--", "src/notes.md"], HARNESS_PROJECT_CWD, {});
		if (staged.code !== 0) throw new Error(`the owner's stage failed: ${staged.stderr}`);
		stagedIndex = ownerNotesIndex();
		expect(stagedIndex, "the actual hub index records the staged owner edit before gate release").toMatch(/^1 M\./);
	} finally {
		e12OwnerRelease.release();
	}
	await withDeadline(trace, "E12 passing landing", passingLanding, 120_000);
	const ownerAfterLand = {
		bytes: String(world.io.readFileSync(notesPath, "utf8")),
		index: ownerNotesIndex(),
		main: world.git.refSha("refs/heads/main"),
		lane: world.git.refSha("refs/heads/pi/wt/e12"),
		result: e12ToolText("e12-land-3"),
	};
	// Restore only this fixture's controlled owner edit after capturing the physical result, so later notes controls keep
	// their original baseline. Assertions below use the captured bytes/index, never the restored state.
	world.io.writeFileSync(notesPath, ownerNotesBefore);
	const restoredNotes = world.git.run(["add", "--", "src/notes.md"], HARNESS_PROJECT_CWD, {});
	if (restoredNotes.code !== 0) throw new Error(`the fixture notes restoration failed: ${restoredNotes.stderr}`);
	expect(
		ownerAfterLand.bytes,
		`E12 unrelated staged owner bytes survive land: ${JSON.stringify(ownerAfterLand)}`,
	).toBe(ownerNotesStaged);
	expect(ownerAfterLand.index, "the unrelated owner edit keeps its exact staged index identity").toBe(stagedIndex);
	let successfulLand = ownerAfterLand.result;
	if (!successfulLand.includes("LANDED")) {
		expect(ownerAfterLand.main, "a refused owner-edit overlap does not advance main").toBe(e12MainBefore);
		// Once the controlled owner edit is restored, the ordinary unchanged-tip retry must still land through its gate.
		world.shell.enqueue({ name: "e12-gate-retry", command: E12_GATE, output: "check passed", exitCode: 0 });
		world.provider.enqueue(
			"root",
			calls("e12-land-retry", [e12LandCall("e12-land-retry-1")]),
			text("e12-retry-read", "The unchanged tip landed."),
		);
		await withDeadline(
			trace,
			"E12 ordinary passing retry after owner edit restoration",
			session.prompt("Land the e12 lane once its gate passes."),
			120_000,
		);
		successfulLand = e12ToolText("e12-land-retry-1");
	}
	expect(successfulLand, "the passing gate lands the unchanged tip").toContain("LANDED");
	expect(world.git.refSha("refs/heads/main"), "main moves to the tested lane tip").toBe(
		world.git.refSha("refs/heads/pi/wt/e12"),
	);
	trace.mark("root", "e12.landed");
	// E12 persistence (post-CAS): the epoch record fails after main has moved, with the gate ON for both landings. The landing
	// transaction is the only durable record. Each reconcile is checked against the raw persisted epoch, transaction and event
	// log: the first on its own, the second against the first's bytes. No session getter stands in for persisted state here.
	const e12Record = (name: string): string | undefined => {
		for (const [path, content] of world.io.fileEntries()) {
			if (basename(path) === name) return content;
		}
		return undefined;
	};
	const e12EventLog = (): string => e12Record("events.jsonl") ?? "";
	let e12PreSecond:
		| { readonly epoch: string | undefined; readonly transaction: string | undefined; readonly events: string }
		| undefined;
	const e12Snapshot = () => ({
		epoch: e12Record("epoch.json"),
		transaction: e12Record("landing-transaction.json"),
		events: e12EventLog(),
	});
	const e12EpochEvents = (log: string): number =>
		log.split("\n").filter((line) => line.includes('"event":"epoch_reconciled"')).length;
	const e12EpochRecord = (): { readonly epoch?: number; readonly mainSha?: string } | undefined => {
		const text = e12Record("epoch.json");
		return text === undefined
			? undefined
			: (JSON.parse(text) as { readonly epoch?: number; readonly mainSha?: string });
	};
	const e12Transaction = (): { readonly stage?: string; readonly testedTipSha?: string } | undefined => {
		const text = e12Record("landing-transaction.json");
		return text === undefined
			? undefined
			: (JSON.parse(text) as { readonly stage?: string; readonly testedTipSha?: string });
	};
	const e12EpochFault = () =>
		world.io.failNext({
			name: "e12-epoch-rename-fails",
			kind: "rename",
			matches: (operation) => operation.destination?.endsWith("epoch.json") === true,
			code: "EIO",
			times: 1,
		});
	// A physical carry-forward succeeds, but persisting its completed marker fails. The old ready_to_merge record must
	// cause reconcile to repeat that same checkout transition before publishing an epoch, preserving live owner input.
	world.shell.enqueue({ name: "e12-checkout-gate", command: E12_GATE, output: "check passed", exitCode: 0 });
	const beforeEmptyCommit = world.git.refSha("refs/heads/pi/wt/e12");
	world.provider.enqueue(
		"root",
		calls("e12-checkout-empty-commit", [
			{
				id: "e12-checkout-empty-commit-1",
				name: "worktree_sync",
				arguments: { action: "git_commit", laneKey: "e12", message: "No changes before checkout recovery" },
			},
		]),
		dynamicCalls(
			"e12-checkout-edit",
			() => [
				{
					id: "e12-checkout-edit-1",
					name: "edit",
					arguments: {
						path: `${e12LanePath}/src/e12.ts`,
						edits: [{ oldText: "export const E12 = 1;", newText: "export const E12 = 2;" }],
					},
				},
			],
			() => {
				expect(
					lastToolResultDetails(session, "worktree_sync"),
					"ordinary empty commit returns the actual typed Git failure",
				).toMatchObject({ code: "git_failed", action: "git_commit", exitCode: 1 });
				expect(
					e12ToolText("e12-checkout-empty-commit-1"),
					"the empty-commit refusal is durably recorded",
				).toContain("nothing to commit");
				expect(
					world.git.refSha("refs/heads/pi/wt/e12"),
					"ordinary empty commit cannot manufacture a candidate revision",
				).toBe(beforeEmptyCommit);
				expect(world.git.refSha("refs/heads/main"), "ordinary empty commit leaves main unchanged").toBe(
					beforeEmptyCommit,
				);
			},
		),
		dynamicCalls(
			"e12-checkout-stage",
			() => [
				{
					id: "e12-checkout-add-1",
					name: "worktree_sync",
					arguments: { action: "git_add", laneKey: "e12", paths: ["src/e12.ts"] },
				},
			],
			(request) => {
				assertBatchOk(request, "E12 checkout edit");
				expect(
					world.io.readFileSync(`${e12LanePath}/src/e12.ts`, "utf8"),
					"the actual edit prepares module2 before staging",
				).toBe("export const E12 = 2;\n");
			},
		),
		dynamicCalls(
			"e12-checkout-commit",
			() => [
				{
					id: "e12-checkout-commit-1",
					name: "worktree_sync",
					arguments: { action: "git_commit", laneKey: "e12", message: "Revise the E12 module" },
				},
			],
			(request) => assertBatchOk(request, "E12 checkout stage"),
		),
		dynamicCalls(
			"e12-checkout-land",
			() => [e12LandCall("e12-checkout-land-1")],
			(request) => {
				assertBatchOk(request, "E12 checkout commit");
				const mainSha = world.git.refSha("refs/heads/main");
				const laneSha = world.git.refSha("refs/heads/pi/wt/e12");
				if (mainSha === undefined || laneSha === undefined) {
					throw new Error(`E12 committed candidate refs are missing: ${JSON.stringify({ mainSha, laneSha })}`);
				}
				const changed = world.git.run(["diff", "--name-only", `${mainSha}..${laneSha}`], HARNESS_PROJECT_CWD, {});
				expect(
					changed.code,
					`the committed candidate diff is readable before land: ${JSON.stringify({ mainSha, laneSha, stderr: changed.stderr })}`,
				).toBe(0);
				expect(
					changed.stdout.trim().split(/\r?\n/),
					"the actual candidate contains the module2 change before gate/refresh",
				).toContain("src/e12.ts");
			},
		),
		text("e12-checkout-read", "The checkout record needs recovery."),
		calls("e12-checkout-reconcile", [
			{ id: "e12-checkout-reconcile-1", name: "worktree_sync", arguments: { action: "reconcile" } },
		]),
		text("e12-checkout-reconciled", "The checkout record is settled."),
	);
	const replayOwnerStaged = "E12 owner index survives checkout recovery.\n";
	const replayOwnerWorking = `${replayOwnerStaged}Unstaged owner continuation.\n`;
	world.io.writeFileSync(notesPath, replayOwnerStaged);
	expect(world.git.run(["add", "--", "src/notes.md"], HARNESS_PROJECT_CWD, {}).code).toBe(0);
	const replayStagedIndex = ownerNotesIndex();
	expect(replayStagedIndex, "checkout recovery starts with an actual staged owner blob").toMatch(/^1 M\./);
	const replayEpochBefore = e12EpochRecord()?.epoch;
	world.io.failNext({
		name: "e12-checkout-marker-write-fails",
		kind: "write",
		code: "EIO",
		matches: (operation, data) =>
			operation.path.includes("landing-transaction.json") && data?.includes('"stage": "main_moved"') === true,
	});
	let replayFailure: { readonly error: unknown } | undefined;
	try {
		await withDeadline(
			trace,
			"E12 physical checkout before marker refusal",
			session.prompt("Revise the e12 module and recover its checkout record."),
			120_000,
		);
		const replayTip = world.git.refSha("refs/heads/pi/wt/e12");
		const replayBefore = {
			fault: world.io.consumedFaults.includes("e12-checkout-marker-write-fails"),
			transaction: e12Transaction(),
			main: world.git.refSha("refs/heads/main"),
			module: String(world.io.readFileSync(projectPath("src", "e12.ts"), "utf8")),
			epoch: e12EpochRecord()?.epoch,
			ownerBytes: String(world.io.readFileSync(notesPath, "utf8")),
			ownerIndex: ownerNotesIndex(),
			result: e12ToolText("e12-checkout-land-1"),
		};
		expect(
			replayBefore,
			`physical checkout completed before marker refusal: ${JSON.stringify(replayBefore)}`,
		).toMatchObject({
			fault: true,
			transaction: { stage: "ready_to_merge", testedTipSha: replayTip },
			main: replayTip,
			module: "export const E12 = 2;\n",
			epoch: replayEpochBefore,
			ownerBytes: replayOwnerStaged,
			ownerIndex: replayStagedIndex,
		});
		expect(replayBefore.result, "a failed completion marker never reports LANDED").not.toContain("LANDED");
		// An owner continues writing after the first physical refresh. Recovery must keep this distinct working copy too.
		world.io.writeFileSync(notesPath, replayOwnerWorking);
		const replayWorkingIndex = ownerNotesIndex();
		expect(replayWorkingIndex, "the recovery boundary carries staged plus unstaged owner edits").toMatch(/^1 MM/);
		const replayEventsBefore = e12EventLog();
		await withDeadline(
			trace,
			"E12 ready-to-merge checkout replay",
			session.prompt("Reconcile the checkout record."),
			120_000,
		);
		expect(
			e12ToolText("e12-checkout-reconcile-1"),
			"the actual owner reconciles the retained checkout record",
		).toContain("reconciled");
		expect(e12Transaction(), "checkout replay clears its durable transaction").toBeUndefined();
		expect(e12EpochRecord(), "checkout replay publishes exactly the next epoch for the tested tip").toMatchObject({
			epoch: (replayEpochBefore ?? 0) + 1,
			mainSha: replayTip,
		});
		expect(
			e12EpochEvents(e12EventLog()) - e12EpochEvents(replayEventsBefore),
			"checkout replay emits one epoch recovery event",
		).toBe(1);
		expect(world.io.readFileSync(notesPath, "utf8"), "checkout replay preserves the newer unstaged owner bytes").toBe(
			replayOwnerWorking,
		);
		expect(ownerNotesIndex(), "checkout replay preserves the exact staged blob and working-state record").toBe(
			replayWorkingIndex,
		);
		expect(world.git.refSha("refs/heads/main"), "replay does not move main beyond the tested tip").toBe(replayTip);
	} catch (error) {
		replayFailure = { error };
	}
	let restorationFailure: { readonly error: unknown } | undefined;
	try {
		world.io.writeFileSync(notesPath, ownerNotesBefore);
		const restored = world.git.run(["add", "--", "src/notes.md"], HARNESS_PROJECT_CWD, {});
		if (restored.code !== 0) throw new Error(`checkout recovery notes restoration failed: ${restored.stderr}`);
	} catch (error) {
		restorationFailure = { error };
	}
	if (replayFailure && restorationFailure)
		throw new AggregateError(
			[replayFailure.error, restorationFailure.error],
			"checkout recovery and restoration failed",
		);
	if (replayFailure) throw replayFailure.error;
	if (restorationFailure) throw restorationFailure.error;
	world.shell.enqueue(
		{
			name: "e12-persist-gate-first",
			command: E12_GATE,
			output: "check passed",
			exitCode: 0,
			check: (request) => {
				e12PersistGates.push({
					cwd: request.cwd,
					command: request.command,
					tip: world.git.refSha("refs/heads/pi/wt/e12"),
				});
			},
		},
		{
			name: "e12-persist-gate-second",
			command: E12_GATE,
			output: "check passed",
			exitCode: 0,
			check: (request) => {
				e12PersistGates.push({
					cwd: request.cwd,
					command: request.command,
					tip: world.git.refSha("refs/heads/pi/wt/e12"),
				});
			},
		},
	);
	world.shell.enqueue({
		name: "vitest-pass-integration",
		command: integrateVitest,
		output: integrationVitestOutput,
		exitCode: 0,
		check: () => {
			integrationAdmission = {
				mainSha: world.git.refSha("refs/heads/main"),
				limits: String(world.io.readFileSync(LIMITS_PATH, "utf8")),
				late: String(world.io.readFileSync(projectPath("src", "late.ts"), "utf8")),
			};
			if (world.io.readFileSync(LIMITS_PATH, "utf8") !== "export const MAX_RETRIES = 5;\n") {
				throw new Error("the run saw a limits value other than 5");
			}
			if (world.io.readFileSync(projectPath("src", "late.ts"), "utf8") !== "export const LATE = true;\n") {
				throw new Error("the run saw no landed late module");
			}
		},
	});
	// The gate stays on for both persistence landings: each runs its scripted gate command at the tested tip before the epoch fails.
	world.settingsManager.applyOverrides({ worktreeSync: { gate: "on", gateCommand: E12_GATE } });
	world.systemOne.enterPhase(
		"e12-persist",
		{
			changes_model_pools: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
			states_committed: { kind: "noul", probability: 0.02 },
			states_pushed: { kind: "noul", probability: 0.02 },
			states_published: { kind: "noul", probability: 0.02 },
			states_files_changed: { kind: "noul", probability: 0.97 },
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "inspect", confidence: 0.97 },
			action_accomplished_step: { kind: "noul", probability: 0.02 },
			conclusions_supported: { kind: "noul", probability: 0.97 },
			scope_violation: { kind: "noul", probability: 0.02 },
			unrelated_behavior_change: { kind: "noul", probability: 0.02 },
			replan_required: { kind: "noul", probability: 0.02 },
			next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
		},
		{
			expect: ownerWords(
				"Commit the post-gate module and land it while its epoch record cannot be written.",
				"Reconcile the landing record.",
				"Reconcile the landing record again.",
				"Write another module and land it under the same fault.",
				"Reconcile after the ref moved.",
				"Reconcile once the ref is repaired.",
			),
		},
	);
	world.provider.enqueue(
		"root",
		calls("e12p-write", [
			{
				id: "e12p-write-1",
				name: "write",
				arguments: { path: `${e12LanePath}/src/e12-persist.ts`, content: "export const E12_PERSIST = 1;\n" },
			},
		]),
		calls("e12p-commit", [
			{
				id: "e12p-add-1",
				name: "worktree_sync",
				arguments: { action: "git_add", laneKey: "e12", paths: ["src/e12-persist.ts"] },
			},
			{
				id: "e12p-commit-1",
				name: "worktree_sync",
				arguments: { action: "git_commit", laneKey: "e12", message: "Add the E12 persistence module" },
			},
		]),
		calls("e12p-land", [e12LandCall("e12p-land-1")]),
		{
			name: "e12p-landed-read",
			reply: { content: [{ type: "text", text: "The epoch record could not be written." }] },
		},
		calls("e12p-reconcile-1", [
			{ id: "e12p-reconcile-1", name: "worktree_sync", arguments: { action: "reconcile" } },
		]),
		{
			name: "e12p-first-read",
			reply: { content: [{ type: "text", text: "The first reconcile rolled the landing forward." }] },
		},
		dynamicCalls(
			"e12p-reconcile-2",
			() => [{ id: "e12p-reconcile-2", name: "worktree_sync", arguments: { action: "reconcile" } }],
			() => {
				e12PreSecond = e12Snapshot();
			},
		),
		{
			name: "e12p-reconciled-read",
			reply: { content: [{ type: "text", text: "The second reconcile found the record settled." }] },
		},
		calls("e12p-write-2", [
			{
				id: "e12p-write-2-1",
				name: "write",
				arguments: { path: `${e12LanePath}/src/e12-ambig.ts`, content: "export const E12_AMBIG = 1;\n" },
			},
		]),
		calls("e12p-commit-2", [
			{
				id: "e12p-add-2",
				name: "worktree_sync",
				arguments: { action: "git_add", laneKey: "e12", paths: ["src/e12-ambig.ts"] },
			},
			{
				id: "e12p-commit-2-1",
				name: "worktree_sync",
				arguments: { action: "git_commit", laneKey: "e12", message: "Add the E12 ambiguity module" },
			},
		]),
		calls("e12p-land-2", [e12LandCall("e12p-land-2-1")]),
		{
			name: "e12p-landed-2-read",
			reply: { content: [{ type: "text", text: "The second epoch record could not be written." }] },
		},
		calls("e12p-ambig", [{ id: "e12p-ambig-1", name: "worktree_sync", arguments: { action: "reconcile" } }]),
		{
			name: "e12p-ambig-read",
			reply: { content: [{ type: "text", text: "The ambiguous record is refused." }] },
		},
		calls("e12p-repair", [{ id: "e12p-repair-1", name: "worktree_sync", arguments: { action: "reconcile" } }]),
		{
			name: "e12p-repaired-read",
			reply: { content: [{ type: "text", text: "The repaired record is reconciled." }] },
		},
	);
	// First landing: the gate runs at the tested tip, then the epoch rename fails after main has moved; the transaction stays at main_moved.
	e12EpochFault();
	const epochBeforePersist = e12EpochRecord()?.epoch;
	await withDeadline(
		trace,
		"E12 persistence landing",
		session.prompt("Commit the post-gate module and land it while its epoch record cannot be written."),
		120_000,
	);
	const persistTip = world.git.refSha("refs/heads/pi/wt/e12");
	expect(world.shell.reached, "the first landing ran its scripted gate command").toContain("e12-persist-gate-first");
	expect(e12PersistGates[0], "the first gate ran in the exact lane worktree at the admitted tested tip").toEqual({
		cwd: e12LanePath,
		command: E12_GATE,
		tip: persistTip,
	});
	expect(world.git.refSha("refs/heads/main"), "main moved to the tested tip before the epoch failed").toBe(persistTip);
	expect(e12Transaction(), "the landing transaction stays at main_moved").toMatchObject({
		stage: "main_moved",
		testedTipSha: persistTip,
	});
	expect(e12EpochRecord()?.epoch, "the epoch record was not written").toBe(epochBeforePersist);
	const eventsBeforeFirst = e12EventLog();
	// R47w: the first reconcile's epoch rename fails twice with a share-mode EPERM. Each failure arms one backoff on the
	// session's worktree-sync clock, advanced as it is armed; the second arm is awaited before the first backoff fires.
	world.io.failNext({
		name: "e12-epoch-rename-transient",
		kind: "rename",
		matches: (operation) => operation.destination?.endsWith("epoch.json") === true,
		code: "EPERM",
		times: 2,
	});
	const e12Backoffs = world.timers.nextArmed("worktree-sync").then((firstMs) => {
		const second = world.timers.nextArmed("worktree-sync");
		world.timers.advance("worktree-sync", firstMs);
		return second.then((secondMs) => {
			world.timers.advance("worktree-sync", secondMs);
			return [firstMs, secondMs];
		});
	});
	// First reconcile, checked on its own against the raw persisted bytes.
	await withDeadline(trace, "E12 first reconcile", session.prompt("Reconcile the landing record."), 120_000);
	expect(
		await withDeadline(trace, "E12 epoch rename backoffs", e12Backoffs, 5_000),
		"the two transient renames armed the first two backoffs of the doubling ladder",
	).toEqual([WIN32_TRANSIENT_RETRY_MIN_MS, Math.min(WIN32_TRANSIENT_RETRY_MIN_MS * 2, WIN32_TRANSIENT_RETRY_MAX_MS)]);
	expect(world.timers.armedDelays("worktree-sync"), "the third rename landed, no backoff is left").toEqual([]);
	const firstCheckpoint = {
		epoch: e12Record("epoch.json"),
		transaction: e12Record("landing-transaction.json"),
		events: e12EventLog(),
	};
	expect(firstCheckpoint.transaction, "the first reconcile clears the landing transaction").toBeUndefined();
	expect(
		JSON.parse(firstCheckpoint.epoch ?? "null"),
		"the first reconcile writes the epoch once, for the tested tip",
	).toMatchObject({
		epoch: (epochBeforePersist ?? 0) + 1,
		mainSha: persistTip,
	});
	expect(
		e12EpochEvents(firstCheckpoint.events) - e12EpochEvents(eventsBeforeFirst),
		"the first reconcile appends exactly one epoch_reconciled audit event",
	).toBe(1);
	// The epoch bytes checked above are the record the third rename attempt replaced after the two backoffs.
	world.faultMatrix.witness("R47w", { control: false });
	world.faultMatrix.witness("R44", { control: false });
	// Second reconcile, checked against the first checkpoint's raw bytes: nothing persisted changes.
	await withDeadline(trace, "E12 second reconcile", session.prompt("Reconcile the landing record again."), 120_000);
	const secondCheckpoint = {
		epoch: e12Record("epoch.json"),
		transaction: e12Record("landing-transaction.json"),
		events: e12EventLog(),
	};
	expect(e12ToolText("e12p-reconcile-2"), "the second reconcile reports a settled record").toContain("reconciled");
	expect(
		secondCheckpoint,
		"the second reconcile leaves the persisted epoch, transaction and audit log unchanged",
	).toEqual(firstCheckpoint);
	world.faultMatrix.witness("R44", { control: true });
	expect(e12PreSecond, "the second provider check saw the first reconcile's settled state").toEqual(firstCheckpoint);
	expect(
		secondCheckpoint,
		"the post-second state equals the pre-second state captured at the second provider check",
	).toEqual(e12PreSecond);
	const epochAfterReconcile = e12EpochRecord()?.epoch;
	// A second landing under the same fault, then main is moved to a commit that is neither prior nor tested.
	e12EpochFault();
	await withDeadline(
		trace,
		"E12 second persistence landing",
		session.prompt("Write another module and land it under the same fault."),
		120_000,
	);
	const ambiguousTip = world.git.refSha("refs/heads/pi/wt/e12");
	expect(world.shell.reached, "the second landing ran its scripted gate command").toContain("e12-persist-gate-second");
	expect(e12PersistGates[1], "the second gate ran in the exact lane worktree at the admitted tested tip").toEqual({
		cwd: e12LanePath,
		command: E12_GATE,
		tip: ambiguousTip,
	});
	expect(world.git.refSha("refs/heads/main"), "the second landing moved main").toBe(ambiguousTip);
	expect(e12Transaction()?.stage, "the second transaction stays at main_moved").toBe("main_moved");
	// A rename failure outside the share-mode codes (the EIO epoch fault) fails at once. Only the R47w witness advances
	// the virtual worktree-sync clock, so a backoff armed here would have held the landing until its deadline: the
	// landing returning is the evidence, and nothing is left armed.
	expect(world.timers.armedDelays("worktree-sync"), "the second EIO epoch rename armed no backoff").toEqual([]);
	world.faultMatrix.witness("R47w", { control: true });
	expect(
		world.git.run(["update-ref", "refs/heads/main", e12MainBefore ?? ""], HARNESS_PROJECT_CWD, {}).code,
		"the external ref move succeeds",
	).toBe(0);
	const ambiguousTransactionBefore = e12Record("landing-transaction.json");
	await withDeadline(trace, "E12 ambiguous reconcile", session.prompt("Reconcile after the ref moved."), 120_000);
	expect(e12ToolText("e12p-ambig-1"), "an ambiguous landing is refused, not rolled forward").toContain("ambiguous");
	expect(e12Transaction()?.stage, "the ambiguous transaction is kept for its owner").toBe("main_moved");
	expect(e12Record("landing-transaction.json"), "the ambiguous reconcile keeps the transaction bytes exactly").toBe(
		ambiguousTransactionBefore,
	);
	expect(world.git.refSha("refs/heads/main"), "the ambiguous reconcile leaves the foreign main sha untouched").toBe(
		e12MainBefore,
	);
	expect(e12EpochRecord()?.epoch, "the ambiguous reconcile writes no epoch").toBe(epochAfterReconcile);
	// The owner repairs main to the tested tip: reconcile rolls the second landing forward and clears it.
	expect(
		world.git.run(["update-ref", "refs/heads/main", ambiguousTip ?? ""], HARNESS_PROJECT_CWD, {}).code,
		"the repair ref move succeeds",
	).toBe(0);
	await withDeadline(trace, "E12 repaired reconcile", session.prompt("Reconcile once the ref is repaired."), 120_000);
	expect(e12Transaction(), "the repaired reconcile clears the transaction").toBeUndefined();
	expect(e12EpochRecord(), "the repaired reconcile writes the second epoch").toMatchObject({
		epoch: (epochAfterReconcile ?? 0) + 1,
		mainSha: ambiguousTip,
	});
	world.settingsManager.applyOverrides({ worktreeSync: { gate: "off" } });
	trace.mark("root", "e12.persisted");
	world.systemOne.enterPhase(
		"complete",
		{
			...lateJudgments,
			shows_true_0: { kind: "noul", probability: 0.97 },
			shows_false_0: { kind: "noul", probability: 0.02 },
			shows_true_1: { kind: "noul", probability: 0.97 },
			shows_false_1: { kind: "noul", probability: 0.02 },
			shows_true_2: { kind: "noul", probability: 0.97 },
			shows_false_2: { kind: "noul", probability: 0.02 },
			shows_true_3: { kind: "noul", probability: 0.97 },
			shows_false_3: { kind: "noul", probability: 0.02 },
			shows_true_4: { kind: "noul", probability: 0.97 },
			shows_false_4: { kind: "noul", probability: 0.02 },
			shows_true_5: { kind: "noul", probability: 0.97 },
			shows_false_5: { kind: "noul", probability: 0.02 },
			shows_true_6: { kind: "noul", probability: 0.97 },
			shows_false_6: { kind: "noul", probability: 0.02 },
			shows_true_7: { kind: "noul", probability: 0.97 },
			shows_false_7: { kind: "noul", probability: 0.02 },
			shows_true_8: { kind: "noul", probability: 0.97 },
			shows_false_8: { kind: "noul", probability: 0.02 },
			shows_true_9: { kind: "noul", probability: 0.97 },
			shows_false_9: { kind: "noul", probability: 0.02 },
			shows_true_10: { kind: "noul", probability: 0.97 },
			shows_false_10: { kind: "noul", probability: 0.02 },
			shows_true_11: { kind: "noul", probability: 0.97 },
			shows_false_11: { kind: "noul", probability: 0.02 },
			shows_true_12: { kind: "noul", probability: 0.97 },
			shows_false_12: { kind: "noul", probability: 0.02 },
			shows_true_13: { kind: "noul", probability: 0.97 },
			shows_false_13: { kind: "noul", probability: 0.02 },
			shows_true_14: { kind: "noul", probability: 0.97 },
			shows_false_14: { kind: "noul", probability: 0.02 },
			shows_true_15: { kind: "noul", probability: 0.97 },
			shows_false_15: { kind: "noul", probability: 0.02 },
			shows_true_16: { kind: "noul", probability: 0.97 },
			shows_false_16: { kind: "noul", probability: 0.02 },
			shows_true_17: { kind: "noul", probability: 0.97 },
			shows_false_17: { kind: "noul", probability: 0.02 },
			shows_true_18: { kind: "noul", probability: 0.97 },
			shows_false_18: { kind: "noul", probability: 0.02 },
			shows_true_19: { kind: "noul", probability: 0.97 },
			shows_false_19: { kind: "noul", probability: 0.02 },
			shows_true_20: { kind: "noul", probability: 0.97 },
			shows_false_20: { kind: "noul", probability: 0.02 },
			shows_true_21: { kind: "noul", probability: 0.97 },
			shows_false_21: { kind: "noul", probability: 0.02 },
			shows_true_22: { kind: "noul", probability: 0.97 },
			shows_false_22: { kind: "noul", probability: 0.02 },
			shows_true_23: { kind: "noul", probability: 0.97 },
			shows_false_23: { kind: "noul", probability: 0.02 },
			shows_true_24: { kind: "noul", probability: 0.97 },
			shows_false_24: { kind: "noul", probability: 0.02 },
			shows_true_25: { kind: "noul", probability: 0.97 },
			shows_false_25: { kind: "noul", probability: 0.02 },
			shows_true_26: { kind: "noul", probability: 0.97 },
			shows_false_26: { kind: "noul", probability: 0.02 },
			outcomes_achieved: { kind: "noul", probability: 0.97 },
			required_behavior_unverified: { kind: "noul", probability: 0.02 },
			material_claim_unsupported: { kind: "noul", probability: 0.02 },
			missing_requirement: { kind: "noul", probability: 0.02 },
		},
		{
			expect: (request) => {
				ownerWords(
					"Retire the workers and complete the goal.",
					"Change the stage one line of the notes file.",
					"Re-read the notes file.",
				)(request);
				if ("shows_true_26" in request.questions) {
					if (!isRecordObject(request.state)) throw new Error("the change account has no decoded state");
					expect(
						Object.keys(request.state).filter((key) => /^s\d+$/.test(key)),
						"all twelve change accounts plus the assumption and regressions reach review",
					).toHaveLength(27);
					expect(request.state, "landed files survive later shared-checkout path observations").toMatchObject({
						s2: "Exports the LATE flag from the late module.",
						e2: expect.stringContaining("src/late.ts"),
						s18: "Adds the module an external writer committed while the gate ran; the moved tip was refused, and this file landed with the unchanged tip.",
						e18: expect.stringContaining("src/e12-late.ts"),
					});
					expect(request.state.e2, "the late account receives the actual landed patch").toContain(
						"+export const LATE = true;",
					);
					expect(request.state.e18, "the external commit account receives its landed patch").toContain(
						"+export const E12_LATE = 1;",
					);
				}
				if (world.systemOne.enabled) {
					const controller = session.systemOneController;
					if (controller === undefined)
						throw new Error("the E0 complete phase has no bound System One controller");
					bindE0Request(request, controller.store.snapshot(), session.messages.length, e0Counters);
					const integration = session
						.getGoalStateSnapshot()
						?.evidence.find((item) => item.uri === "verify-integration-1");
					if (integration !== undefined) {
						const observation = controller.store
							.snapshot()
							.observations.find(
								(o) =>
									o.freshness === "fresh" &&
									o.source.content_hash === integration.id &&
									o.source.locator === integration.uri,
							);
						if (observation !== undefined && isRecordObject(request.state)) {
							const carries = (rows: unknown) =>
								Array.isArray(rows) && rows.some((row) => isRecordObject(row) && row.id === observation.id);
							if (carries(request.state.evidence_view)) e0Counters.integrationPreflightRows += 1;
							if (carries(request.state.new_evidence)) e0Counters.integrationPostflightRows += 1;
						}

						bindE0Completion(
							request,
							controller.store.snapshot(),
							session.getGoalStateSnapshot()?.requirements ?? [],
							integration,
							e0Counters,
						);
					}
				}
				if (world.systemOne.enabled)
					checkCompletionItems(request, {
						requirementText: COMPLETION_REQUIREMENT_TEXT,
						evidenceIds: durableGoalEvidenceIds(created.sessionManager),
					});
			},
		},
	);
	world.provider.enqueue(
		"root",
		dynamicCalls("retire-workers", (request) => [
			{
				id: "retire-a-1",
				name: "delegate",
				arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-a") },
			},
			{
				id: "retire-b-1",
				name: "delegate",
				arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-b") },
			},
		]),
		{
			name: "workers-retired",
			check: (request) => {
				const retirements = latestBatchResults(request).filter((result) => result.toolName === "delegate");
				if (
					retirements.length !== 2 ||
					retirements.some((result) => result.isError || !result.text.includes("retired"))
				) {
					throw new Error(`the delegated workers were not both retired: ${JSON.stringify(retirements)}`);
				}
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "goal-req-1",
						name: "goal",
						arguments: {
							action: "add_requirement",
							text: COMPLETION_REQUIREMENT_TEXT,
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		calls("goal-read", [{ id: "goal-read-1", name: "goal", arguments: { action: "get" } }]),
		calls("vitest-integration", [
			{ id: "verify-integration-1", name: "bash", arguments: { command: integrateVitest } },
		]),
		dynamicCalls(
			"add-integration-evidence",
			(request) => [
				{
					id: "evidence-integration-1",
					name: "goal",
					arguments: {
						action: "add_evidence",
						kind: "test",
						uri: "verify-integration-1",
						summary: "vitest passed: MAX_RETRIES is 5 and the late module is landed",
						requirementIds: [requirementIdOf(request)],
					},
				},
			],
			(request) => assertBatchOk(request, "vitest-integration"),
		),
		dynamicCalls("complete-goal", (request) => {
			const ids = evidenceIdsOf(request);
			const requirement = requirementIdOf(request);
			const integrationEvidence = session
				.getGoalStateSnapshot()
				?.evidence.find((item) => item.uri === "verify-integration-1");
			if (integrationEvidence === undefined)
				throw new Error("the native goal state holds no integration evidence for the account");
			return [
				{
					id: "complete-goal-1",
					name: "goal",
					arguments: {
						action: "complete",
						account: {
							changes: [
								{
									path: "src/limits.ts",
									reason: "Raises MAX_RETRIES to 5 for the retries lane.",
									evidenceIds: [integrationEvidence.id],
									serves: [requirement],
								},
								{
									path: "src/late.ts",
									reason: "Exports the LATE flag from the late module.",
									evidenceIds: [integrationEvidence.id],
									serves: [requirement],
								},
								{
									path: `${HARNESS_PROJECT_CWD}:e10/shared/a.txt`,
									reason: "Writes the shared file A: the held writer of the overlap proof.",
									serves: [requirement],
								},
								{
									path: `${HARNESS_PROJECT_CWD}:e10/shared/nested/b.txt`,
									reason: "Writes the nested file B: the queued writer admitted after A's release.",
									serves: [requirement],
								},
								{
									path: `${HARNESS_PROJECT_CWD}:e10/other/c/c.txt`,
									reason: "Writes the disjoint file C: the writer that completed beside the held scope.",
									serves: [requirement],
								},
								{
									path: "e10/shared/a.txt",
									reason: "Writes the shared file A: the held writer of the overlap proof.",
									serves: [requirement],
								},
								{
									path: "e10/shared/nested/b.txt",
									reason: "Writes the nested file B: the queued writer admitted after A's release.",
									serves: [requirement],
								},
								{
									path: "e10/other/c/c.txt",
									reason: "Writes the disjoint file C: the writer that completed beside the held scope.",
									serves: [requirement],
								},
								{
									path: "src/e12.ts",
									reason: "Adds the E12 module, landed through the executed gate at its tested tip.",
									serves: [requirement],
								},
								{
									path: "src/e12-late.ts",
									reason:
										"Adds the module an external writer committed while the gate ran; the moved tip was refused, and this file landed with the unchanged tip.",
									serves: [requirement],
								},
								{
									path: "src/e12-persist.ts",
									reason:
										"Adds the persistence module: its landing's epoch record failed and reconcile rolled it forward once.",
									serves: [requirement],
								},
								{
									path: "src/e12-ambig.ts",
									reason:
										"Adds the ambiguity module: its landing was reconciled only after main was repaired to the tested tip.",
									serves: [requirement],
								},
							],
							assumptions: [{ claim: "the limits test checks the retry count", evidenceIds: [ids[0]] }],
							regressions: [
								{ path: "src/limits.ts", evidenceIds: [ids[0]] },
								{ path: "src/late.ts", evidenceIds: [ids[0]] },
							],
						},
					},
				},
			];
		}),
		{
			name: "goal-completed",
			check: (request) => {
				assertBatchOk(request, "complete-goal");
				if (!latestBatchResults(request).some((result) => result.text.includes("goal complete recorded"))) {
					throw new Error("the host did not record the goal as complete");
				}
			},
			reply: { content: [{ type: "text", text: "The goal is complete." }] },
		},
	);
	await withDeadline(
		trace,
		"retirement and completion turn",
		session.prompt("Retire the workers and complete the goal."),
	);
	trace.mark("root", "goal.completed");
	if (world.systemOne.enabled) {
		expect(
			world.systemOne.decoded.filter(
				(request) => request.phase === "complete" && "shows_true_26" in request.questions,
			),
			"the complete change account reaches the transport exactly once",
		).toHaveLength(1);
		const native = {
			requirementText: COMPLETION_REQUIREMENT_TEXT,
			evidenceIds: durableGoalEvidenceIds(created.sessionManager),
		};
		const linkedRequest = world.systemOne.decoded.find(
			(request) => request.phase === "complete" && checkCompletionItems(request, native) > 0,
		);
		if (linkedRequest === undefined) throw new Error("no completion request carried a criterion statement");
		const linkedState = linkedRequest.state as Record<string, unknown>;
		const linkedKey = Object.keys(linkedState).find(
			(key) => /^s\d+$/.test(key) && String(linkedState[key]).startsWith(CRITERION_STATEMENT_PREFIX),
		);
		if (linkedKey === undefined) throw new Error("the linked request names no criterion statement key");
		const index = linkedKey.slice(1);
		expect(
			checkCompletionItems(linkedRequest, native),
			"the criterion statements carry the admitted requirement and evidence",
		).toBeGreaterThan(0);
		// Freshness, verified-flag agreement: each cited evidence line's marker must agree with the native ledger's verified flag, and the admitted
		// integration evidence must be verified with a passing test receipt on its own bash result. This proves the flag agreement only; it does not
		// establish that the evidence postdates any edit.
		const fLedger = session.getGoalStateSnapshot()?.evidence ?? [];
		expect(
			checkEvidenceMarkers(linkedRequest, new Map(fLedger.map((item) => [item.id, item.verified === true]))),
			"each cited evidence marker agrees with the native ledger's verified flag",
		).toBeGreaterThan(0);
		const fIntegration = fLedger.find((item) => item.uri === "verify-integration-1");
		const fCitedInPost = Object.values(linkedState).some(
			(value) => typeof value === "string" && new RegExp(`^${fIntegration?.id}:`, "m").test(value),
		);
		expect(fCitedInPost, "the completion POST cites the admitted integration evidence").toBe(true);
		if (world.systemOne.enabled) {
			expect(
				e0Counters.completionOutcomeRows,
				"a completion outcome row selects the admitted integration observation",
			).toBeGreaterThan(0);
			expect(
				e0Counters.acceptanceMatrixRequests,
				"a completion request transports the acceptance matrix",
			).toBeGreaterThan(0);
			expect(
				e0Counters.verificationMatrixRequests,
				"a completion request transports the verification matrix, empty or not",
			).toBeGreaterThan(0);
			expect(
				session.getVerificationObligations(),
				"the completed goal leaves no open verification obligation",
			).toEqual([]);
		}
		if (world.systemOne.enabled) {
			expect(
				e0Counters.integrationPreflightRows + e0Counters.integrationPostflightRows,
				"the completion phase transports the admitted integration observation in a preflight or postflight row",
			).toBeGreaterThan(0);
		}
		expect(integrationAdmission, "the integration verification captured its admission state").toBeDefined();
		expect(world.git.refSha("refs/heads/main"), "main is unchanged since the integration admission").toBe(
			integrationAdmission?.mainSha,
		);
		expect(
			world.io.readFileSync(LIMITS_PATH, "utf8"),
			"the limits file is unchanged since the integration admission",
		).toBe(integrationAdmission?.limits);
		expect(
			world.io.readFileSync(projectPath("src", "late.ts"), "utf8"),
			"the landed module is unchanged since the integration admission",
		).toBe(integrationAdmission?.late);
		expect(fIntegration?.verified, "the admitted integration evidence is verified by the ledger").toBe(true);
		const fReceipt = created.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "verify-integration-1",
			);
		const fDetails =
			fReceipt?.type === "message" && fReceipt.message.role === "toolResult" ? fReceipt.message.details : undefined;
		expect(
			typeof fDetails === "object" && fDetails !== null && "piVerification" in fDetails
				? fDetails.piVerification
				: undefined,
			"the integration evidence is backed by its own passing test receipt",
		).toMatchObject({ status: "passed", outcome: "executed", evidence: "tests" });
		// Negative controls on the decoded POST: each tampering is rejected by the oracle before any answer.
		expect(() =>
			checkCompletionItems(
				{
					...linkedRequest,
					state: {
						...linkedState,
						[`s${index}`]: `${CRITERION_STATEMENT_PREFIX}A requirement the goal never admitted.`,
					},
				},
				native,
			),
		).toThrow("does not name the native requirement");
		expect(() =>
			checkCompletionItems(
				{
					...linkedRequest,
					state: { ...linkedState, [`e${index}`]: "ev-00000000: an evidence line the goal never admitted" },
				},
				native,
			),
		).toThrow("cites evidence the goal never admitted");
		expect(() =>
			checkCompletionItems(
				{
					...linkedRequest,
					questions: {
						...linkedRequest.questions,
						shows_true_99: {
							type: "noul",
							instructions: "Does `e99` show that `s99` is true?",
							criteria: { true: "a", false: "b" },
						},
					},
				},
				native,
			),
		).toThrow("which the decoded state does not carry");
	}
	// Off retains no transport body: the oracle never ran, and nothing was decoded or recorded.
	expect(
		world.systemOne.enabled ? [] : world.systemOne.decoded,
		"off retains zero decoded transport bodies",
	).toHaveLength(0);

	expect(session.getGoalStateSnapshot()?.status, "the mixed host records completion in either mode").toBe("completed");
	expect(
		getLatestGoalStateSnapshot(created.sessionManager)?.status,
		"the mixed persisted goal agrees with the completed host",
	).toBe("completed");

	world.provider.enqueue(
		"root",
		calls("read-notes", [{ id: "read-notes-1", name: "read", arguments: { path: notesPath } }]),
		{
			name: "stale-edit",
			check: () => {
				heldDescriptor = world.io.openSync(notesPath, "r");
				world.io.writeFileSync(`${notesPath}.tmp`, "stage two\n");
				world.io.renameSync(`${notesPath}.tmp`, notesPath);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "stale-edit-1",
						name: "edit",
						arguments: { path: notesPath, edits: [{ oldText: "stage one", newText: "stage three" }] },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "stale-edit-refused",
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (!edit?.isError || !edit.text.includes("Could not find the exact text")) {
					throw new Error(`the stale edit was not refused: ${edit?.text ?? "no edit result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The stale edit was refused." }] },
		},
	);
	await withDeadline(trace, "stale replacement turn", session.prompt("Change the stage one line of the notes file."));
	if (heldDescriptor === undefined) throw new Error("the held descriptor was never opened");
	expect(world.readDescriptorText(heldDescriptor, 64), "a held descriptor keeps the node it opened").toBe(
		"stage one\n",
	);
	world.closeDescriptor(heldDescriptor);
	expect(world.io.readFileSync(notesPath, "utf8"), "the path shows the replacement").toBe("stage two\n");

	// The refused edit is followed by a successful read before the restart: the refusal is resolved by the next successful call.
	world.provider.enqueue(
		"root",
		calls("reread-notes", [{ id: "reread-notes-1", name: "read", arguments: { path: notesPath } }]),
		text("reread-reported", "The notes file is read again."),
	);
	// The refused edit is still an active recovery record, so the loop asks the model once more after the reply.
	await withDeadline(trace, "notes re-read turn", session.prompt("Re-read the notes file."));
	// Restart. The root session is disposed, then reopened from its persisted file by its owner. The reopened session's
	// first request must carry every legend line the first session showed: alias ids are restored, not re-minted.
	// The first session is disposed once the goal is complete: no admission or work-remaining question is pending.
	// The goal is complete: disposing the first session asks no admission or work-remaining question.
	world.systemOne.enterPhase("restart-disposal", {});
	expect(
		await world.disposeSessionInBody(session),
		"the root session must dispose before the restart",
	).toBeUndefined();
	const rootFile = created.sessionManager.getSessionFile();
	if (rootFile === undefined) throw new Error("the mixed root session has no file");
	const restartedRoot = await world.createRootSession("root", {
		sessionManager: world.openSessionManager(rootFile),
	});
	const restarted = restartedRoot.session;
	expect(restarted.getGoalStateSnapshot()?.status, "restart preserves the completed goal").toBe("completed");
	expect(
		getLatestGoalStateSnapshot(restartedRoot.sessionManager)?.status,
		"the reopened durable goal remains completed",
	).toBe("completed");
	// The restored prompt is a new root turn: its post-flight stage asks the turn-outcome questions, and the answer is a
	// completed step with its conclusions supported.
	// The restored prompt's admission does not ask whether the grounding is sufficient: the disposal above asks it.

	// The restored prompt is a new root turn: its post-flight stage asks the turn-outcome questions; the completed goal leaves no open work.
	const restartOwnerWords = (...userRequests: string[]) =>
		expectOwnerWords({
			sessionManager: () => restartedRoot.sessionManager,
			userRequests,
			optionalToolNames: ["secret_store"],
		});
	world.systemOne.enterPhase(
		"restart",
		{
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "reason", confidence: 0.97 },
			action_accomplished_step: { kind: "noul", probability: 0.97 },
			conclusions_supported: { kind: "noul", probability: 0.97 },
			scope_violation: { kind: "noul", probability: 0.02 },
			unrelated_behavior_change: { kind: "noul", probability: 0.02 },
			replan_required: { kind: "noul", probability: 0.02 },
			next_status: { kind: "choice", choice: "completion_candidate", confidence: 0.97 },
		},
		{ expect: restartOwnerWords("Continue after the restart.") },
	);
	world.provider.enqueue("root", {
		name: "restored-legend",
		check: (request) => {
			const lines = legendLinesOf(request);
			if (legendAtIntegration.length === 0) throw new Error("no legend was shown before the restart");
			const missing = legendAtIntegration.filter((line) => !lines.includes(line));
			if (missing.length > 0) throw new Error(`the restored request lost legend lines: ${missing.join(" | ")}`);
		},
		reply: { content: [{ type: "text", text: "Restored and continuing." }] },
	});
	await withDeadline(trace, "restored root turn", restarted.prompt("Continue after the restart."));
	trace.mark("root", "restart.reply");
	await withDeadline(trace, "restored foreground settled", restarted.waitForForegroundIdle(), 60_000);

	expect(world.io.readFileSync(projectPath("src", "limits.ts"), "utf8"), toolOutcomes(session)).toBe(
		"export const MAX_RETRIES = 5;\n",
	);
	expect(world.io.readFileSync(projectPath("src", "owner.md"), "utf8")).toBe(OWNER_DRAFT_DIRTY);

	// ICM mixed/recovery (M1-M5), after the owner's restart above. Each part runs under its own agent directory.
	expect(
		await world.disposeSessionInBody(restarted),
		"the restored root disposes before the ICM parts",
	).toBeUndefined();
}

/** The one requirement of an R38 goal, its evidence (trusted only when `verified`), and the goal completed over it. */
function completedGoalOver(goalId: string, verified: boolean) {
	const now = "2026-01-01T00:00:00.000Z";
	const events: GoalEvent[] = [
		{ type: "add_requirement", id: "req-limit", text: "MAX_RETRIES is 5.", now },
		{ type: "add_evidence", id: "ev-limit", kind: "file", summary: "src/limits.ts holds 5.", verified, now },
		{ type: "satisfy_requirement", id: "req-limit", evidenceIds: ["ev-limit"], now },
		// No acceptance override: the completion stands only on trusted evidence.
		{ type: "complete_goal", now },
	];
	let state = createGoalState({ goalId, userGoal: "Raise MAX_RETRIES to 5.", now });
	for (const event of events) state = applyGoalEvent(state, event);
	return state;
}

/** The reopen warnings `world` holds after `from`. */
function reopenWarnings(world: HarnessWorld, from: number): string[] {
	return world.warnings.slice(from).filter((message) => message.includes("lack trusted evidence"));
}

/** A fresh root session over `goal`, persisted as its only goal state. */
async function sessionOverGoal(world: HarnessWorld, goal: GoalState): Promise<AgentSession> {
	const manager = SessionManager.inMemory(HARNESS_PROJECT_CWD);
	appendGoalStateSnapshot(manager, goal);
	const session = (await world.createRootSession("root", { sessionManager: manager })).session;
	expect(session.getGoalStateSnapshot()?.status, "the persisted goal starts completed").toBe("completed");
	return session;
}

/**
 * R38 (System One on) and R38e (off). A completed goal whose requirement lacks trusted evidence, with no acceptance
 * override, is a persisted state the completion gate never writes (an earlier version's file). One continuation pass
 * reopens it to active with one warning and runs no turn: on, through the reconcile its route evaluation starts with;
 * off, at the legacy continuation entry, with no System One request. The control is the same pass over the same goal
 * with trusted evidence: it stays completed, asks System One nothing and runs no turn. R38l follows at the next phase
 * boundary.
 */
export async function runJourney3UnprovenCompletionPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const on = world.systemOne.enabled;
	const row = on ? "R38" : "R38e";
	const phase = "r38-unproven-completion";
	// The route evaluation asks JEV-004 once, for the reopened goal only.
	world.systemOne.enterPhase(phase, {
		work_remaining: { kind: "noul", probability: 0.97 },
		missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
		evidence_sufficient: { kind: "noul", probability: 0.02 },
		semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
		strategy_repetition: { kind: "noul", probability: 0.02 },
		context_stale: { kind: "noul", probability: 0.02 },
		independent_worker_required: { kind: "noul", probability: 0.02 },
		capability_escalation_required: { kind: "noul", probability: 0.02 },
		capability_gap_suspected: { kind: "noul", probability: 0.02 },
		completion_plausible: { kind: "noul", probability: 0.02 },
	});
	const askedInPhase = () => world.systemOne.decoded.filter((request) => request.phase === phase).length;
	// A route evaluation is the phase's one JEV-004 request; a turn is any provider request, scripted or not.
	const routeAsked = () =>
		world.systemOne.decoded.some((request) => request.phase === phase && "completion_plausible" in request.questions);
	const providerRequests = () => world.provider.requests.length;

	const unproven = await sessionOverGoal(world, completedGoalOver("r38-unproven", false));
	expect(unproven.executionLoopMode, "the witness runs the mode's default loop").toBe(
		on ? "objective_primary" : "legacy_goal",
	);
	const unprovenWarnings = world.warnings.length;
	const unprovenRequests = providerRequests();
	const reopened = await withDeadline(trace, "R38 reopen", unproven.continueGoalOnce({ maxStallTurns: 3 }));
	expect(
		{
			submitted: reopened.submitted,
			status: unproven.getGoalStateSnapshot()?.status,
			warnings: reopenWarnings(world, unprovenWarnings),
			routeEvaluated: routeAsked(),
			turns: providerRequests() - unprovenRequests,
		},
		"the unproven completion reopens to active with one warning, evaluating a route only on, and runs no turn",
	).toEqual({
		submitted: false,
		status: "active",
		warnings: [
			"Goal r38-unproven completion not supported: requirement(s) req-limit lack trusted evidence; the goal stays active to gather it.",
		],
		routeEvaluated: on,
		turns: 0,
	});
	world.faultMatrix.witness(row, { control: false });

	const proven = await sessionOverGoal(world, completedGoalOver("r38-proven", true));
	const provenWarnings = world.warnings.length;
	const provenAsked = askedInPhase();
	const provenRequests = providerRequests();
	const kept = await withDeadline(trace, "R38 kept", proven.continueGoalOnce({ maxStallTurns: 3 }));
	expect(
		{
			submitted: kept.submitted,
			status: proven.getGoalStateSnapshot()?.status,
			warnings: reopenWarnings(world, provenWarnings),
			asked: askedInPhase() - provenAsked,
			turns: providerRequests() - provenRequests,
		},
		"a completion its trusted evidence supports stays completed, evaluates no route and runs no turn",
	).toEqual({ submitted: false, status: "completed", warnings: [], asked: 0, turns: 0 });
	world.faultMatrix.witness(row, { control: true });

	expect(await world.disposeSessionInBody(unproven), "the reopened goal's session disposes").toBeUndefined();
	expect(await world.disposeSessionInBody(proven), "the completed goal's session disposes").toBeUndefined();
	trace.mark("root", "r38.unproven-completion");
	await runJourney3UnprovenLoopPhase(world);
}

/**
 * R38l, both modes. The continuation loop over the same unsupported completion (`/goal-continue`) does not stop at the
 * completed status: it reopens the goal with one warning and runs the reopened goal's work, one root turn. On, the
 * primary loop's guard lets the goal through, the first cycle reopens it and the next one admits the objective (JEV-001
 * to JEV-003), routes it and runs that turn, judged as the journey 2 objective cycle; off, the legacy entry reopens it
 * and the native loop runs the turn. The control is the loop over a completion its trusted evidence supports: it stops
 * at once, completed, with no System One request and no turn.
 */
async function runJourney3UnprovenLoopPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const phase = "r38-loop-reopen";
	world.systemOne.enterPhase(phase, {
		objective_coherent: { kind: "noul", probability: 0.97 },
		ambiguity_severity: { kind: "score", level: 0, confidence: 1 },
		missing_information: { kind: "noul", probability: 0.02 },
		acceptance_complete: { kind: "noul", probability: 0.97 },
		grounding_sufficient: { kind: "noul", probability: 0.97 },
		work_remaining: { kind: "noul", probability: 0.97 },
		missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
		evidence_sufficient: { kind: "noul", probability: 0.02 },
		semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
		strategy_repetition: { kind: "noul", probability: 0.02 },
		context_stale: { kind: "noul", probability: 0.02 },
		independent_worker_required: { kind: "noul", probability: 0.02 },
		capability_escalation_required: { kind: "noul", probability: 0.02 },
		capability_gap_suspected: { kind: "noul", probability: 0.02 },
		completion_plausible: { kind: "noul", probability: 0.02 },
		step_relevant: { kind: "noul", probability: 0.97 },
		evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
		unsupported_assumption_present: { kind: "noul", probability: 0.02 },
		route: { kind: "choice", choice: "inspect", confidence: 0.97 },
		// The reopened goal's implement-route turn is judged as journey 2's implement cycle judges its worker claim and patch.
		claim_supported: { kind: "noul", probability: 0.97 },
		patch_matches_requirements: { kind: "noul", probability: 0.97 },
		side_effects_acceptable: { kind: "noul", probability: 0.97 },
		action_accomplished_step: { kind: "noul", probability: 0.02 },
		conclusions_supported: { kind: "noul", probability: 0.97 },
		scope_violation: { kind: "noul", probability: 0.02 },
		unrelated_behavior_change: { kind: "noul", probability: 0.02 },
		replan_required: { kind: "noul", probability: 0.02 },
		next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
	});
	const askedInPhase = () => world.systemOne.decoded.filter((request) => request.phase === phase).length;

	const unproven = await sessionOverGoal(world, completedGoalOver("r38-loop", false));
	const unprovenWarnings = world.warnings.length;
	const unprovenReached = world.provider.reached.length;
	world.provider.enqueue("root", text("r38-loop-root", "The reopened goal gathers its evidence."));
	const reopened = await withDeadline(
		trace,
		"R38l reopen loop",
		unproven.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 }),
		120_000,
	);
	expect(
		{
			stopReason: reopened.stopReason,
			turnsSubmitted: reopened.turnsSubmitted,
			status: unproven.getGoalStateSnapshot()?.status,
			warnings: reopenWarnings(world, unprovenWarnings),
			reached: world.provider.reached.slice(unprovenReached),
		},
		"the loop reopens the unproven completion with one warning and runs the reopened goal's one root turn",
	).toEqual({
		stopReason: "max_turns_reached",
		turnsSubmitted: 1,
		status: "active",
		warnings: [
			"Goal r38-loop completion not supported: requirement(s) req-limit lack trusted evidence; the goal stays active to gather it.",
		],
		reached: ["root:r38-loop-root"],
	});
	world.faultMatrix.witness("R38l", { control: false });

	const proven = await sessionOverGoal(world, completedGoalOver("r38-loop-proven", true));
	const provenWarnings = world.warnings.length;
	const provenAsked = askedInPhase();
	const provenRequests = world.provider.requests.length;
	const kept = await withDeadline(
		trace,
		"R38l kept loop",
		proven.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 }),
		120_000,
	);
	expect(
		{
			stopReason: kept.stopReason,
			turnsSubmitted: kept.turnsSubmitted,
			status: proven.getGoalStateSnapshot()?.status,
			warnings: reopenWarnings(world, provenWarnings),
			asked: askedInPhase() - provenAsked,
			turns: world.provider.requests.length - provenRequests,
		},
		"the loop over a completion its trusted evidence supports stops at once, completed, asking nothing",
	).toEqual({
		stopReason: "continuation_not_allowed",
		turnsSubmitted: 0,
		status: "completed",
		warnings: [],
		asked: 0,
		turns: 0,
	});
	world.faultMatrix.witness("R38l", { control: true });

	expect(await world.disposeSessionInBody(unproven), "the reopened loop's session disposes").toBeUndefined();
	expect(await world.disposeSessionInBody(proven), "the completed loop's session disposes").toBeUndefined();
	trace.mark("root", "r38.loop-reopen");
}
