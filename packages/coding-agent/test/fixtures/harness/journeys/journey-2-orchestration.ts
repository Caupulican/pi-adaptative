import "../builtin-install.ts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	type BackgroundToolTaskRecord,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "../../../../src/core/background-tool-task-controller.ts";
import { WorkerConversationStore } from "../../../../src/core/delegation/worker-conversation-store.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "../../../../src/core/delegation/worker-mailbox-record.ts";
import { WORKER_TERMINAL_OUTPUT_INLINE_BYTES } from "../../../../src/core/delegation/worker-terminal-output-artifact.ts";
import { getLatestGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import type { ScriptedRequest } from "../scripted-provider.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	agentIdForTrack,
	assertBatchOk,
	backgroundTaskIdOf,
	CAPTURED_ACCESS,
	CHECKPOINT_SUMMARY,
	delegateResultTexts,
	dynamicCalls,
	expectOwnerWords,
	handoffFor,
	LIMITS_PATH,
	lanesOf,
	lastToolResultDetails,
	latestAgentIdForTrack,
	latestBatchResults,
	mailboxMessagesOf,
	matchedSubmitReceiptIn,
	persistedGenerationText,
	receiptsOf,
	requestTexts,
	settlementFacts,
	toolOutcomes,
} from "./shared.ts";

