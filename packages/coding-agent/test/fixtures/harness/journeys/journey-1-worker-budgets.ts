import "../builtin-install.ts";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { WorkerConversationStore } from "../../../../src/core/delegation/worker-conversation-store.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { MAX_RETAINED_DIAGNOSTIC_CHARS } from "../../../../src/core/security/secret-text.ts";
import { calls, createBarrier, fail } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import { ICM_INTAKE_JUDGMENTS, LIMITS_PATH, latestBatchResults } from "./shared.ts";

const e4Judgments = ICM_INTAKE_JUDGMENTS;

export async function runJourney1WorkerBudgetsPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// E8 (worker budget and bash): a read-only worker runs its bash through the scripted shell. Each provider response is charged to the
	// preset's token budget, with cache reads at the cache-read weight: 1,000 input and 20,000 cache-read tokens charge 3,000, not 21,000.
	// The second response exhausts the 5,500 budget, so its read is refused and no third provider request reaches the scripted provider.
	const E8_BUDGET_PROFILE: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "e8-budget",
		description: "Read-only worker with a 5,500-token budget.",
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
		budget: { maxTokens: 5_500 },
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(E8_BUDGET_PROFILE, "global");
	const e8Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e8Session = e8Created.session;
	const e8Wake = createBarrier();
	const E8_USAGE = { ...createEmptyUsage(), input: 1_000, cacheRead: 20_000, totalTokens: 21_000 };
	world.shell.enqueue({
		name: "e8-echo",
		command: "echo e8-bash",
		cwd: HARNESS_PROJECT_CWD,
		output: "e8-bash\n",
		exitCode: 0,
	});
	world.provider.enqueue(
		"root",
		calls("e8-start", [
			{
				id: "e8-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "e8-budget",
					instructions: "Run the echo check, then read the limits file.",
				},
			},
		]),
		{
			name: "e8-start-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the budget reader did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The budget reader is started." }] },
		},
		{
			name: "e8-wake",
			maxRequests: 8,
			until: (request) => {
				const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
				if (done) e8Wake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	world.provider.enqueue(
		"worker-a",
		{
			name: "e8-worker-bash",
			check: (request) => {
				const offered = (request.context.tools ?? []).map((tool) => tool.name);
				if (!offered.includes("bash") || !offered.includes("read")) {
					throw new Error(`the budget reader is not offered bash and read: ${offered.join(", ")}`);
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "e8-bash-1", name: "bash", arguments: { command: "echo e8-bash" } }],
				stopReason: "toolUse",
				usage: E8_USAGE,
			},
		},
		{
			name: "e8-worker-read",
			check: (request) => {
				const bash = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (bash?.isError || !bash?.text.includes("e8-bash")) {
					throw new Error(`the bash call did not run through the shell: ${bash?.text ?? "no result"}`);
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "e8-second-1", name: "bash", arguments: { command: "echo e8-second" } }],
				stopReason: "toolUse",
				usage: E8_USAGE,
			},
		},
	);
	world.systemOne.enterPhase("e8-start", {
		...e4Judgments,
		leaves_machine: { kind: "noul", probability: 0.02 },
		cannot_be_undone: { kind: "noul", probability: 0.02 },
		touches_outside_task: { kind: "noul", probability: 0.02 },
		acquires_external_code: { kind: "noul", probability: 0.02 },
		request_authorizes: { kind: "noul", probability: 0.02 },
	});
	const e8ReachedBefore = world.provider.reached.length;
	await withDeadline(trace, "E8 start turn", e8Session.prompt("Start the budget reader."));
	await withDeadline(trace, "E8 handoff woke the root", e8Wake.promise, 90_000);
	await withDeadline(trace, "E8 root idle", e8Session.waitForForegroundIdle());
	expect(
		world.provider.reached.slice(e8ReachedBefore).filter((name) => name.startsWith("worker-a")),
		"the budgeted worker reaches exactly two provider requests: the third is refused before the provider",
	).toEqual(["worker-a:e8-worker-bash", "worker-a:e8-worker-read"]);
	expect(
		world.shell.requests.filter((request) => request.command === "echo e8-second"),
		"the budget refuses the second effect before it reaches the shell",
	).toHaveLength(0);
	expect(
		world.shell.requests.filter((request) => request.command === "echo e8-bash").length,
		"the worker's bash ran exactly once through the shell",
	).toBe(1);
	expect(
		Object.values(e8Session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).map(
			(attempt) => attempt.status,
		),
		"the budget denial terminalizes the worker's only attempt",
	).toEqual(["partial"]);
	expect(await world.disposeSessionInBody(e8Session), "the E8 owner disposes cleanly").toBeUndefined();
	trace.mark("root", "e8.budget");

	// E8 (transient provider failures): a worker's provider request that fails transiently is retried inside the attempt, three attempts
	// at most with the worker's 2 s base; when those are spent the durable ladder (two attempts, 5 s base) starts one more attempt. Request
	// admission times are recorded to check the inner gaps against their base, with jitter bounds. The ladder's alarm runs on the
	// session's orchestration timers, so its retry is reached by advancing that clock, never by waiting out the wall clock.
	const E8_TRANSIENT_PROFILE: OrchestrationProfile = {
		...E8_BUDGET_PROFILE,
		profileId: "e8-transient",
		description: "Read-only worker for the transient-failure check.",
		budget: { maxTokens: 50_000 },
	};
	new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(E8_TRANSIENT_PROFILE, "global");
	const e8tCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e8tSession = e8tCreated.session;
	const e8tWake = createBarrier();
	const e8tAdmitted: number[] = [];
	const e8tStamp = (): { check: () => void } => ({
		check: () => {
			e8tAdmitted.push(Date.now());
		},
	});
	world.provider.enqueue(
		"root",
		calls("e8t-start", [
			{
				id: "e8t-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "e8-transient",
					instructions: "Read the limits file, then report.",
				},
			},
		]),
		{
			name: "e8t-start-reply",
			reply: { content: [{ type: "text", text: "The transient reader is started." }] },
		},
		{
			name: "e8t-wake",
			maxRequests: 8,
			until: (request) => {
				const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
				if (done) e8tWake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	const E8_TRANSIENT_ERROR = "503 service unavailable (scripted transient)";
	world.provider.enqueue(
		"worker-a",
		{ ...fail("e8t-fail-1", E8_TRANSIENT_ERROR), ...e8tStamp() },
		{ ...fail("e8t-fail-2", E8_TRANSIENT_ERROR), ...e8tStamp() },
		{ ...fail("e8t-fail-3", E8_TRANSIENT_ERROR), ...e8tStamp() },
		{
			name: "e8t-report",
			...e8tStamp(),
			reply: {
				content: [
					{
						type: "toolCall",
						id: "e8t-report-1",
						name: "submit_report",
						arguments: { status: "completed", summary: "The limits file was read." },
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.systemOne.enterPhase("e8t-start", e4Judgments);
	await withDeadline(trace, "E8 transient start turn", e8tSession.prompt("Start the transient reader."));
	// The first ladder delay is round(5 000 + 0.2 * 5 000 * random), at most 6 000 ms; the alarm is armed with the persisted deadline
	// less the orchestration clock's time at arming, so it is positive and no longer than that delay.
	const e8tArmedMs = await withDeadline(
		trace,
		"E8 transient ladder alarm armed",
		world.timers.whenArmed("orchestration"),
		120_000,
	);
	expect(world.timers.armedDelays("orchestration"), "the ladder arms exactly one alarm").toEqual([e8tArmedMs]);
	expect(e8tArmedMs, "the ladder alarm is armed with a positive delay").toBeGreaterThan(0);
	expect(e8tArmedMs, "the ladder alarm is due within the policy's first-retry ceiling").toBeLessThanOrEqual(6_000);
	expect(
		Object.values(e8tSession.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).map((attempt) => [
			attempt.status,
			attempt.retry?.retriesUsed,
		]),
		"the armed retry belongs to the lane's one attempt, durably suspended on its first ladder retry",
	).toEqual([["suspended", 1]]);
	expect(world.timers.advance("orchestration", e8tArmedMs - 1), "no ladder retry fires before its delay").toBe(0);
	expect(world.timers.advance("orchestration", 1), "the ladder retry fires once its delay has elapsed").toBe(1);
	expect(world.timers.armedDelays("orchestration"), "the fired ladder alarm leaves no alarm armed").toEqual([]);
	world.faultMatrix.witness("e8t", { control: false });
	await withDeadline(trace, "E8 transient handoff woke the root", e8tWake.promise, 120_000);
	await withDeadline(trace, "E8 transient root idle", e8tSession.waitForForegroundIdle());
	expect(
		world.provider.reached.filter((name) => name.startsWith("worker-a:e8t-")),
		"the transient failures are retried inside one attempt, then one ladder attempt succeeds",
	).toEqual(["worker-a:e8t-fail-1", "worker-a:e8t-fail-2", "worker-a:e8t-fail-3", "worker-a:e8t-report"]);
	expect(
		world.warnings.filter(
			(message) =>
				message.includes("(server_error); retrying") || message.includes("retrying from the persisted transcript"),
		),
		"the retries announce two inner waits and one ladder wait, and nothing else",
	).toHaveLength(3);
	// The ladder announces Math.ceil(delayMs / 1000) seconds; its first delay is in [5 000, 6 000], so 5 or 6, and the armed alarm
	// is no longer than that delay.
	const e8tLadderWarnings = world.warnings.filter((message) =>
		message.includes("retrying from the persisted transcript"),
	);
	expect(e8tLadderWarnings, "one ladder wait is announced").toHaveLength(1);
	expect(e8tLadderWarnings[0], "the ladder announces its first delay in whole seconds").toMatch(
		/ in [56]s \(attempt 2\)\.$/,
	);
	const e8tLadderSeconds = Number(/ in ([56])s \(attempt 2\)\.$/.exec(e8tLadderWarnings[0] ?? "")?.[1]);
	expect(e8tArmedMs, "the armed ladder alarm is no longer than the announced delay").toBeLessThanOrEqual(
		e8tLadderSeconds * 1_000,
	);
	const e8tGaps = e8tAdmitted.slice(1).map((time, index) => time - (e8tAdmitted[index] ?? time));
	expect(e8tGaps.length, "four admissions give three gaps").toBe(3);
	expect(e8tGaps[0] ?? 0, "the first inner retry waits about the 2 s base").toBeGreaterThanOrEqual(1_500);
	expect(e8tGaps[1] ?? 0, "the second inner retry waits about twice the base").toBeGreaterThanOrEqual(3_000);
	world.faultMatrix.witness("R9", { control: false });
	expect(await world.disposeSessionInBody(e8tSession), "the E8 transient owner disposes cleanly").toBeUndefined();
	trace.mark("root", "e8.transient");

	// E8 one attempt (owner-authored maxAttempts 1, transient failures): the same three transient 503 failures run inside one attempt, the
	// inner retries are the only retries announced, and the durable ladder never starts. The lane terminalizes failed with completion_error.
	const E8_ONE_ATTEMPT_PROFILE: OrchestrationProfile = {
		...E8_TRANSIENT_PROFILE,
		profileId: "e8-one-attempt",
		description: "Read-only worker whose owner allows exactly one attempt.",
		budget: { maxTokens: 50_000, maxAttempts: 1 },
	};
	new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(E8_ONE_ATTEMPT_PROFILE, "global");
	const e8oCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e8oSession = e8oCreated.session;
	const e8oWake = createBarrier();
	const e8oAdmitted: number[] = [];
	const e8oStamp = (): { check: () => void } => ({
		check: () => {
			e8oAdmitted.push(Date.now());
		},
	});
	world.provider.enqueue(
		"root",
		calls("e8o-start", [
			{
				id: "e8o-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "e8-one-attempt",
					instructions: "Read the limits file, then report.",
				},
			},
		]),
		{
			name: "e8o-start-reply",
			reply: { content: [{ type: "text", text: "The one-attempt reader is started." }] },
		},
		{
			name: "e8o-wake",
			maxRequests: 8,
			until: (request) => {
				const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
				if (done) e8oWake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	const e8oWarningsBefore = world.warnings.length;
	world.provider.enqueue(
		"worker-a",
		{ ...fail("e8o-fail-1", E8_TRANSIENT_ERROR), ...e8oStamp() },
		{ ...fail("e8o-fail-2", E8_TRANSIENT_ERROR), ...e8oStamp() },
		{ ...fail("e8o-fail-3", E8_TRANSIENT_ERROR), ...e8oStamp() },
	);
	world.systemOne.enterPhase("e8o-start", e4Judgments);
	await withDeadline(trace, "E8 one-attempt start turn", e8oSession.prompt("Start the one-attempt reader."));
	await withDeadline(trace, "E8 one-attempt handoff woke the root", e8oWake.promise, 120_000);
	await withDeadline(trace, "E8 one-attempt root idle", e8oSession.waitForForegroundIdle());
	expect(
		world.provider.reached.filter((name) => name.startsWith("worker-a:e8o-")),
		"the transient failures run as exactly three inner requests, with no fourth request",
	).toEqual(["worker-a:e8o-fail-1", "worker-a:e8o-fail-2", "worker-a:e8o-fail-3"]);
	const e8oWarnings = world.warnings.slice(e8oWarningsBefore);
	expect(
		e8oWarnings.filter((message) => message.includes("retrying from the persisted transcript")),
		"the one-attempt owner announces no durable ladder retry",
	).toHaveLength(0);
	expect(
		e8oWarnings.filter((message) => message.includes("provider request failed (server_error); retrying")),
		"the transient failures announce exactly their two inner retries",
	).toHaveLength(2);
	const e8oAttempts = Object.values(e8oSession.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
	expect(
		e8oAttempts.map((attempt) => attempt.status),
		"the lane's single attempt terminalizes failed",
	).toEqual(["failed"]);
	expect(e8oAttempts[0]?.result?.reasonCode, "the failed attempt names its completion error").toBe("completion_error");
	expect(e8oAttempts[0]?.retry, "the attempt never entered the durable retry ladder").toBeUndefined();
	expect(world.timers.armedDelays("orchestration"), "the one-attempt owner arms no ladder alarm").toEqual([]);
	world.faultMatrix.witness("e8t", { control: true });
	const e8oGaps = e8oAdmitted.slice(1).map((time, index) => time - (e8oAdmitted[index] ?? time));
	expect(e8oGaps.length, "three admissions give two gaps").toBe(2);
	expect(e8oGaps[0] ?? 0, "the first inner retry waits about the 2 s base").toBeGreaterThanOrEqual(1_500);
	expect(e8oGaps[1] ?? 0, "the second inner retry waits about twice the base").toBeGreaterThanOrEqual(3_000);
	expect(await world.disposeSessionInBody(e8oSession), "the E8 one-attempt owner disposes cleanly").toBeUndefined();
	trace.mark("root", "e8.one-attempt");

	// E8 unknown failure: a provider failure that matches no classifier pattern is not transient, so it is requested once. The inner loop
	// stops at once, the durable ladder announces no retry, and the lane terminalizes failed with completion_error.
	const e8uCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e8uSession = e8uCreated.session;
	const e8uWake = createBarrier();
	// The opaque failure carries a provider-key shape and runs past the retained diagnostic bound, so the persisted worker record
	// must mask the key and bound the line. The key is joined from two literals so no source line carries it whole.
	const E8_OPAQUE_KEY = ["AIzaD3kQ9vL", "m2Xp8Rt4Wz6Yc1Nb5Hj7Fg0TsUe9"].join("");
	const E8_OPAQUE_ERROR = `scripted opaque failure xyz ${E8_OPAQUE_KEY} ${"x".repeat(260)}`;
	world.provider.enqueue(
		"root",
		calls("e8u-start", [
			{
				id: "e8u-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "e8-transient",
					instructions: "Read the limits file, then report.",
				},
			},
		]),
		{
			name: "e8u-start-reply",
			reply: { content: [{ type: "text", text: "The opaque reader is started." }] },
		},
		{
			name: "e8u-wake",
			maxRequests: 8,
			until: (request) => {
				const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
				if (done) e8uWake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	const e8uWarningsBefore = world.warnings.length;
	world.provider.enqueue("worker-a", fail("e8u-fail", E8_OPAQUE_ERROR));
	world.systemOne.enterPhase("e8u-start", e4Judgments);
	await withDeadline(trace, "E8 opaque start turn", e8uSession.prompt("Start the opaque reader."));
	await withDeadline(trace, "E8 opaque handoff woke the root", e8uWake.promise, 120_000);
	await withDeadline(trace, "E8 opaque root idle", e8uSession.waitForForegroundIdle());
	expect(
		world.provider.reached.filter((name) => name.startsWith("worker-a:e8u-")),
		"the opaque failure is requested exactly once",
	).toEqual(["worker-a:e8u-fail"]);
	const e8uWarnings = world.warnings.slice(e8uWarningsBefore);
	expect(
		e8uWarnings.filter(
			(message) =>
				message.includes("provider request failed") || message.includes("retrying from the persisted transcript"),
		),
		"the opaque failure announces no inner or ladder retry",
	).toHaveLength(0);
	world.faultMatrix.witness("R9", { control: true });
	const e8uAttempts = Object.values(e8uSession.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
	expect(
		e8uAttempts.map((attempt) => attempt.status),
		"the lane's single attempt terminalizes failed",
	).toEqual(["failed"]);
	expect(e8uAttempts[0]?.result?.reasonCode, "the opaque failure terminalizes as a completion error").toBe(
		"completion_error",
	);
	expect(world.timers.armedDelays("orchestration"), "the opaque failure arms no ladder alarm").toEqual([]);
	// The failure is retained on the worker's own persisted transcript: masked, bounded, and without the raw key.
	const e8uAgentId = e8uAttempts[0]?.agentId;
	const e8uBinding =
		e8uAgentId === undefined ? undefined : e8uSession.backgroundLanes.getTaskRuntimeSnapshot()?.agents[e8uAgentId];
	if (e8uAgentId === undefined || e8uBinding === undefined) {
		throw new Error("the opaque worker has no binding for its persisted transcript");
	}
	const e8uPersistedErrors = new WorkerConversationStore()
		.open({
			agentDir: world.agentDir,
			resumeContext: e8uBinding.resumeContext,
			expectedLogicalAgentId: e8uAgentId,
		})
		.getRawTranscript()
		.flatMap((message) =>
			message.role === "assistant" && message.errorMessage !== undefined ? [message.errorMessage] : [],
		);
	const e8uPersistedError = e8uPersistedErrors.at(-1) ?? "";
	expect(
		e8uPersistedError.startsWith("scripted opaque failure xyz [REDACTED] "),
		"the persisted failure keeps its text with the provider key masked",
	).toBe(true);
	expect(e8uPersistedError.includes(E8_OPAQUE_KEY), "the raw key never reaches the persisted record").toBe(false);
	expect(e8uPersistedError.length, "the persisted failure is bounded to the retained diagnostic length").toBe(
		MAX_RETAINED_DIAGNOSTIC_CHARS,
	);
	expect(await world.disposeSessionInBody(e8uSession), "the E8 opaque owner disposes cleanly").toBeUndefined();
	trace.mark("root", "e8.unknown");

	// E8 cost budget (provider-reported cost): the first provider reply reports a consistent cost of 0.3 USD, above the owner's 0.2 USD
	// cap. Its tool call is refused by the grant's own cost check before any effect, and that refusal terminalizes the only attempt partial
	// with the exact native reason. The worker's second provider request never happens.
	const E8C_INPUT_COST = 0.25;
	const E8C_OUTPUT_COST = 0.05;
	const E8C_TOTAL_COST = E8C_INPUT_COST + E8C_OUTPUT_COST;
	const E8C_PROFILE: OrchestrationProfile = {
		...E8_BUDGET_PROFILE,
		profileId: "e8-cost",
		description: "Read-only worker with a 0.2 USD cost cap.",
		budget: { maxTokens: 50_000, maxCostUsd: 0.2 },
	};
	new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(E8C_PROFILE, "global");
	const e8cCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e8cSession = e8cCreated.session;
	const e8cWake = createBarrier();
	world.provider.enqueue(
		"root",
		calls("e8c-start", [
			{
				id: "e8c-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "e8-cost",
					instructions: "Read the limits file, then report.",
				},
			},
		]),
		{
			name: "e8c-start-reply",
			reply: { content: [{ type: "text", text: "The cost-capped reader is started." }] },
		},
		{
			name: "e8c-wake",
			maxRequests: 8,
			until: (request) => {
				const tail = request.context.messages.at(-1);
				const done = tail?.role === "user" && JSON.stringify(tail).includes("Background worker terminal handoff");
				if (done) e8cWake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	world.provider.enqueue("worker-a", {
		name: "e8c-read",
		reply: {
			content: [{ type: "toolCall", id: "e8c-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
			stopReason: "toolUse",
			usage: {
				...createEmptyUsage(),
				input: 1_000,
				output: 100,
				totalTokens: 1_100,
				cost: {
					...createEmptyUsage().cost,
					input: E8C_INPUT_COST,
					output: E8C_OUTPUT_COST,
					total: E8C_TOTAL_COST,
				},
			},
		},
	});
	world.systemOne.enterPhase("e8c-start", e4Judgments);
	await withDeadline(trace, "E8 cost start turn", e8cSession.prompt("Start the cost-capped reader."));
	await withDeadline(trace, "E8 cost handoff woke the root", e8cWake.promise, 120_000);
	await withDeadline(trace, "E8 cost root idle", e8cSession.waitForForegroundIdle());
	expect(
		world.provider.reached.filter((name) => name.startsWith("worker-a:e8c-")),
		"the cost-capped worker reaches exactly one provider request: the second is never made",
	).toEqual(["worker-a:e8c-read"]);
	const e8cAttempts = Object.values(e8cSession.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
	expect(
		e8cAttempts.map((attempt) => attempt.status),
		"the cost refusal terminalizes the worker's only attempt partial",
	).toEqual(["partial"]);
	expect(e8cAttempts[0]?.result?.reasonCode, "the native reason is the grant's cost refusal, not a tree refusal").toBe(
		"cost_budget_exhausted",
	);
	expect(await world.disposeSessionInBody(e8cSession), "the E8 cost owner disposes cleanly").toBeUndefined();
	trace.mark("root", "e8.cost");

	// Held native read-only Bash (E4 active reload): a read-only check is held at its shell gate after its tool has started. A reload while the
	// tool is active is refused, and the durable entries and the lifecycle snapshot are the ones captured at the tool start. The gate is released
	// and the turn joined in finally, so a failed assertion never leaves the shell held; the turn completes once, then the same reload succeeds.
	const hbLifecycleChanged = (before: object, after: object): string[] =>
		Object.keys(before)
			.filter((key) => JSON.stringify(Reflect.get(before, key)) !== JSON.stringify(Reflect.get(after, key)))
			.map((key) =>
				`${key}: ${JSON.stringify(Reflect.get(before, key))} -> ${JSON.stringify(Reflect.get(after, key))}`.slice(
					0,
					1200,
				),
			);
	const hbCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const hbSession = hbCreated.session;
	const hbManager = hbCreated.sessionManager;
	const hbToolStarted = createBarrier();
	const hbGate = createBarrier();
	const hbShellAdmitted = createBarrier();
	world.shell.enqueue({
		name: "held-readonly-bash",
		command: "echo held-check",
		cwd: HARNESS_PROJECT_CWD,
		output: "held-check\n",
		exitCode: 0,
		gate: hbGate.promise,
		check: (request) => {
			if (request.command !== "echo held-check" || request.cwd !== HARNESS_PROJECT_CWD) {
				throw new Error(`the held shell admitted an unexpected command: ${request.command} in ${request.cwd}`);
			}
			hbShellAdmitted.release();
		},
	});
	world.provider.enqueue(
		"root",
		calls("hb-bash", [{ id: "hb-bash-1", name: "bash", arguments: { command: "echo held-check" } }]),
		{
			name: "hb-reply",
			check: (request) => {
				const result = latestBatchResults(request).find((item) => item.toolName === "bash");
				if (result?.isError || !result?.text.includes("held-check")) {
					throw new Error(`the held check did not finish through the shell: ${result?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The held check finished." }] },
		},
	);
	const hbUnsubscribe = hbSession.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "bash") hbToolStarted.release();
	});
	world.systemOne.enterPhase("hb-held", {
		...e4Judgments,
		states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
		states_committed: { kind: "noul", probability: 0.02 },
		states_pushed: { kind: "noul", probability: 0.02 },
		states_published: { kind: "noul", probability: 0.02 },
		states_files_changed: { kind: "noul", probability: 0.02 },
	});
	let hbOutcome: unknown;
	const hbPrompt = hbSession.prompt("Run the held read-only check.").catch((error: unknown) => error);
	try {
		await withDeadline(trace, "held bash tool started", hbToolStarted.promise);
		await withDeadline(trace, "held bash admitted at the shell", hbShellAdmitted.promise);
		const hbEntriesAtGate = JSON.stringify(hbManager.getEntries());
		const hbCountAtGate = hbManager.getEntries().length;
		const hbLifecycleAtGate = hbSession.getResourceSnapshot();
		const hbRefusal = await hbSession.reload().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(
			hbRefusal instanceof Error ? hbRefusal.message : undefined,
			"a reload while the held tool is active is refused",
		).toContain("while the agent is streaming or a tool call is active");
		const hbAppended = hbManager
			.getEntries()
			.slice(hbCountAtGate)
			.map((entry) => ({
				id: entry.id,
				type: entry.type,
				parentId: entry.parentId,
				toolCallId:
					entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : undefined,
				text: JSON.stringify(entry),
			}));
		expect(
			{
				appended: hbAppended,
				prefixUnchanged: JSON.stringify(hbManager.getEntries().slice(0, hbCountAtGate)) === hbEntriesAtGate,
				lifecycleChangedKeys: hbLifecycleChanged(hbLifecycleAtGate, hbSession.getResourceSnapshot()),
			},
			"the refused reload leaves the durable entries and lifecycle unchanged while the held tool runs",
		).toEqual({ appended: [], prefixUnchanged: true, lifecycleChangedKeys: [] });
	} finally {
		hbGate.release();
		hbOutcome = await withDeadline(trace, "held bash turn joined", hbPrompt);
		hbUnsubscribe();
	}
	expect(hbOutcome, "the held turn completes once, without an error").toBeUndefined();
	expect(
		hbSession.messages.some(
			(message) =>
				message.role === "assistant" && JSON.stringify(message.content).includes("The held check finished."),
		),
		"the held turn's reply is recorded",
	).toBe(true);
	const hbReadBefore = hbSession.getToolDefinition("read");
	await withDeadline(trace, "held bash idle reload", hbSession.reload());
	expect(hbSession.getToolDefinition("read"), "the idle reload rebinds the read tool definition").not.toBe(
		hbReadBefore,
	);
	expect(await world.disposeSessionInBody(hbSession), "the held bash owner disposes cleanly").toBeUndefined();
	trace.mark("root", "e4.held-bash-reload");
}