export async function runJourney2OrchestrationPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const allReported = createBarrier();
	const workersMayRead = createBarrier();
	let blockedAgentId: string | undefined;
	let mainBeforeApproval: string | undefined;
	const scratchDir = projectPath("scratch");
	const scratchGit = `${scratchDir}/.git`;
	let orchestrationRoot: AgentSession | undefined;
	// The same captured reference, in a second world: its own file resolves, and the first world's file does not.
	await expect(CAPTURED_ACCESS(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
	await expect(CAPTURED_ACCESS(projectPath("src", "copy-source.ts"), constants.R_OK)).rejects.toThrow(
		"virtual filesystem",
	);

	world.provider.enqueue(
		"root",
		calls("goal-start", [
			{
				id: "goal-1",
				name: "goal",
				arguments: { action: "start", goalId: "limits-goal", userGoal: "Set MAX_RETRIES to 5." },
			},
		]),
		calls("goal-requirement", [
			{ id: "goal-2", name: "goal", arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" } },
		]),
		calls("dispatch-three", [
			{
				id: "dispatch-a",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					instructions: "Inspect the limits file and report whether the retry count is confirmed.",
				},
			},
			{
				id: "dispatch-b",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-b" },
					instructions: "Inspect the limits file and report the current value.",
				},
			},
			{
				id: "dispatch-c",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-c" },
					instructions: "Inspect the limits file and report the current value.",
				},
			},
		]),
		calls("status-overlap", [{ id: "status-overlap-1", name: "worktree_sync", arguments: { action: "status" } }]),
		{
			name: "overlap-checked",
			check: (request) => {
				const root = orchestrationRoot;
				if (root === undefined) throw new Error("the root session is not created yet");
				const lanes = lanesOf(lastToolResultDetails(root, "worktree_sync"));
				const bound = lanes.flatMap((lane) => (lane.boundLaneId === undefined ? [] : [lane.boundLaneId]));
				const agents = ["worker-a", "worker-b", "worker-c"].map((track) => agentIdForTrack(request, track));
				if (bound.length !== agents.length || !agents.every((id) => bound.includes(id))) {
					throw new Error(`worker lanes are not bound to their agents: ${JSON.stringify(lanes)}`);
				}
				const paths = lanes.map((lane) => lane.worktreePath);
				if (new Set(paths).size !== paths.length) throw new Error(`lane checkouts collide: ${paths.join(", ")}`);
				// Approval while the workers are active: a harmless scratch .git is removed only after the operator approves it.
				mainBeforeApproval = world.git.refSha("refs/heads/main");
				world.io.mkdirSync(scratchDir, { recursive: true });
				world.io.writeFileSync(scratchGit, "gitdir: nowhere\n");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "bash-denied-1",
						name: "bash",
						arguments: { command: "rm -rf scratch/.git" },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "approval-denied-reported",
			check: (request) => {
				const denied = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (!denied?.isError || !denied.text.includes("declined")) {
					throw new Error(`the denied removal was not refused by the operator: ${denied?.text ?? "no result"}`);
				}
				if (world.shell.requests.length !== 0 || !world.io.existsSync(scratchGit)) {
					throw new Error("a denied removal reached the shell or removed the scratch .git");
				}
			},
			reply: {
				content: [
					{ type: "toolCall", id: "read-between-approval", name: "read", arguments: { path: LIMITS_PATH } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "approval-read-between",
			check: (request) => assertBatchOk(request, "approval-denied-reported"),
			reply: {
				content: [
					{
						type: "toolCall",
						id: "bash-approved-1",
						name: "bash",
						arguments: { command: "rm -rf scratch/.git" },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "approval-approved-reported",
			check: (request) => {
				assertBatchOk(request, "approval-read-between");
				if (world.shell.requests.length !== 1 || world.io.existsSync(scratchGit)) {
					throw new Error("the approved removal did not run exactly once");
				}
				if (
					world.git.refSha("refs/heads/main") !== mainBeforeApproval ||
					!world.io.existsSync(projectPath(".git"))
				) {
					throw new Error("the approval touched the main repository");
				}
				workersMayRead.release();
			},
			reply: { content: [{ type: "text", text: "Dispatched three agents; waiting for their reports." }] },
		},
		{
			name: "follow-up-blocked-agent",
			reply: (request) => {
				const blockedAgent = agentIdForTrack(request, "worker-a");
				blockedAgentId = blockedAgent;
				return {
					content: [
						{
							type: "toolCall",
							id: "follow-a",
							name: "delegate",
							arguments: {
								action: "follow_up",
								agentId: blockedAgent,
								message: "The confirmed retry count is 5.",
							},
						},
					],
					stopReason: "toolUse",
				};
			},
		},
		text("root-after-follow-up", "Reply sent to the blocked agent."),
		// Terminal handoffs may coalesce into fewer root turns, so the step stays at the head until the
		// production context carries every worker's successful terminal handoff.
		{
			name: "reports-received",
			until: (request) => {
				const handoffs = request.context.messages
					.flatMap((message) =>
						message.role === "user" && typeof message.content !== "string" ? message.content : [],
					)
					.map((block) => (block.type === "text" ? block.text : ""))
					.filter((text) => text.includes("Background worker terminal handoff"))
					.join("\n");
				const done = [
					/- mailbox-turn-[0-9a-f]+: succeeded reason=worker_completed[\s\S]*?Retry count confirmed as 5\./,
					/- worker-2: succeeded/,
					/- worker-3: succeeded/,
				].every((pattern) => pattern.test(handoffs));
				if (done) allReported.release();
				return done;
			},
			reply: (request) => {
				const handoffs = JSON.stringify(request.context.messages);
				const done = /- worker-3: succeeded/.test(handoffs);
				return {
					content: [
						{
							type: "text",
							text: done ? "All three agents reported." : "Waiting for the remaining reports.",
						},
					],
				};
			},
		},
	);
	world.provider.enqueue(
		"worker-a",
		{
			name: "worker-a-read",
			gate: workersMayRead.promise,
			reply: {
				content: [{ type: "toolCall", id: "wa-read", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		calls("worker-a-blocked", [
			{
				id: "wa-report-blocked",
				name: "submit_report",
				arguments: {
					status: "blocked",
					summary: "Need the owner to confirm the retry count.",
					blockers: ["Owner must confirm the retry count."],
				},
			},
		]),
		calls("worker-a-resumed", [
			{
				id: "wa-report",
				name: "submit_report",
				arguments: { status: "completed", summary: "Retry count confirmed as 5." },
			},
		]),
	);
	world.provider.enqueue(
		"worker-b",
		{
			name: "worker-b-read",
			gate: workersMayRead.promise,
			reply: {
				content: [{ type: "toolCall", id: "wb-read", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		calls("worker-b-report", [
			{
				id: "wb-report",
				name: "submit_report",
				arguments: { status: "completed", summary: "Current value is 3." },
			},
		]),
	);
	world.provider.enqueue(
		"worker-c",
		{
			name: "worker-c-read",
			gate: workersMayRead.promise,
			reply: {
				content: [{ type: "toolCall", id: "wc-read", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		calls("worker-c-report", [
			{
				id: "wc-report",
				name: "submit_report",
				arguments: { status: "completed", summary: "Current value is 3." },
			},
		]),
	);

	// File-backed root: the checkpoint below reopens it from its session file, as its owner would after a restart.
	let created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	let session = created.session;
	orchestrationRoot = session;
	const warnings: string[] = [];
	session.subscribe((event) => {
		if (event.type === "warning") warnings.push(event.message);
	});
	trace.mark("root", "session.created");

	// The goal turn: the owner's request is not small talk and names no tool or delivery rule; before any
	// worker reports, no action has accomplished the step, so postflight holds the plan on `continue`.
	// Owner-word oracle for each phase: the owner words System One classifies must be this phase's own inputs, and the
	// previous intent must be the native ledger's. The expected values come from scenario literals and the session's entries.
	const ownerWords = (...userRequests: string[]) =>
		expectOwnerWords({
			sessionManager: () => created.sessionManager,
			userRequests,
			optionalToolNames: ["secret_store"],
		});
	world.systemOne.enterPhase(
		"orchestration-goal",
		{
			capabilities_authorized: { kind: "noul", probability: 0.02 },
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
		},
		{
			expect: ownerWords(
				"Goal: set MAX_RETRIES to 5 in the limits file. Dispatch agents to confirm it and report back.",
			),
		},
	);
	trace.mark("root", "owner.task");
	// The operator answers the destructive-removal confirmation: deny the first attempt, approve the revised one.
	const decisions: Array<"deny" | "allow-once"> = ["deny", "allow-once"];
	const askedOperations: string[] = [];
	const confirmations = world.externalConfirmations;
	session.setEdgeConfirmation(async (request) => {
		askedOperations.push(request.operation);
		confirmations.asked += 1;
		confirmations.inFlight += 1;
		try {
			// The operator's answer settles after a turn of the event loop: the callback is genuinely in flight meanwhile.
			await new Promise((resolve) => setImmediate(resolve));
			return decisions.shift() ?? "deny";
		} finally {
			confirmations.inFlight -= 1;
			confirmations.settled += 1;
		}
	});
	world.shell.enqueue({
		name: "approved-scratch-removal",
		command: "rm -rf scratch/.git",
		cwd: HARNESS_PROJECT_CWD,
		output: "",
		exitCode: 0,
		effect: () => {
			world.io.rmSync(scratchGit, { force: true });
		},
	});
	await withDeadline(
		trace,
		"orchestration task turn",
		session.prompt("Goal: set MAX_RETRIES to 5 in the limits file. Dispatch agents to confirm it and report back."),
	);
	trace.mark("root", "owner.task.settled");
	session.setEdgeConfirmation(undefined);
	expect(
		{ ...confirmations, decisionsLeft: decisions.length },
		"every asked confirmation settled, none in flight, no decision left over",
	).toEqual({ asked: askedOperations.length, inFlight: 0, settled: askedOperations.length, decisionsLeft: 0 });
	expect(askedOperations, "the operator is asked once per attempt").toHaveLength(2);
	expect(askedOperations.every((operation) => operation.includes("rm -rf scratch/.git"))).toBe(true);
	// Delegation admission is observable as soon as the dispatch turn settles: every start must be admitted.
	const admissions = delegateResultTexts(session);
	expect(
		admissions.map((text) => text.includes("delegate started (running)")),
		`delegate admission outcomes\n${toolOutcomes(session)}\nwarnings: ${warnings.join(" | ")}`,
	).toEqual([true, true, true]);

	await withDeadline(trace, "all agent reports delivered", allReported.promise, 30_000).catch((error: unknown) => {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
	});
	trace.mark("root", "all-reports-received");
	// Durable receipt, read from the persisted mailbox file rather than from scripted claims: the follow-up the operator sent
	// to the blocked agent is delivered, and its control receipt is recorded in that agent's mailbox on disk.
	if (blockedAgentId === undefined) throw new Error("the blocked agent's follow-up was never sent");
	const mailboxFile = workerMailboxPath(world.agentDir, created.sessionManager.getSessionId(), blockedAgentId);
	expect(world.io.existsSync(mailboxFile), "the worker mailbox is written to the virtual tree").toBe(true);
	const { mailbox } = readWorkerMailboxRecord(mailboxFile);
	const followUp = mailboxMessagesOf(mailbox).find((message) => message.content === "The confirmed retry count is 5.");
	expect(followUp?.deliveredAt, "the follow-up is delivered in the persisted mailbox").toEqual(expect.any(String));
	expect(
		receiptsOf(mailbox).filter((receipt) => receipt.messageId === followUp?.messageId && receipt.kind === "control"),
		"the follow-up has exactly one durable control receipt",
	).toHaveLength(1);
	// The reports release the barrier while the root turn that answers them is still finishing; the operator waits for idle.
	await withDeadline(trace, "root idle after the reports", session.waitForForegroundIdle());

	// Steering phase. The fourth agent is held at its provider gate until the interrupt is in place, so the halt is taken
	// at its next request boundary. Its handoff reports `worker_interrupted`; retirement keeps the binding and transcript.
	const fourthReached = createBarrier();
	const fourthGate = createBarrier();
	const handedOff = createBarrier();
	const retired = createBarrier();
	world.provider.enqueue(
		"worker-c",
		{
			name: "fourth-read",
			check: () => fourthReached.release(),
			gate: fourthGate.promise,
			reply: {
				content: [{ type: "toolCall", id: "fourth-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		text("fourth-halted", "Halted before a value was confirmed."),
	);
	world.provider.enqueue(
		"root",
		calls("start-fourth", [
			{
				id: "start-4",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-c" },
					instructions: "Read the limits file and report the value.",
				},
			},
		]),
		text("fourth-started", "Fourth agent started and running."),
		dynamicCalls(
			"interrupt-fourth",
			(request) => [
				{
					id: "interrupt-4",
					name: "delegate",
					arguments: {
						action: "interrupt",
						agentId: latestAgentIdForTrack(request, "worker-c"),
						message: "The operator halts the fourth agent.",
					},
				},
			],
			(request) => assertBatchOk(request, "start-fourth"),
		),
		{
			name: "interrupt-sent",
			check: (request) => {
				assertBatchOk(request, "interrupt-fourth");
				const sent = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (!sent?.text.includes("halt requested"))
					throw new Error(`the interrupt was not accepted: ${sent?.text ?? "no result"}`);
				fourthGate.release();
			},
			reply: { content: [{ type: "text", text: "Interrupt sent." }] },
		},
		dynamicCalls(
			"retire-fourth",
			(request) => [
				{
					id: "retire-4",
					name: "delegate",
					arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-c") },
				},
			],
			(request) => {
				if (!JSON.stringify(request.context.messages).includes("worker_interrupted")) {
					throw new Error("the halted agent's handoff does not report worker_interrupted");
				}
				handedOff.release();
			},
		),
		{
			name: "retired",
			check: (request) => {
				assertBatchOk(request, "retire-fourth");
				const gone = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (!gone?.text.includes("retired"))
					throw new Error(`the retirement was not recorded: ${gone?.text ?? "no result"}`);
				retired.release();
			},
			reply: { content: [{ type: "text", text: "Fourth agent retired." }] },
		},
	);
	world.systemOne.enterPhase(
		"steer-start",
		{
			capabilities_authorized: { kind: "noul", probability: 0.02 },
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
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "inspect", confidence: 0.97 },
		},
		{ expect: ownerWords("Start a fourth agent on the third track.") },
	);
	await withDeadline(trace, "fourth agent started", session.prompt("Start a fourth agent on the third track."));
	await withDeadline(trace, "fourth agent reached its gate", fourthReached.promise);
	world.systemOne.enterPhase(
		"steer-interrupt",
		{
			capabilities_authorized: { kind: "noul", probability: 0.02 },
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
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "inspect", confidence: 0.97 },
		},
		{ expect: ownerWords("Interrupt the fourth agent.") },
	);
	await withDeadline(trace, "operator interrupts the fourth agent", session.prompt("Interrupt the fourth agent."));
	await withDeadline(trace, "interrupted agent handed off", handedOff.promise, 60_000);
	await withDeadline(trace, "interrupted agent retired", retired.promise, 60_000);

	await withDeadline(trace, "interrupt turn settled", session.waitForForegroundIdle(), 90_000);
	world.systemOne.enterPhase("objective-cycle", {
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
		action_accomplished_step: { kind: "noul", probability: 0.02 },
		conclusions_supported: { kind: "noul", probability: 0.97 },
		scope_violation: { kind: "noul", probability: 0.02 },
		unrelated_behavior_change: { kind: "noul", probability: 0.02 },
		replan_required: { kind: "noul", probability: 0.02 },
		next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
	});
	world.provider.enqueue("root", text("objective-cycle-root", "Objective cycle reply."));
	const cycle = await withDeadline(
		trace,
		"objective cycle",
		session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 }),
		120_000,
	);
	trace.mark("root", "objective-cycle.settled");
	expect(session.executionLoopMode, "the root uses its normal loop for the selected mode").toBe(
		world.systemOne.enabled ? "objective_primary" : "legacy_goal",
	);
	expect(session.systemOneController !== undefined, "only the enabled mode binds System One").toBe(
		world.systemOne.enabled,
	);
	expect(
		session.objectiveExecutionController !== undefined,
		"the semantic objective controller is bound only with System One; off uses the native goal loop",
	).toBe(world.systemOne.enabled);
	expect(session.getActiveToolNames(), "the root keeps goal and delegate on its foreground surface").toEqual(
		expect.arrayContaining(["goal", "delegate"]),
	);
	const lastRoute = session.objectiveExecutionController?.getLastRoute();
	if (world.systemOne.enabled) {
		expect(lastRoute, "System One routed the objective live during the journey").toBeDefined();
		expect(lastRoute?.route, "System One's preflight route is applied to the objective").toBe("retrieve");
		expect(lastRoute?.reason_codes).toContain("system_one_preflight_retrieve");
	} else {
		expect(lastRoute, "normal goal continuation needs no semantic objective route").toBeUndefined();
	}
	expect(cycle.stopReason, "the bounded cycle submitted its one root turn").toBe("max_turns_reached");
	expect(cycle.turnsSubmitted).toBe(1);

	// Replay through the public admission API. The same idempotency key admitted twice is one durable message and one
	// worker turn: the second admission returns the first message's id and starts nothing. The persisted mailbox proves it.
	if (blockedAgentId === undefined) throw new Error("the blocked agent id was not recorded");
	const operatorNote = "Operator note: MAX_RETRIES is 5.";
	const replayKey = "operator-note-1";
	const workerTurnsBefore = world.provider.reached.filter((step) => step.startsWith("worker-a:")).length;
	const noteReached = createBarrier();
	const handoffReached = createBarrier();
	world.provider.enqueue("worker-a", {
		name: "replay-note-reply",
		check: () => noteReached.release(),
		reply: { content: [{ type: "text", text: "Noted: MAX_RETRIES is 5." }] },
	});
	world.provider.enqueue("root", {
		name: "replay-handoff-reply",
		check: () => handoffReached.release(),
		reply: { content: [{ type: "text", text: "The worker acknowledged the operator note." }] },
	});
	const firstAdmission = session.backgroundLanes.followUpSessionRootWorkerAgent(blockedAgentId, operatorNote, {
		idempotencyKey: replayKey,
	});
	if (!firstAdmission.started)
		throw new Error(`first admission: ${JSON.stringify({ ...firstAdmission, record: undefined })}`);
	await withDeadline(trace, "worker noted the operator note", noteReached.promise, 60_000);
	await withDeadline(trace, "worker handoff turn", handoffReached.promise, 60_000);
	await withDeadline(trace, "first admission turn settled", session.waitForForegroundIdle(), 60_000);
	const replayAdmission = session.backgroundLanes.followUpSessionRootWorkerAgent(blockedAgentId, operatorNote, {
		idempotencyKey: replayKey,
	});
	expect(replayAdmission.messageId, "a replayed key names the same durable message").toBe(firstAdmission.messageId);
	expect(replayAdmission.started, "a replayed key starts no second worker turn").toBe(false);
	await withDeadline(trace, "replay settled", session.waitForForegroundIdle(), 60_000);
	expect(
		world.provider.reached.filter((step) => step.startsWith("worker-a:")).length - workerTurnsBefore,
		"exactly one worker turn ran for the two admissions",
	).toBe(1);
	const replayMailbox = readWorkerMailboxRecord(
		workerMailboxPath(world.agentDir, created.sessionManager.getSessionId(), blockedAgentId),
	).mailbox;
	expect(
		mailboxMessagesOf(replayMailbox).filter((message) => message.messageId === firstAdmission.messageId),
		"one durable message per idempotency key",
	).toHaveLength(1);

	// Verification with a held lane. While a failed run's obligation is open, a held worker waits at its provider gate and a quick
	// worker completes; production refuses completion while the held lane is goal-owned and active, and after both workers are
	// retired the still-open obligation alone refuses it. Each Vitest run checks the file value it reports on: the failing run
	// sees a revision of 4, and the passing recheck follows a real edit back to 5.
	const VITEST_COMMAND = "vitest run test/limits.test.ts";
	const vitestFailed = ["Test Files  1 failed (1)\n", "Tests  1 failed (1)\n"];
	const vitestPassed = ["Test Files  1 passed (1)\n", "Tests  1 passed (1)\n"];
	// The same command run from another directory is a different verification identity: its pass must not clear the
	// obligation the failure opened in the project directory.
	const GAP5_DIR = projectPath("gap5", "elsewhere");
	const gap5Command = `cd gap5/elsewhere && ${VITEST_COMMAND}`;
	const limitsIs = (value: number): void => {
		const actual = world.io.readFileSync(LIMITS_PATH, "utf8");
		if (actual !== `export const MAX_RETRIES = ${value};\n`) {
			throw new Error(`the run saw ${JSON.stringify(actual)}, expected MAX_RETRIES = ${value}`);
		}
	};
	// The background verification run starts after the passing setup and is held until after the newer failure, so it
	// completes with the revision-era obligation already open. Its shell step sits between the two foreground runs.
	const backgroundVerifyGate = createBarrier();
	let backgroundVerifyTaskId: string | undefined;
	world.shell.enqueue(
		{
			name: "vitest-pass-setup",
			command: VITEST_COMMAND,
			output: vitestPassed,
			exitCode: 0,
			check: () => limitsIs(5),
		},
		{
			name: "vitest-pass-background",
			command: VITEST_COMMAND,
			output: vitestPassed,
			exitCode: 0,
			gate: backgroundVerifyGate.promise,
		},
		{
			name: "vitest-fail-revision",
			command: VITEST_COMMAND,
			output: vitestFailed,
			exitCode: 1,
			check: () => limitsIs(4),
		},
		{
			name: "vitest-pass-elsewhere",
			command: gap5Command,
			output: vitestPassed,
			exitCode: 0,
			resultCwd: GAP5_DIR,
			check: () => limitsIs(4),
		},
		{
			name: "vitest-pass-recheck",
			command: VITEST_COMMAND,
			output: vitestPassed,
			exitCode: 0,
			check: () => limitsIs(5),
		},
	);
	const requirementFrom = (request: ScriptedRequest): string => {
		const goal = latestBatchResults(request).find((result) => result.toolName === "goal");
		const match = /req-[0-9a-f]+/.exec(goal?.text ?? "");
		if (!match) throw new Error(`no requirement id in the goal state: ${goal?.text ?? "no goal result"}`);
		return match[0];
	};
	// The goal tool's get text lists ids only for open or unproven requirements; a requirement that already has trusted
	// evidence (the rechecked goal's) is neither, so the host's goal state is the source of its id.
	const goalRequirementId = (): string => {
		const requirements = session.getGoalStateSnapshot()?.requirements ?? [];
		if (requirements.length !== 1)
			throw new Error(`expected the goal to hold one requirement, found ${requirements.length}`);
		return requirements[0]!.id;
	};
	const refusedGoal = (request: ScriptedRequest, label: string, diagnostic: string): void => {
		const refused = latestBatchResults(request).find((result) => result.toolName === "goal");
		if (!refused?.isError || !refused.text.includes(diagnostic)) {
			throw new Error(
				`${label}: expected a refusal naming "${diagnostic}", got ${refused?.text ?? "no goal result"}`,
			);
		}
	};
	const verifyJudgments = {
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
		capabilities_authorized: { kind: "noul", probability: 0.02 },
	} as const;
	const operationClasses = {
		leaves_machine: { kind: "noul", probability: 0.02 },
		cannot_be_undone: { kind: "noul", probability: 0.02 },
		touches_outside_task: { kind: "noul", probability: 0.02 },
		acquires_external_code: { kind: "noul", probability: 0.02 },
		request_authorizes: { kind: "noul", probability: 0.02 },
	} as const;
	const completionStates = {
		states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
		states_committed: { kind: "noul", probability: 0.02 },
		states_pushed: { kind: "noul", probability: 0.02 },
		states_published: { kind: "noul", probability: 0.02 },
		states_files_changed: { kind: "noul", probability: 0.97 },
	} as const;
	const completionJudgments = {
		outcomes_achieved: { kind: "noul", probability: 0.97 },
		required_behavior_unverified: { kind: "noul", probability: 0.02 },
		material_claim_unsupported: { kind: "noul", probability: 0.02 },
		missing_requirement: { kind: "noul", probability: 0.02 },
	} as const;
	const quickHandedOff = createBarrier();
	const heldHandedOff = createBarrier();
	const heldMayRead = createBarrier();
	// The held worker waits at its first request until the root releases it; the quick worker completes at once.
	world.provider.enqueue(
		"worker-b",
		{
			name: "held-read",
			gate: heldMayRead.promise,
			reply: {
				content: [{ type: "toolCall", id: "held-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		calls("held-report", [
			{
				id: "held-report-1",
				name: "submit_report",
				arguments: { status: "completed", summary: "The held value is read." },
			},
		]),
	);
	world.provider.enqueue(
		"worker-c",
		calls("quick-read", [{ id: "quick-read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
		calls("quick-report", [
			{
				id: "quick-report-1",
				name: "submit_report",
				arguments: { status: "completed", summary: "The quick value is read." },
			},
		]),
	);
	// Setup: the limit is set to 5 and the passing run becomes evidence for the requirement.
	world.systemOne.enterPhase(
		"verify-setup",
		{
			...verifyJudgments,
			...operationClasses,
			...completionStates,
			// The setup answer reports the passing run as recorded evidence: a current-work success claim.
			states_tests_pass: { kind: "choice", choice: "current_success", confidence: 0.97 },
		},
		{ expect: ownerWords("Set the limit to 5 and record the passing run.") },
	);
	world.provider.enqueue(
		"root",
		calls("edit-to-five", [
			{
				id: "edit-five-1",
				name: "edit",
				arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }] },
			},
		]),
		calls("vitest-pass", [{ id: "verify-pass-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
		calls("background-verify-start", [
			{ id: "background-verify-1", name: "bash", arguments: { command: VITEST_COMMAND, background: true } },
		]),
		{
			name: "background-verify-started",
			check: (request) => {
				backgroundVerifyTaskId = backgroundTaskIdOf(request);
			},
			reply: {
				content: [{ type: "toolCall", id: "goal-get-1", name: "goal", arguments: { action: "get" } }],
				stopReason: "toolUse",
			},
		},
		dynamicCalls(
			"add-evidence",
			(request) => [
				{
					id: "evidence-1",
					name: "goal",
					arguments: {
						action: "add_evidence",
						kind: "test",
						uri: "verify-pass-1",
						summary: "vitest passed: MAX_RETRIES is 5",
						requirementIds: [requirementFrom(request)],
					},
				},
			],
			(request) => assertBatchOk(request, "goal-get"),
		),
		text("evidence-recorded", "The passing run is recorded as evidence."),
	);
	await withDeadline(trace, "verification setup", session.prompt("Set the limit to 5 and record the passing run."));
	trace.mark("root", "verification.setup");
	// Revision: the limit is changed to 4, the test fails, and two workers start: one held, one quick.
	world.systemOne.enterPhase(
		"verify-revision",
		{ ...verifyJudgments, ...completionStates },
		{ expect: ownerWords("Revise the limit to 4, run the test, and start the checks.") },
	);
	world.provider.enqueue(
		"root",
		calls("edit-to-four", [
			{
				id: "edit-four-1",
				name: "edit",
				arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 5", newText: "MAX_RETRIES = 4" }] },
			},
		]),
		calls("vitest-fail", [{ id: "verify-fail-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
		calls("start-held", [
			{
				id: "start-held-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-b" },
					instructions: "Read src/limits.ts and report its value once the owner releases you.",
				},
			},
		]),
		calls("start-quick", [
			{
				id: "start-quick-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-c" },
					instructions: "Read src/limits.ts and report its value.",
				},
			},
		]),
		text("revision-started", "The revision failed its test; two checks are running."),
	);
	world.provider.enqueue(
		"root",
		// The quick worker's terminal handoff starts this root turn while the held worker still waits at its gate.
		{
			name: "quick-handoff",
			check: (request) => {
				if (!JSON.stringify(request.context.messages).includes("The quick value is read.")) {
					throw new Error("the quick worker's handoff is not in the root turn");
				}
				quickHandedOff.release();
			},
			reply: {
				content: [{ type: "text", text: "The quick check is reported; the held check is still running." }],
			},
		},
	);
	await withDeadline(
		trace,
		"revision turn",
		session.prompt("Revise the limit to 4, run the test, and start the checks."),
	);
	trace.mark("root", "verification.revised");
	await withDeadline(trace, "quick worker handed off", quickHandedOff.promise, 90_000);
	await withDeadline(trace, "quick handoff turn settled", session.waitForForegroundIdle(), 90_000);
	// The other lane completed; the held lane is still running, so completion is refused by the goal-owned lane.
	world.systemOne.enterPhase(
		"verify-refused",
		{ ...verifyJudgments, ...completionStates },
		{ expect: ownerWords("Check whether the goal can complete now.") },
	);
	world.provider.enqueue(
		"root",
		calls("complete-refused", [{ id: "complete-1", name: "goal", arguments: { action: "complete" } }]),
		{
			name: "refusal-reported",
			check: (request) => {
				refusedGoal(request, "completion while the held lane runs", "goal-owned worker lane(s) are still active");
			},
			reply: { content: [{ type: "text", text: "Completion waits for the held check." }] },
		},
	);
	await withDeadline(trace, "refused completion", session.prompt("Check whether the goal can complete now."));
	trace.mark("root", "completion.refused");
	if (world.provider.reached.includes("worker-b:held-report")) {
		throw new Error("the held worker reported before the owner released it");
	}
	// The held lane is released: it reads, reports, and its handoff starts a root turn.
	world.systemOne.enterPhase("verify-held", completionStates);
	world.provider.enqueue("root", {
		name: "held-handoff",
		check: (request) => {
			if (!JSON.stringify(request.context.messages).includes("The held value is read.")) {
				throw new Error("the held worker's handoff is not in the root turn");
			}
			heldHandedOff.release();
		},
		reply: { content: [{ type: "text", text: "Both checks are reported." }] },
	});
	heldMayRead.release();
	await withDeadline(trace, "held worker handed off", heldHandedOff.promise, 90_000);
	await withDeadline(trace, "held handoff turn settled", session.waitForForegroundIdle(), 90_000);
	// The older pass completes first; then both workers are retired and the open obligation alone refuses completion.
	// The reply that reports the old pass is a historical claim: no current success exists for the newer failure.
	world.systemOne.enterPhase(
		"verify-obligation",
		{
			...verifyJudgments,
			...completionStates,
			states_tests_pass: { kind: "choice", choice: "historical_only", confidence: 0.97 },
		},
		{ expect: ownerWords("Retire the checks and check completion again.") },
	);
	// The older background pass completes now, after the newer failure. Its handoff runs its own root turn, and the
	// obligation the failure opened must survive it: only a new matching pass can clear that failure.
	const oldPassHanded = createBarrier();
	world.provider.enqueue("root", {
		name: "old-background-pass-reported",
		check: (request) => {
			if (backgroundVerifyTaskId === undefined)
				throw new Error("the background verification start was never observed");
			if (!handoffFor(request, backgroundVerifyTaskId)) {
				throw new Error(`the completion of ${backgroundVerifyTaskId} did not reach the foreground root`);
			}
			oldPassHanded.release();
		},
		reply: {
			content: [{ type: "text", text: "The background check passed; the newer failure still stands." }],
		},
	});
	backgroundVerifyGate.release();
	await withDeadline(trace, "old background pass handed off", oldPassHanded.promise, 90_000);
	await withDeadline(trace, "old background handoff settled", session.waitForForegroundIdle(), 90_000);
	expect(
		world.shell.requests.filter((request) => request.command === VITEST_COMMAND),
		"the old pass ran once, alongside the setup run and the revision failure",
	).toHaveLength(3);
	trace.mark("root", "old-background-pass.handed-off");
	world.provider.enqueue(
		"root",
		dynamicCalls("retire-workers", (request) => [
			{
				id: "retire-held-1",
				name: "delegate",
				arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-b") },
			},
			{
				id: "retire-quick-1",
				name: "delegate",
				arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-c") },
			},
		]),
		dynamicCalls("mixed-batch", (request) => {
			const retirements = latestBatchResults(request).filter((result) => result.toolName === "delegate");
			if (
				retirements.length !== 2 ||
				retirements.some((result) => result.isError || !result.text.includes("retired"))
			)
				throw new Error(`the held and quick workers were not both retired: ${JSON.stringify(retirements)}`);
			// One terminal batch: two reads and two status calls. The status of the retired held worker links back to its start receipt.
			return [
				{ id: "mixed-ok-1", name: "read", arguments: { path: LIMITS_PATH } },
				{
					id: "mixed-fail-1",
					name: "read",
					arguments: { path: projectPath("src", "does-not-exist.ts") },
				},
				{
					id: "mixed-status-ok-1",
					name: "delegate",
					arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-b") },
				},
				{
					id: "mixed-status-fail-1",
					name: "delegate",
					arguments: { action: "status", agentId: "agent-does-not-exist" },
				},
			];
		}),
		{
			name: "mixed-recorded",
			check: (request) => {
				// Four calls in one terminal batch: the reads split into a success and a missing-file failure, and the status of the retired held
				// worker names that worker's agent id (its start receipt), while the unknown-agent status fails.
				const results = latestBatchResults(request);
				const [ok, failed, status, statusFailed] = results;
				const agentId = latestAgentIdForTrack(request, "worker-b");
				if (
					results.length !== 4 ||
					ok?.isError !== false ||
					failed?.isError !== true ||
					!ok.text.includes("MAX_RETRIES") ||
					status?.isError !== false ||
					!status.text.includes(agentId) ||
					statusFailed?.isError !== true
				)
					throw new Error(`the mixed batch did not split as expected: ${JSON.stringify(results)}`);
			},
			reply: {
				content: [{ type: "toolCall", id: "complete-3", name: "goal", arguments: { action: "complete" } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "obligation-reported",
			check: (request) => {
				refusedGoal(
					request,
					"completion after the held lane completed",
					"active verification obligation(s) remain",
				);
			},
			reply: { content: [{ type: "text", text: "The obligation is still open." }] },
		},
	);
	await withDeadline(
		trace,
		"retirement and obligation refusal",
		session.prompt("Retire the checks and check completion again."),
	);
	trace.mark("root", "obligation.still-open");
	// The durable batch: each call's result is persisted under its own call id, in call order, with its own outcome.
	const mixedCallIds = ["mixed-ok-1", "mixed-fail-1", "mixed-status-ok-1", "mixed-status-fail-1"];
	const mixedResults = created.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			mixedCallIds.includes(entry.message.toolCallId)
				? [entry.message]
				: [],
		);
	expect(
		mixedResults.map((message) => ({
			toolCallId: message.toolCallId,
			isError: message.isError,
			failureRecord:
				typeof message.details === "object" && message.details !== null && "piToolFailureMemory" in message.details,
		})),
		"the durable mixed batch pairs each call with its own result and outcome",
	).toEqual([
		{ toolCallId: "mixed-ok-1", isError: false, failureRecord: false },
		{ toolCallId: "mixed-fail-1", isError: true, failureRecord: true },
		{ toolCallId: "mixed-status-ok-1", isError: false, failureRecord: false },
		{ toolCallId: "mixed-status-fail-1", isError: true, failureRecord: true },
	]);
	// The durable receipt link: the status call names the agent that its durable retire call named, and the result carries that id.
	const retiredHeldAgent = created.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content.flatMap((block) =>
						block.type === "toolCall" && block.id === "retire-held-1" ? [block.arguments.agentId] : [],
					)
				: [],
		);
	const statusText = (mixedResults[2]?.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
	expect(retiredHeldAgent, "the durable retire call names the held worker").toHaveLength(1);
	expect(statusText, "the durable status result carries the agent id its retire call named").toContain(
		String(retiredHeldAgent[0]),
	);
	const obligationsBeforeGap5 = session.getVerificationObligations();
	// Gap 5: a passing run of the same command from another directory is another verification identity. The obligation the
	// failure opened in the project directory must survive it; only the recheck from the project directory clears it.
	world.systemOne.enterPhase(
		"verify-elsewhere",
		{ ...verifyJudgments, ...operationClasses, ...completionStates },
		{ expect: ownerWords("Run the check from another directory, then check completion.") },
	);
	world.provider.enqueue(
		"root",
		calls("gap5-run", [{ id: "gap5-verify-1", name: "bash", arguments: { command: gap5Command } }]),
		{
			name: "gap5-run-reported",
			check: (request) => {
				const run = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (!run || run.isError) {
					throw new Error(`the other-directory pass did not complete cleanly: ${run?.text ?? "no bash result"}`);
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "gap5-complete-1", name: "goal", arguments: { action: "complete" } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "gap5-refusal-reported",
			check: (request) => {
				refusedGoal(
					request,
					"completion after the other-directory pass",
					"active verification obligation(s) remain",
				);
			},
			reply: { content: [{ type: "text", text: "The other-directory pass does not clear the obligation." }] },
		},
	);
	await withDeadline(
		trace,
		"other-directory pass and obligation refusal",
		session.prompt("Run the check from another directory, then check completion."),
	);
	trace.mark("root", "gap5.still-open");

	// D (open verification across a worker's budget terminal, held in the admitting turn): the cost-capped worker is admitted by the root's
	// start call. The root's next provider request is held inside that same turn, and the worker is held at its first request. A passive
	// subscriber is armed before the worker is released; its exact terminal event pins the attempt while the turn is still held. The root
	// gate is then released, and the next provider boundary of the same turn carries the worker's handoff; the completion is refused naming
	// the same open obligation ids. No global idle wait and no owner input is involved.
	const D_COST_PROFILE: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "j2-cost",
		description: "Read-only worker with a 0.2 USD cost cap.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read"],
		readOnly: true,
		toolNames: ["read"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxTokens: 50_000, maxCostUsd: 0.2 },
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-09T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
	};
	new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(D_COST_PROFILE, "global");
	// The worker's terminal handoff is the worker-handoff notice, one entry per lane; the tool-handoff notice is a different message.
	const dWorkerHandoff = (request: ScriptedRequest, laneId: string): boolean =>
		request.context.messages.some((message) => {
			const text = JSON.stringify(message);
			return text.includes("Background worker terminal handoff") && text.includes(`- ${laneId}:`);
		});
	const dObligationsBefore = session.getVerificationObligations().map((obligation) => obligation.id);
	expect(
		dObligationsBefore.length,
		"the project-directory failure is open before the budget worker runs",
	).toBeGreaterThan(0);
	const dAdmitted = createBarrier();
	const dGate = createBarrier();
	const dRootGate = createBarrier();
	const dTerminal = createBarrier();
	let dAttemptId: string | undefined;
	let dLaneId: string | undefined;
	const dRecords: Array<{ readonly laneId: string; readonly status: string }> = [];
	const dCost = { ...createEmptyUsage().cost, input: 0.25, output: 0.05, total: 0.25 + 0.05 };
	world.provider.enqueue("worker-a", {
		name: "d-budget-read",
		check: () => dAdmitted.release(),
		gate: dGate.promise,
		reply: {
			content: [{ type: "toolCall", id: "d-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
			stopReason: "toolUse",
			usage: { ...createEmptyUsage(), input: 1_000, output: 100, totalTokens: 1_100, cost: dCost },
		},
	});
	world.provider.enqueue(
		"root",
		calls("d-start", [
			{
				id: "d-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "j2-cost",
					instructions: "Read the limits file, then report.",
				},
			},
		]),
		{
			name: "d-held",
			gate: dRootGate.promise,
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (!started?.text.includes("delegate started (running)")) {
					throw new Error(`the budget worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "d-held-get", name: "goal", arguments: { action: "get" } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "d-wake",
			check: (request) => {
				if (dLaneId === undefined || !dWorkerHandoff(request, dLaneId)) {
					throw new Error("the budget worker's terminal handoff is not in the same-turn boundary request");
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "d-complete-1", name: "goal", arguments: { action: "complete" } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "d-refused",
			check: (request) => {
				refusedGoal(
					request,
					"completion after the budget worker terminal",
					"active verification obligation(s) remain",
				);
			},
			reply: { content: [{ type: "text", text: "The open obligation still refuses completion." }] },
		},
	);
	world.systemOne.enterPhase(
		"verify-budget-worker",
		{ ...verifyJudgments },
		{
			expect: ownerWords("Start the cost-capped check, then check completion."),
		},
	);
	const dPrompt = session.prompt("Start the cost-capped check, then check completion.");
	await withDeadline(trace, "budget worker admitted", dAdmitted.promise, 90_000);
	const dRunning = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
		(attempt) => attempt.status === "running",
	);
	expect(dRunning, "exactly one budget attempt is admitted and held").toHaveLength(1);
	const dAttempt = dRunning[0];
	if (dAttempt === undefined) throw new Error("the admitted budget attempt is missing");
	dAttemptId = dAttempt.attemptId;
	dLaneId = dAttempt.taskId;
	const offD = session.subscribe((event) => {
		if (event.type !== "delegate_workers") return;
		for (const record of event.terminalSinceFlush) {
			dRecords.push({ laneId: record.laneId, status: record.status });
			if (record.laneId === dLaneId) dTerminal.release();
		}
	});
	try {
		if (session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[dAttemptId]?.status !== "running") {
			dTerminal.release();
		}
		dGate.release();
		await withDeadline(trace, "budget worker terminal observed", dTerminal.promise, 120_000);
	} finally {
		offD();
	}
	const dTerminalAttempt = session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[dAttemptId];
	expect(dTerminalAttempt?.status, "the budget worker terminalizes partial").toBe("partial");
	const dRecord = dRecords.find((record) => record.laneId === dLaneId);
	expect(dRecord?.laneId, "the exact terminal event names the admitted lane").toBe(dLaneId);
	expect(dRecord?.status, "the exact terminal event carries the lane budget terminal").toBe("budget_exhausted");
	expect(
		session.backgroundLanes.getWorkerAttemptResult(dAttemptId)?.reasonCode,
		"the budget terminal names the grant's cost refusal",
	).toBe("cost_budget_exhausted");
	expect(
		session.getVerificationObligations().map((obligation) => obligation.id),
		"the budget terminal leaves exactly the obligation ids that were open before the worker ran",
	).toEqual(dObligationsBefore);
	dRootGate.release();
	await withDeadline(trace, "budget turn settled", dPrompt, 120_000);
	expect(
		session.getVerificationObligations().map((obligation) => obligation.id),
		"the completion refusal leaves the open obligation ids unchanged",
	).toEqual(dObligationsBefore);
	trace.mark("root", "gap5.budget-worker");
	// The native verification record carries the identity: the failure is in the project directory, the other-directory pass
	// is a distinct identity in its own directory, and the pass ran exactly once there.
	type ReceiptIdentity = {
		readonly id: string;
		readonly cwd: string;
		readonly status: string;
		readonly repairGroup?: string;
	};
	const isReceiptIdentity = (value: unknown): value is ReceiptIdentity =>
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"status" in value &&
		typeof value.status === "string" &&
		(!("repairGroup" in value) || typeof value.repairGroup === "string");
	const verificationOf = (toolCallId: string): unknown => {
		const entry = created.sessionManager
			.getBranch()
			.find(
				(candidate) =>
					candidate.type === "message" &&
					candidate.message.role === "toolResult" &&
					candidate.message.toolCallId === toolCallId,
			);
		const details =
			entry?.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
		return typeof details === "object" && details !== null && "piVerification" in details
			? details.piVerification
			: undefined;
	};
	expect(verificationOf("verify-fail-1"), "the revision failure is recorded in the project directory").toMatchObject({
		cwd: HARNESS_PROJECT_CWD,
		status: "failed",
	});
	expect(verificationOf("gap5-verify-1"), "the other-directory pass is recorded in its own directory").toMatchObject({
		cwd: GAP5_DIR,
		status: "passed",
	});
	expect(
		world.shell.requests.filter((request) => request.command === gap5Command),
		"the other-directory pass ran once",
	).toHaveLength(1);
	// Native receipts only: both runs share one canonical stage list and workspace (the cd is stripped from the identity stages and
	// the cwd varies), so the repair group matches while the receipt ids differ. Raw display commands are not compared.
	const revision = verificationOf("verify-fail-1");
	const elsewhere = verificationOf("gap5-verify-1");
	if (!isReceiptIdentity(revision) || !isReceiptIdentity(elsewhere)) {
		throw new Error(`a verification receipt is not a native identity: ${JSON.stringify([revision, elsewhere])}`);
	}
	expect(elsewhere.id, "the other-directory pass has its own native receipt id").not.toBe(revision.id);
	expect(revision.repairGroup, "the project failure carries a native repair group").toEqual(expect.any(String));
	expect(elsewhere.repairGroup, "the other-directory pass carries the same native repair group").toBe(
		revision.repairGroup,
	);
	expect(
		session.getVerificationObligations(),
		"the other-directory pass leaves the open obligation unchanged",
	).toEqual(obligationsBeforeGap5);
	expect(
		session.getVerificationObligations().map((obligation) => obligation.id),
		"the open obligation is the failure's own native receipt",
	).toEqual([revision.id]);
	const autonomy = world.settingsManager.getAutonomySettings();
	const settlement: Partial<
		Record<
			| "afterObligationOpen"
			| "afterE11AuxStart"
			| "afterE11AuxSettled"
			| "beforeCompact"
			| "afterApply"
			| "afterFreshOpen"
			| "afterHostResume"
			| "afterAutoResume",
			ReturnType<typeof settlementFacts>
		>
	> = {};
	settlement.afterObligationOpen = settlementFacts(session, created.sessionManager, autonomy);
	// The same bounded goal continuation runs through each mode's native loop: semantic objective routing on,
	// ordinary goal continuation off. Goal and delegate remain available in both; no profile trims the root surface.
	// Checkpoint while the failed obligation stays open: the root compacts past the failed receipt, is disposed, and the
	// file-backed session reopens. The reopened root still refuses completion, and an unrelated successful read clears nothing.
	world.provider.enqueue("root", {
		name: "checkpoint-summary",
		reply: { content: [{ type: "text", text: CHECKPOINT_SUMMARY }] },
	});
	// Every judgment the checkpoint phase meets: the goal's own continuation cycles (objective-cycle routing, per-turn
	// step routing, and the completion gate). No user prompt is submitted here, so no intake family is declared.
	const checkpointJudgments = {
		// The final account judges the actual change, its requirement link and the passing regression evidence.
		shows_true_0: { kind: "noul", probability: 0.97 },
		shows_false_0: { kind: "noul", probability: 0.02 },
		shows_true_1: { kind: "noul", probability: 0.97 },
		shows_false_1: { kind: "noul", probability: 0.02 },
		shows_true_2: { kind: "noul", probability: 0.97 },
		shows_false_2: { kind: "noul", probability: 0.02 },
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
		...completionJudgments,
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
	} as const;
	// The exact trusted obligation identity before the checkpoint: every later check compares against these ids.
	const obligationsBefore = session.getVerificationObligations();
	expect(
		obligationsBefore.map((obligation) => obligation.command),
		"the failed run is the one open verification obligation",
	).toEqual([VITEST_COMMAND]);
	// Every earlier tool pair is dropped from the context, the failed run included: the obligation must outlive its receipt.
	world.systemOne.enterPhase("verify-checkpoint", checkpointJudgments, {
		families: {
			"keep_call::": { kind: "noul", probability: 0.02 },
			"keep_result::": { kind: "noul", probability: 0.02 },
		},
	});
	settlement.beforeCompact = settlementFacts(session, created.sessionManager, autonomy);
	const checkpoint = await withDeadline(
		trace,
		"checkpoint compaction",
		session.compact("Keep the limits task and its open verification."),
	);
	trace.mark("root", "checkpoint.compacted");
	settlement.afterApply = settlementFacts(session, created.sessionManager, autonomy);
	// The applied checkpoint persists the exact obligation snapshot the decorated details carry: trusted ids and the command.
	const persistedCheckpoint = created.sessionManager.getEntries().find((entry) => entry.type === "compaction");
	// Exact, not a subset: every captured obligation's id, command and cwd, as the native snapshot persisted them.
	const trustedDescriptions = obligationsBefore.map((obligation) => ({
		id: obligation.id,
		command: obligation.command,
		cwd: obligation.cwd,
	}));
	const persistedDetails = persistedCheckpoint?.type === "compaction" ? persistedCheckpoint.details : undefined;
	const persistedObligations =
		typeof persistedDetails === "object" &&
		persistedDetails !== null &&
		"piVerificationObligations" in persistedDetails
			? persistedDetails.piVerificationObligations
			: undefined;
	expect(persistedObligations, "the applied checkpoint keeps the exact verification obligation metadata").toEqual({
		version: 1,
		activeIds: obligationsBefore.map((obligation) => obligation.id),
		descriptions: trustedDescriptions,
	});
	// Production rewrites the Active Task to the session's own task, so the applied summary is compared with the persisted entry.
	expect(checkpoint.summary, "the checkpoint summary keeps its open problem").toContain("## Open Problems");
	const persisted = created.sessionManager.getEntries().find((entry) => entry.type === "compaction");
	expect(persisted?.type === "compaction" ? persisted.summary : undefined, "the applied checkpoint is persisted").toBe(
		checkpoint.summary,
	);
	// Scripted before the reopen, in the order the root reaches them: the explicit refusal turn, then the goal's own idle
	// continuation, which repairs the limit, rechecks it, and completes the goal (the natural stop of the loop).
	world.provider.enqueue(
		"root",
		calls("read-after-reopen", [{ id: "read-after-reopen-1", name: "read", arguments: { path: LIMITS_PATH } }]),
		{
			name: "read-after-reopen-reported",
			check: (request) => assertBatchOk(request, "read-after-reopen"),
			reply: {
				content: [
					{ type: "toolCall", id: "complete-checkpoint-1", name: "goal", arguments: { action: "complete" } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "checkpoint-refusal-reported",
			check: (request) => {
				refusedGoal(
					request,
					"completion after the checkpoint and reopen",
					"active verification obligation(s) remain",
				);
				// The deliberate 1k recent-keep moves the kept tail past the failed run, so its output is outside the provider
				// context: the obligation must outlive a receipt the model can no longer see.
				// Exact identity, not only the output text: neither the failing call nor its result may be rebuilt into the context,
				// since redaction could erase the text while the receipt itself is retained.
				const replayedFailure = request.context.messages.some(
					(message) =>
						(message.role === "assistant" &&
							message.content.some((block) => block.type === "toolCall" && block.id === "verify-fail-1")) ||
						(message.role === "toolResult" && message.toolCallId === "verify-fail-1"),
				);
				if (replayedFailure || JSON.stringify(request.context.messages).includes("Tests  1 failed (1)")) {
					throw new Error(
						"the failed receipt (verify-fail-1) is still in the provider context after the checkpoint",
					);
				}
				// Trusted identity, not a summary word: the refusal names the exact obligation ids that were open before the
				// checkpoint, and the reopened root's own view reports those same ids and no others.
				const trustedIds = obligationsBefore.map((obligation) => obligation.id);
				const refusal = latestBatchResults(request).find((result) => result.toolName === "goal");
				if (!trustedIds.every((id) => refusal?.text.includes(id))) {
					throw new Error(`the refusal does not name ${JSON.stringify(trustedIds)}: ${refusal?.text ?? ""}`);
				}
				const reopenedIds = session.getVerificationObligations().map((obligation) => obligation.id);
				if (JSON.stringify(reopenedIds) !== JSON.stringify(trustedIds)) {
					throw new Error(
						`the reopened view reports ${JSON.stringify(reopenedIds)}, expected ${JSON.stringify(trustedIds)}`,
					);
				}
			},
			reply: { content: [{ type: "text", text: "The obligation survives the checkpoint and the reopen." }] },
		},
		calls("edit-back-to-five", [
			{
				id: "edit-five-2",
				name: "edit",
				arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 4", newText: "MAX_RETRIES = 5" }] },
			},
		]),
		calls("vitest-recheck", [{ id: "verify-pass-2", name: "bash", arguments: { command: VITEST_COMMAND } }]),
		calls("get-rechecked-goal", [{ id: "goal-get-recheck", name: "goal", arguments: { action: "get" } }]),
		dynamicCalls(
			"record-recheck-evidence",
			() => [
				{
					id: "evidence-recheck",
					name: "goal",
					arguments: {
						action: "add_evidence",
						kind: "test",
						uri: "verify-pass-2",
						summary: "The current recheck passed: MAX_RETRIES is 5.",
						requirementIds: [goalRequirementId()],
					},
				},
			],
			(request) => assertBatchOk(request, "get-rechecked-goal"),
		),
		dynamicCalls(
			"complete-final",
			() => {
				const requirement = goalRequirementId();
				const goal = session.getGoalStateSnapshot();
				const evidence = goal?.evidence.find((item) => item.uri === "verify-pass-2");
				const linkedRequirement = goal?.requirements.find((item) => item.id === requirement);
				if (evidence?.verified !== true || !linkedRequirement?.evidenceIds.includes(evidence.id)) {
					throw new Error("the completion account has no verified current recheck linked to its requirement");
				}
				return [
					{
						id: "complete-2",
						name: "goal",
						arguments: {
							action: "complete",
							account: {
								changes: [
									{
										path: "src/limits.ts",
										reason: "Raises MAX_RETRIES from 3 to 5.",
										evidenceIds: [evidence.id],
										serves: [requirement],
									},
								],
								assumptions: [],
								regressions: [{ path: "MAX_RETRIES equals 5", evidenceIds: [evidence.id] }],
							},
						},
					},
				];
			},
			(request) => assertBatchOk(request, "record-recheck-evidence"),
		),
		{
			name: "completed",
			check: (request) => {
				assertBatchOk(request, "complete-final");
				if (!latestBatchResults(request).some((result) => result.text.includes("goal complete recorded"))) {
					throw new Error("the goal was not completed after the passing recheck cleared the obligation");
				}
			},
			reply: { content: [{ type: "text", text: "The goal is complete." }] },
		},
	);
	const checkpointFile = created.sessionManager.getSessionFile();
	if (checkpointFile === undefined) throw new Error("the checkpointed session has no file");
	expect(await world.disposeSessionInBody(session), "the checkpointed root must dispose cleanly").toBeUndefined();
	created = await world.createRootSession("root", { sessionManager: world.openSessionManager(checkpointFile) });
	session = created.session;
	orchestrationRoot = session;
	session.subscribe((event) => {
		if (event.type === "warning") warnings.push(event.message);
	});
	trace.mark("root", "checkpoint.reopened");
	settlement.afterFreshOpen = settlementFacts(session, created.sessionManager, autonomy);
	// The host resume the CLI performs on --resume, --continue and --session (main.ts): it restores the goal runtime and arms
	// its idle continuation. Constructing the session alone does not. The scripted cycles then run the refusal, the repair,
	// the recheck and the completion; the idle wait covers every cycle.
	session.restoreGoalRuntimeAfterResume();
	settlement.afterHostResume = settlementFacts(session, created.sessionManager, autonomy);
	await withDeadline(trace, "auto-resumed goal settled", session.waitForForegroundIdle(), 90_000);
	settlement.afterAutoResume = settlementFacts(session, created.sessionManager, autonomy);
	trace.mark("root", "goal.completed");
	expect(
		session.getGoalStateSnapshot()?.status,
		`the host records the goal as completed; native settlement: ${JSON.stringify(settlement)}`,
	).toBe("completed");
	if (world.systemOne.enabled) {
		const accountRequests = world.systemOne.decoded.filter(
			(request) => request.phase === "verify-checkpoint" && "shows_true_2" in request.questions,
		);
		expect(accountRequests, "completion reaches the change account judgment after the matching recheck").toHaveLength(
			1,
		);
		const accountState = accountRequests[0]?.state;
		const currentEvidence = session.getGoalStateSnapshot()?.evidence.find((item) => item.uri === "verify-pass-2");
		expect(accountState, "the account judges the real change and its linked passing recheck").toMatchObject({
			s0: "Raises MAX_RETRIES from 3 to 5.",
			e0: expect.stringContaining("src/limits.ts"),
			s1: "This change helps achieve: MAX_RETRIES equals 5.",
			e1: expect.stringContaining(`${currentEvidence?.id}: [verified]`),
			s2: 'The behavior "MAX_RETRIES equals 5" is exercised by passing checks',
			e2: expect.stringContaining(`${currentEvidence?.id}: [verified]`),
		});
	}
	expect(
		getLatestGoalStateSnapshot(created.sessionManager)?.status,
		"the persisted goal snapshot agrees with the host",
	).toBe("completed");
	expect(
		receiptsOf(replayMailbox).filter(
			(receipt) => receipt.messageId === firstAdmission.messageId && receipt.kind === "control",
		),
		"one durable control receipt per idempotency key",
	).toHaveLength(1);
	// One SQLite connection at a time: the active root's journey assertions are complete, so it disposes before the auxiliary root opens.
	expect(
		await world.disposeSessionInBody(session),
		"the active root disposes before the auxiliary root opens",
	).toBeUndefined();
	// E positive (stale background pass, failure first): the main root has completed and disposed. An auxiliary native root, with no goal, runs the
	// failing check, then a matching background pass starts and is held. The pass is released while that root is idle, so its exact background
	// terminal hands off to the idle root, which consumes it; the obligation the failure opened clears on that handoff.
	const eBgGate = createBarrier();
	const eWake = createBarrier();
	const eAux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const eSession = eAux.session;
	const eJudgments = {
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		...completionStates,
		shows_true_0: { kind: "noul", probability: 0.97 },
		shows_false_0: { kind: "noul", probability: 0.02 },
	} as const;
	world.shell.enqueue(
		{ name: "e-fail-stale", command: VITEST_COMMAND, output: vitestFailed, exitCode: 1 },
		{
			name: "e-pass-stale-bg",
			command: VITEST_COMMAND,
			output: vitestPassed,
			exitCode: 0,
			gate: eBgGate.promise,
		},
	);
	let eBgTaskId: string | undefined;
	world.provider.enqueue(
		"root",
		calls("e-fail", [{ id: "e-fail-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
		{
			name: "e-fail-reported",
			check: (request) => {
				const run = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (run?.isError !== true)
					throw new Error(`the stale failure did not report a failed check: ${run?.text ?? "no result"}`);
			},
			reply: { content: [{ type: "text", text: "The stale check failed." }] },
		},
		calls("e-bg-start", [{ id: "e-bg-1", name: "bash", arguments: { command: VITEST_COMMAND, background: true } }]),
		{
			name: "e-bg-started",
			check: (request) => {
				eBgTaskId = backgroundTaskIdOf(request);
			},
			reply: { content: [{ type: "text", text: "The background check is running." }] },
		},
		{
			name: "e-wake",
			check: (request) => {
				if (eBgTaskId === undefined || !handoffFor(request, eBgTaskId)) {
					throw new Error("the background terminal does not reach the idle root");
				}
				eWake.release();
			},
			reply: { content: [{ type: "text", text: "The stale pass handed off." }] },
		},
	);
	world.systemOne.enterPhase("e-fail", eJudgments);
	await withDeadline(trace, "E aux failure reported", eSession.prompt("Run the stale check."));
	const eFailIds = eSession.getVerificationObligations().map((obligation) => obligation.id);
	expect(eFailIds.length, "the stale failure opens exactly one obligation").toBe(1);
	world.systemOne.enterPhase("e-bg", eJudgments);
	await withDeadline(trace, "E aux background pass started", eSession.prompt("Start the background check."));
	expect(
		eSession.getVerificationObligations().map((obligation) => obligation.id),
		"the held background pass leaves the failure's obligation open",
	).toEqual(eFailIds);
	eBgGate.release();
	await withDeadline(trace, "E aux handoff reached the idle root", eWake.promise, 120_000);
	await withDeadline(trace, "E aux settled", eSession.waitForForegroundIdle(), 120_000);
	expect(
		eSession.getVerificationObligations().map((obligation) => obligation.id),
		"the background terminal's handoff clears the failure's obligation",
	).toEqual([]);
	const eRecord = loadBackgroundToolTaskRecordsNewestFirst(eAux.sessionManager).find(
		(record): record is BackgroundToolTaskRecord => isRecordObject(record) && record.taskId === eBgTaskId,
	);
	expect(eRecord?.toolCallId, "the canonical background record names the held pass call").toBe("e-bg-1");
	expect(eRecord?.status, "the canonical background record is the completed terminal").toBe("completed");
	expect(eRecord?.terminalDelivery, "the terminal was delivered to the idle root").toBe("delivered");
	expect(eRecord?.piVerification?.status, "the canonical record carries the passing verification receipt").toBe(
		"passed",
	);
	{
		// E11 runs on an auxiliary root with no goal, so it proves the large-output artifact, the native status pointer and the chunked
		// read on that root alone, with no live goal competing for it. The main root's default goal continuation stays enabled and independent.
		const session = eSession;
		const created = eAux;
		// E11 (large worker output through the native artifact, read back by native status): a worker emits a large distinct text
		// block and a truthful typed report in one final assistant message. The raw text becomes the artifact; status by agentId
		// names it; a small follow-up report must borrow no older pointer; the historical lane keeps its own pointer.
		const E11_LARGE = [
			"E11-LARGE-OUTPUT-MARKER",
			...Array.from(
				{ length: 1400 },
				(_unused, index) =>
					`E11 report line ${index}: checkpoint ${index % 97} recorded value ${(index * 2654435761) % 1000003}.`,
			),
		].join("\n");
		// A second, distinct large generation: its own marker and lines, so each generation has its own digest.
		const E11_LARGE_SECOND = [
			"E11-SECOND-LARGE-MARKER",
			...Array.from(
				{ length: 1400 },
				(_unused, index) =>
					`E11 second report line ${index}: segment ${index % 89} recorded value ${(index * 1103515245) % 999983}.`,
			),
		].join("\n");
		const E11_REPORT = "The large output is reported.";
		const E11_REPORT_SECOND = "The second large output is reported.";
		const E11_SMALL = "Small report is ready.";
		expect(Buffer.byteLength(E11_LARGE), "the output exceeds the inline threshold").toBeGreaterThan(
			WORKER_TERMINAL_OUTPUT_INLINE_BYTES,
		);
		const e11Reported = createBarrier();
		const e11SecondReported = createBarrier();
		// The second generation's provider turn is held before its terminal: the status reads happen while it runs.
		const e11SecondHeld = createBarrier();
		let e11SecondEpoch: number | undefined;
		const e11SecondRelease = createBarrier();
		const e11SmallReported = createBarrier();
		const startIdentity = (): { agentId: string; laneId: string } => {
			for (const message of session.messages) {
				if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
				const details = message.details as
					| { started?: unknown; label?: unknown; agentId?: unknown; laneId?: unknown }
					| undefined;
				if (
					details?.started === true &&
					details.label === "Report the large output once." &&
					typeof details.agentId === "string" &&
					typeof details.laneId === "string"
				) {
					return { agentId: details.agentId, laneId: details.laneId };
				}
			}
			throw new Error("the start result carries no agent or lane id");
		};
		// The first generation's artifact file, resolved from the admitted attempt's native result at the read's request.
		const e11ArtifactPath = (): string => {
			// Pure projection read: the admitted agent's first attempt that carries a native result, at the read's request.
			const attempt = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
				(candidate) => candidate.taskId === startIdentity().laneId && candidate.result !== undefined,
			);
			const uri = attempt?.result?.artifacts[0]?.uri;
			if (typeof uri !== "string") throw new Error("the first large attempt carries no artifact");
			return fileURLToPath(uri);
		};
		// The continuation offset a truncated read announces; a read without one is the last chunk.
		const e11ContinuationOffset = (request: ScriptedRequest, toolCallId: string): number => {
			const result = request.context.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
			);
			const text =
				result?.role === "toolResult"
					? result.content.map((block) => (block.type === "text" ? block.text : "")).join("")
					: "";
			const match = /Use offset=(\d+) to continue\./.exec(text);
			if (!match) throw new Error(`the read ${toolCallId} announces no continuation`);
			return Number(match[1]);
		};
		const e11Observed: {
			sequence?: number;
			stopReason?: string;
			blockTypes?: string[];
			textBytes?: number;
			markerCount?: number;
		} = {};
		world.provider.enqueue(
			"worker-c",
			{
				name: "e11-large-report",
				onTerminal: (request, message) => {
					const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
					e11Observed.sequence = request.sequence;
					e11Observed.stopReason = message.stopReason;
					e11Observed.blockTypes = message.content.map((block) => block.type);
					e11Observed.textBytes = Buffer.byteLength(text);
					e11Observed.markerCount = text.split("E11-LARGE-OUTPUT-MARKER").length - 1;
				},
				reply: {
					content: [
						{ type: "text", text: E11_LARGE },
						{
							type: "toolCall",
							id: "e11-report-1",
							name: "submit_report",
							arguments: { status: "completed", summary: E11_REPORT },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "e11-second-large-report",
				check: () => {
					e11SecondHeld.release();
				},
				gate: e11SecondRelease.promise,
				reply: {
					content: [
						{ type: "text", text: E11_LARGE_SECOND },
						{
							type: "toolCall",
							id: "e11-report-2",
							name: "submit_report",
							arguments: { status: "completed", summary: E11_REPORT_SECOND },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "e11-small-report",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "e11-small-1",
							name: "submit_report",
							arguments: { status: "completed", summary: E11_SMALL },
						},
					],
					stopReason: "toolUse",
				},
			},
		);
		world.provider.enqueue(
			"root",
			calls("e11-start", [
				{
					id: "e11-start-1",
					name: "delegate",
					arguments: {
						action: "start",
						model: { provider: "harness-script", modelId: "worker-c" },
						instructions: "Report the large output once.",
					},
				},
			]),
			{ name: "e11-started", reply: { content: [{ type: "text", text: "The large worker is running." }] } },
			dynamicCalls(
				"e11-handoff",
				(request) => [
					{
						id: "e11-status-1",
						name: "delegate",
						arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-c") },
					},
				],
				(request) => {
					if (!JSON.stringify(request.context.messages).includes(E11_REPORT)) {
						throw new Error("the large worker's report did not reach the root");
					}
					if (
						JSON.stringify(world.provider.getPendingStepNames("worker-c")) !==
						JSON.stringify(["e11-second-large-report", "e11-small-report"])
					) {
						throw new Error(
							`the large turn left other steps pending: ${JSON.stringify(world.provider.getPendingStepNames("worker-c"))}`,
						);
					}
					e11Reported.release();
				},
			),
			{ name: "e11-read", reply: { content: [{ type: "text", text: "The large output is read." }] } },
			dynamicCalls("e11-chunk-1", () => [
				{ id: "e11-read-1", name: "read", arguments: { path: e11ArtifactPath() } },
			]),
			dynamicCalls("e11-chunk-2", (request) => [
				{
					id: "e11-read-2",
					name: "read",
					arguments: { path: e11ArtifactPath(), offset: e11ContinuationOffset(request, "e11-read-1") },
				},
			]),
			{ name: "e11-chunked", reply: { content: [{ type: "text", text: "The artifact is read in chunks." }] } },
			dynamicCalls("e11-follow-large", (request) => [
				{
					id: "e11-follow-large-1",
					name: "delegate",
					arguments: {
						action: "follow_up",
						agentId: latestAgentIdForTrack(request, "worker-c"),
						message: "Report the second large output.",
					},
				},
			]),
			{
				name: "e11-follow-large-started",
				check: () => {
					e11SecondEpoch = session.getForegroundActivity().epoch;
					if (e11SecondEpoch === undefined)
						throw new Error("the second report foreground turn holds no submission epoch");
				},
				reply: { content: [{ type: "text", text: "The second large report is running." }] },
			},
			dynamicCalls("e11-status-current", () => [
				{
					id: "e11-status-current-1",
					name: "delegate",
					arguments: { action: "status", agentId: startIdentity().agentId },
				},
			]),
			dynamicCalls("e11-status-historical-held", () => [
				{
					id: "e11-status-historical-1",
					name: "delegate",
					arguments: { action: "status", laneId: startIdentity().laneId },
				},
			]),
			{
				name: "e11-held-read",
				reply: { content: [{ type: "text", text: "The second report is still running." }] },
			},
			dynamicCalls(
				"e11-second-handoff",
				(request) => [
					{
						id: "e11-status-4",
						name: "delegate",
						arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-c") },
					},
				],
				(request) => {
					if (!JSON.stringify(request.context.messages).includes(E11_REPORT_SECOND)) {
						// Bounded mismatch diagnostic: pure reads and one console line, taken before the same primary Error is thrown.
						// The attempt read is keyed by the admitted agent identity, because the running-attempt binding is declared later.
						const primary = new Error("the second large report did not reach the root");
						const mismatchDx: unknown[] = [];
						try {
							const foreground = session.getResourceSnapshot().foregroundRecovery;
							const activity = session.getForegroundActivity();
							const agentId = startIdentity().agentId;
							const mismatch = JSON.stringify({
								sequence: request.sequence,
								modelId: request.model.id,
								oldCapturedEpoch: e11SecondEpoch,
								activityEpoch: activity.epoch,
								activityBusy: activity.busy,
								submissionEpoch: foreground.submissionEpoch,
								activeRuns: foreground.activeRuns,
								pendingIdleContinuation: session.backgroundLanes.hasPendingIdleContinuation(),
								agentId,
								agentAttempts: Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})
									.filter((attempt) => attempt.agentId === agentId)
									.map((attempt) => ({
										attemptId: attempt.attemptId,
										taskId: attempt.taskId,
										status: attempt.status,
										reasonCode: attempt.reasonCode,
									})),
								lastRequestTexts: requestTexts(request)
									.slice(-8)
									.map((text) => text.slice(0, 750)),
							});
							console.error(`second report handoff mismatch: ${mismatch}`);
						} catch (error) {
							mismatchDx.push(error);
						}
						if (mismatchDx.length > 0) {
							throw new AggregateError([primary, ...mismatchDx], "the second report handoff diagnostic failed");
						}
						throw primary;
					}
					e11SecondReported.release();
				},
			),
			{
				name: "e11-second-read",
				reply: { content: [{ type: "text", text: "The second large output is read." }] },
			},
			dynamicCalls("e11-follow", (request) => [
				{
					id: "e11-follow-1",
					name: "delegate",
					arguments: {
						action: "follow_up",
						agentId: latestAgentIdForTrack(request, "worker-c"),
						message: "Report briefly.",
					},
				},
			]),
			{
				name: "e11-follow-started",
				reply: { content: [{ type: "text", text: "The brief follow-up is running." }] },
			},
			dynamicCalls(
				"e11-small-handoff",
				(request) => [
					{
						id: "e11-status-2",
						name: "delegate",
						arguments: { action: "status", agentId: latestAgentIdForTrack(request, "worker-c") },
					},
				],
				(request) => {
					if (!JSON.stringify(request.context.messages).includes(E11_SMALL)) {
						throw new Error("the small follow-up report did not reach the root");
					}
					e11SmallReported.release();
				},
			),
			dynamicCalls("e11-historical", () => [
				{
					id: "e11-status-3",
					name: "delegate",
					arguments: { action: "status", laneId: startIdentity().laneId },
				},
			]),
			dynamicCalls("e11-retire", () => [
				{
					id: "e11-retire-1",
					name: "delegate",
					arguments: { action: "retire", agentId: startIdentity().agentId },
				},
			]),
			{ name: "e11-done", reply: { content: [{ type: "text", text: "Both reports are read." }] } },
		);
		// This auxiliary root has no goal, so its judgments are the owner-policy keys only: the goal's per-turn families are not
		// requested here, and no other family is declared.
		world.systemOne.enterPhase("e11", {
			changes_model_pools: { kind: "noul", probability: 0.02 },
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		});
		await withDeadline(trace, "E11 start turn", session.prompt("Start the large report worker and read its output."));
		settlement.afterE11AuxStart = settlementFacts(session, created.sessionManager, autonomy);
		await withDeadline(trace, "large worker reported", e11Reported.promise, 90_000);
		await withDeadline(trace, "E11 read turn settled", session.waitForForegroundIdle(), 90_000);
		await withDeadline(trace, "chunked artifact read", session.prompt("Read the large output in chunks."), 90_000);
		// One owned epoch promise and listener, armed before the second request. Its outcome is tagged at once, so the wait
		// never rethrows an observer cause on its own. Independent causes are collected after the block, scenario first.
		const e11Epoch: { settle?: { resolve: () => void; reject: (cause: unknown) => void } } = {};
		const e11Released = new Promise<void>((resolve, reject) => {
			e11Epoch.settle = { resolve, reject };
		});
		const e11Outcome = e11Released.then(
			() => ({ released: true as const }),
			(cause: unknown) => ({ released: false as const, cause }),
		);
		const e11Check = (): void => {
			const settle = e11Epoch.settle;
			if (settle === undefined || e11SecondEpoch === undefined) return;
			try {
				if (
					session.getForegroundActivity().epoch !== e11SecondEpoch &&
					session.getResourceSnapshot().foregroundRecovery.activeRuns === 0
				) {
					e11Epoch.settle = undefined;
					settle.resolve();
				}
			} catch (error) {
				e11Epoch.settle = undefined;
				settle.reject(error);
			}
		};
		const e11Unsubscribe = session.subscribeForegroundActivity(e11Check);
		let scenarioCaught = false;
		let scenarioCause: unknown;
		let scenarioCutoff = false;
		let observedOutcome: { released: true } | { released: false; cause: unknown } | undefined;
		try {
			await withDeadline(
				trace,
				"second large report requested",
				session.prompt("Ask for the second large report."),
				90_000,
			);
			await withDeadline(trace, "second large held", e11SecondHeld.promise, 90_000);
			if (e11SecondEpoch === undefined) throw new Error("the second report foreground epoch was never captured");
			e11Check();
			await withDeadline(trace, "second foreground epoch released", e11Outcome, 90_000);
		} catch (error) {
			scenarioCaught = true;
			scenarioCause = error;
		} finally {
			e11Unsubscribe();
			const pending = e11Epoch.settle;
			if (pending !== undefined && scenarioCaught) {
				e11Epoch.settle = undefined;
				scenarioCutoff = true;
				pending.reject(scenarioCause);
			}
			observedOutcome = await e11Outcome;
		}
		const e11Causes: unknown[] = [];
		if (scenarioCaught) e11Causes.push(scenarioCause);
		if (observedOutcome !== undefined && !observedOutcome.released && !scenarioCutoff) {
			e11Causes.push(observedOutcome.cause);
		}
		if (e11Causes.length === 1) throw e11Causes[0];
		if (e11Causes.length > 1) throw new AggregateError(e11Causes, "the second report foreground observation failed");
		// Bounded held-status diagnostic. Pure reads only: BEFORE capture runs immediately before the same prompt call, with no await
		// between them. A post-rejection capture, the console line and serialization are recorded in order after the primary error, and
		// only actual diagnostic failures aggregate with it. Health is the public getter, bound to decisionEngine presence (qualified).
		const heldStatusDx: unknown[] = [];
		const captureHeldStatus = (): Record<string, unknown> => {
			const activity = session.getForegroundActivity();
			const foreground = session.getResourceSnapshot().foregroundRecovery;
			const health = session.getSemanticPlaneHealth();
			return {
				oldCapturedEpoch: e11SecondEpoch,
				activityEpoch: activity.epoch,
				activityBusy: activity.busy,
				submissionEpoch: foreground.submissionEpoch,
				activeRuns: foreground.activeRuns,
				foregroundRetrying: foreground.retrying,
				isStreaming: session.isStreaming,
				isCompacting: session.isCompacting,
				isRetrying: session.isRetrying,
				pendingIdleContinuation: session.backgroundLanes.hasPendingIdleContinuation(),
				semanticState: health.state,
				inFlightEvaluationIds: (health.inFlightEvaluations ?? []).map((evaluation) => evaluation.evaluationId),
				completedEvaluationIds: session
					.getSemanticEvaluations()
					.slice(-20)
					.map((record) => record.evaluationId),
			};
		};
		let heldStatusBefore: Record<string, unknown> | undefined;
		try {
			heldStatusBefore = captureHeldStatus();
		} catch (error) {
			heldStatusDx.push(error);
		}
		const heldStatusPrompt = session.prompt("Check the second report while it runs.");
		try {
			await withDeadline(trace, "held status turn", heldStatusPrompt, 90_000);
		} catch (primary) {
			let heldStatusAfter: Record<string, unknown> | undefined;
			try {
				heldStatusAfter = captureHeldStatus();
			} catch (error) {
				heldStatusDx.push(error);
			}
			let heldStatusText = "unserializable";
			try {
				heldStatusText = JSON.stringify({ before: heldStatusBefore, after: heldStatusAfter }).slice(0, 5000);
			} catch (error) {
				heldStatusDx.push(error);
			}
			try {
				console.error(`held status prompt refused: ${heldStatusText}`);
			} catch (error) {
				heldStatusDx.push(error);
			}
			if (heldStatusDx.length > 0) {
				throw new AggregateError([primary, ...heldStatusDx], "held status diagnostic failed after the refusal");
			}
			throw primary;
		}
		if (heldStatusDx.length === 1) {
			throw heldStatusDx[0];
		}
		if (heldStatusDx.length > 1) {
			throw new AggregateError(heldStatusDx, "held status diagnostic capture failed before a successful prompt");
		}
		// Bounded control: while the second generation runs, its display carries no first-generation claim, pointer or digest and no
		// terminal result. It shows no current terminal yet; generation identity is pinned separately below.
		const e11HeldDetails = (toolCallId: string): Record<string, unknown> => {
			const entry = created.sessionManager
				.getBranch()
				.find(
					(candidate) =>
						candidate.type === "message" &&
						candidate.message.role === "toolResult" &&
						candidate.message.toolCallId === toolCallId,
				);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") {
				throw new Error(`no durable status result for ${toolCallId}`);
			}
			return (entry.message.details ?? {}) as Record<string, unknown>;
		};
		const e11Running = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
			(attempt) => attempt.agentId === startIdentity().agentId && attempt.status === "running",
		);
		if (e11Running === undefined) throw new Error("the second generation has no running attempt");
		const e11Current = e11HeldDetails("e11-status-current-1");
		const e11Historical = e11HeldDetails("e11-status-historical-1");
		expect(
			{ agentId: e11Current.agentId, laneId: e11Current.laneId },
			"the running display names the admitted agent and its own lane",
		).toEqual({ agentId: startIdentity().agentId, laneId: e11Running.taskId });
		expect(e11Current.claimSummary, "the running attempt borrows no first-generation claim").toBeUndefined();
		expect(e11Current.outputArtifactUri, "the running attempt borrows no first-generation pointer").toBeUndefined();
		expect(JSON.stringify(e11Current), "the running display carries no first-generation proof").not.toContain(
			E11_REPORT,
		);
		expect(JSON.stringify(e11Current), "the running display carries no first-generation digest").not.toContain(
			createHash("sha256").update(E11_LARGE).digest("hex"),
		);
		expect(
			{ laneId: e11Historical.laneId, claimSummary: e11Historical.claimSummary },
			"the historical lane still names the first generation's claim",
		).toEqual({ laneId: startIdentity().laneId, claimSummary: E11_REPORT });
		expect(typeof e11Historical.outputArtifactUri, "the historical lane keeps its first pointer").toBe("string");
		e11SecondRelease.release();
		await withDeadline(trace, "second large report", e11SecondReported.promise, 90_000);
		await withDeadline(trace, "second large read settled", session.waitForForegroundIdle(), 90_000);
		await withDeadline(trace, "brief follow-up", session.prompt("Ask for a brief follow-up report."), 90_000);
		await withDeadline(trace, "small worker reported", e11SmallReported.promise, 90_000);
		await withDeadline(trace, "E11 foreground settled", session.waitForForegroundIdle(), 90_000);
		settlement.afterE11AuxSettled = settlementFacts(session, created.sessionManager, autonomy);
		// Accepted native receipt linkage: the first generation's completed report has its matched successful submit receipt on the worker's own
		// persisted transcript, under its own call id. The incomplete side is pinned in the late block; this is the accepted side.
		const e11WorkerId = startIdentity().agentId;
		const e11Binding = session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[e11WorkerId];
		if (e11Binding === undefined) throw new Error("the E11 worker has no binding for its receipts");
		const e11Transcript = new WorkerConversationStore()
			.open({
				agentDir: world.agentDir,
				resumeContext: e11Binding.resumeContext,
				expectedLogicalAgentId: e11WorkerId,
			})
			.getRawTranscript();
		expect(
			matchedSubmitReceiptIn(e11Transcript, "e11-report-1"),
			"the accepted report has its matched successful submit receipt on the worker's persisted transcript",
		).toBe(true);
		// Durable canonical identities: each status read is found on the branch by its own tool call id, never by position.
		const e11Branch = created.sessionManager.getBranch();
		const e11Status = (toolCallId: string) => {
			const entry = e11Branch.find(
				(candidate) =>
					candidate.type === "message" &&
					candidate.message.role === "toolResult" &&
					candidate.message.toolCallId === toolCallId,
			);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") {
				throw new Error(`no durable status result for ${toolCallId}`);
			}
			return entry.message.details as
				| {
						outputArtifactUri?: unknown;
						outputArtifactSizeBytes?: unknown;
						agentId?: unknown;
						laneId?: unknown;
						claimSummary?: unknown;
				  }
				| undefined;
		};
		const latestStatus = e11Status("e11-status-1");
		const followedStatus = e11Status("e11-status-2");
		const historicalStatus = e11Status("e11-status-3");
		const admitted = startIdentity();
		expect(
			{
				agentId: latestStatus?.agentId,
				laneId: latestStatus?.laneId,
				claimSummary: latestStatus?.claimSummary,
			},
			"the latest status names the admitted agent and its lane, and its own summary",
		).toEqual({ agentId: admitted.agentId, laneId: admitted.laneId, claimSummary: E11_REPORT });
		expect(followedStatus?.agentId, "the follow-up stays on the admitted agent").toBe(admitted.agentId);
		expect(followedStatus?.laneId, "the follow-up status names its own lane, not the first").not.toBe(
			admitted.laneId,
		);
		expect(followedStatus?.claimSummary, "the follow-up summary is its own").toBe(E11_SMALL);
		// The small third generation is its own admitted task: the one attempt that is neither the first nor the captured second.
		const e11Third = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
			(attempt) =>
				attempt.agentId === admitted.agentId &&
				attempt.attemptId !== e11Running.attemptId &&
				attempt.taskId !== admitted.laneId,
		);
		expect(
			e11Third.map((attempt) => attempt.taskId),
			"exactly one third attempt is admitted",
		).toHaveLength(1);
		expect(followedStatus?.laneId, "the small status names the third attempt's own task").toBe(e11Third[0]?.taskId);
		expect(e11Observed, "the large step emitted one text-and-tool-call terminal with the exact text").toEqual({
			sequence: expect.any(Number),
			stopReason: "toolUse",
			blockTypes: ["text", "toolCall"],
			textBytes: Buffer.byteLength(E11_LARGE),
			markerCount: 1,
		});
		// Capture, native result and projection are separate observables, checked in that order: the file on disk under its
		// content digest, then the admitted attempt's native result, then the status pointer.
		// One observable chain, checked once so the failure names the layer: the file system, the admitted attempt's native
		// result, and the status pointer. Only names, counts, digests and sizes are recorded, never the raw text.
		const largeSha = createHash("sha256").update(E11_LARGE).digest("hex");
		const outputFiles = [...world.io.fileEntries().keys()].filter((path) => path.includes("worker-output-artifacts"));
		// The admitted task's own attempt, read from the native task runtime: the start lane is the task id of its first attempt.
		const admittedAttemptId = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
			(attempt) => attempt.taskId === admitted.laneId && attempt.result !== undefined,
		)?.attemptId;
		if (admittedAttemptId === undefined) throw new Error("the admitted lane carries no attempt id");
		const nativeAttempt = session.backgroundLanes.getWorkerAttemptResult(admittedAttemptId);
		const nativeUri = nativeAttempt?.artifacts[0]?.uri;
		const persistedReport = [...world.io.fileEntries()]
			.filter(([path]) => path.includes("worker-conversations") && path.endsWith(".jsonl"))
			.flatMap(([, content]) => content.split("\n").filter((line) => line.length > 0))
			.map(
				(line) =>
					JSON.parse(line) as {
						message?: { role?: string; content?: Array<{ type: string; text?: string; id?: string }> };
					} & { role?: string; content?: Array<{ type: string; text?: string; id?: string }> },
			)
			.map((entry) => entry.message ?? entry)
			.find(
				(message) =>
					message.role === "assistant" &&
					message.content?.some((block) => block.type === "toolCall" && block.id === "e11-report-1"),
			);
		const persistedText = (persistedReport?.content ?? [])
			.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
			.join("");
		const e11Chain = {
			persistedAssistantTextBytes: Buffer.byteLength(persistedText),
			persistedMarkerCount: persistedText.split("E11-LARGE-OUTPUT-MARKER").length - 1,
			outputArtifactFileCount: outputFiles.length,
			matchingDigestFileCount: outputFiles.filter((path) => path.endsWith(`-${largeSha}.txt`)).length,
			nativeResultPresent: nativeAttempt !== undefined,
			nativeArtifactDigests: nativeAttempt?.artifacts.map((artifact) => artifact.digest),
			nativeArtifactSizes: nativeAttempt?.artifacts.map((artifact) => artifact.sizeBytes),
			nativeEvidenceCount: nativeAttempt?.evidence.length,
			projectedUri: latestStatus?.outputArtifactUri,
		};
		expect(
			e11Chain,
			"the large output is persisted, captured to disk, carried by the native attempt, and projected by status",
		).toEqual({
			persistedAssistantTextBytes: Buffer.byteLength(E11_LARGE),
			persistedMarkerCount: 1,
			outputArtifactFileCount: 2,
			matchingDigestFileCount: 1,
			nativeResultPresent: true,
			nativeArtifactDigests: [largeSha],
			nativeArtifactSizes: [Buffer.byteLength(E11_LARGE)],
			nativeEvidenceCount: expect.any(Number),
			projectedUri: nativeUri,
		});
		const artifactUri = latestStatus?.outputArtifactUri;
		if (typeof artifactUri !== "string") throw new Error("the latest status carries no artifact pointer");
		expect(artifactUri.startsWith("file:"), "the pointer is a file URI").toBe(true);
		const artifactPath = fileURLToPath(artifactUri);
		expect(String(world.io.readFileSync(artifactPath, "utf8")), "the artifact holds the exact raw output").toBe(
			E11_LARGE,
		);
		expect(
			artifactPath.endsWith(`-${createHash("sha256").update(E11_LARGE).digest("hex")}.txt`),
			"the file name carries the content digest",
		).toBe(true);
		expect(latestStatus?.outputArtifactSizeBytes, "the pointer size matches the bytes").toBe(
			Buffer.byteLength(E11_LARGE),
		);
		expect(followedStatus?.outputArtifactUri, "a small follow-up report borrows no older pointer").toBeUndefined();
		expect(historicalStatus?.outputArtifactUri, "the historical lane keeps its own pointer").toBe(artifactUri);
		// Two distinct large generations, then a small current report: each status names its own generation, and the
		// chunked root read of the first generation reconstructs the exact bytes that the host verifies by digest.
		const secondStatus = e11Status("e11-status-4");
		const secondUri = secondStatus?.outputArtifactUri;
		if (typeof secondUri !== "string") throw new Error("the second large status carries no artifact pointer");
		const secondPath = fileURLToPath(secondUri);
		// Exact generation pins: the second status names the attempt captured while it ran, its pointer and size are that attempt's
		// own result, and its persisted assistant text is the second report's exact bytes in the admitted conversation.
		const admittedConversation =
			session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[admitted.agentId]?.resumeContext.sessionFile;
		expect(admittedConversation, "the admitted resume context names its conversation file").toBeDefined();
		expect(secondStatus?.laneId, "the second status names the captured second attempt's task").toBe(
			e11Running.taskId,
		);
		const secondAttemptArtifact = session.backgroundLanes.getWorkerAttemptResult(e11Running.attemptId)?.artifacts[0];
		expect(
			{ uri: secondUri, sizeBytes: secondStatus?.outputArtifactSizeBytes },
			"the second pointer and size are the captured attempt's own artifact",
		).toEqual({ uri: secondAttemptArtifact?.uri, sizeBytes: secondAttemptArtifact?.sizeBytes });
		expect(
			createHash("sha256")
				.update(String(world.io.readFileSync(secondPath, "utf8")))
				.digest("hex"),
			"the file hashes to the attempt's own content digest",
		).toBe(secondAttemptArtifact?.digest);
		expect(
			secondAttemptArtifact?.metadata,
			"the attempt's artifact metadata names sha256 and completeness",
		).toMatchObject({
			digestAlgorithm: "sha256",
			complete: true,
		});
		expect(
			persistedGenerationText(world, "e11-report-2", admittedConversation),
			"the second report's persisted text is its exact bytes",
		).toBe(E11_LARGE_SECOND);
		expect(
			{
				agentId: secondStatus?.agentId,
				claimSummary: secondStatus?.claimSummary,
				sizeBytes: secondStatus?.outputArtifactSizeBytes,
			},
			"the second large status names the admitted agent, its own summary and its size",
		).toEqual({
			agentId: admitted.agentId,
			claimSummary: E11_REPORT_SECOND,
			sizeBytes: Buffer.byteLength(E11_LARGE_SECOND),
		});
		expect(secondPath, "the second generation has its own artifact file").not.toBe(artifactPath);
		expect(
			secondPath.endsWith(`-${createHash("sha256").update(E11_LARGE_SECOND).digest("hex")}.txt`),
			"the second artifact is named by its own digest",
		).toBe(true);
		expect(String(world.io.readFileSync(secondPath, "utf8")), "the second artifact holds the exact output").toBe(
			E11_LARGE_SECOND,
		);
		// Durable canonical read results by call id, without the provider envelope or the continuation notice.
		const readText = (toolCallId: string): string => {
			const entry = e11Branch.find(
				(candidate) =>
					candidate.type === "message" &&
					candidate.message.role === "toolResult" &&
					candidate.message.toolCallId === toolCallId,
			);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") {
				throw new Error(`no durable read result for ${toolCallId}`);
			}
			return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		};
		const withoutReadEnvelope = (text: string): string =>
			text
				.replace(/^<untrusted_content[^>]*>\n?/, "")
				.replace(/\n?<\/untrusted_content>$/, "")
				.replace(/\n*\[Showing lines [^\n]*\]$/, "");
		expect(readText("e11-read-2"), "the final chunk announces no further continuation").not.toContain("Use offset=");
		const reconstructed = [readText("e11-read-1"), readText("e11-read-2")].map(withoutReadEnvelope).join("\n");
		expect(reconstructed, "the chunked root read reconstructs the exact first output").toBe(E11_LARGE);
		expect(
			createHash("sha256").update(reconstructed).digest("hex"),
			"the chunked bytes match the content digest the attempt carries",
		).toBe(largeSha);
		expect(
			createHash("sha256")
				.update(String(world.io.readFileSync(artifactPath, "utf8")))
				.digest("hex"),
			"the host reads the same bytes from the artifact file",
		).toBe(largeSha);
	}
	expect(await world.disposeSessionInBody(eSession), "the auxiliary stale-pass root disposes cleanly").toBeUndefined();
	trace.mark("root", "e-stale-pass");
}
