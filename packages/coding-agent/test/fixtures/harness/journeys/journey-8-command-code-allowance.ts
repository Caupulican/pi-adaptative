import "../builtin-install.ts";
import { join } from "node:path";
import type { CommandCodeAccountUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import {
	COMMAND_CODE_PROVIDER,
	commandCodeUsageSnapshot,
} from "../../../../src/core/provider-admission/usage-overview.ts";
import { WALL_ALARM_RECHECK_MS } from "../../../../src/kernel/timer-port.ts";
import { type Barrier, createBarrier, HARNESS_API, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carriesMarker,
	delegateReceipts,
	handoffTurn,
	settle,
	startedAgents,
	startOf,
	submitReport,
} from "./journey-8-shared.ts";
import { expectOwnerWords, INTAKE_JUDGMENTS_WITHOUT_GRANT } from "./shared.ts";

/**
 * Leg 4: Command Code subscription allowance holds new subscription starts while a usage window is at 100%,
 * never lets extra purchased/free credits mask the exhausted window, leaves metered starts on another account
 * free to run, and wakes the queued subscription worker once the reset time passes.
 */

const CC_MODEL = "cc-sub-worker";
const METERED_MODEL = "worker-b";
const CC_BASE_URL = "https://api.commandcode.ai";
const NOTE_TEXT = "the retry limit is three\n";
const RESET_MS = 60_000;
const MAX_REOPEN_JITTER_MS = 6_000;
const REOPEN_SLACK_MS = 5_000;

const WARM_PROMPT = "Start one Command Code subscription worker to read the note.";
const HELD_PROMPT = "Start a second Command Code worker and one metered worker on the harness account.";

function instructionsOf(tag: string): string {
	return `Read notes.md and report its first line. You are worker ${tag}.`;
}

function startOnProvider(
	id: string,
	provider: string,
	modelId: string,
	instructions: string,
	independentOf: readonly string[],
): { id: string; name: string; arguments: Record<string, unknown> } {
	return {
		id,
		name: "delegate",
		arguments: {
			action: "start",
			model: { provider, modelId },
			instructions,
			readOnly: true,
			...(independentOf.length > 0
				? {
						parallelWork: {
							independentOf: [...independentOf],
							justification: "Each worker reports independently on its own account.",
						},
					}
				: {}),
		},
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function assertRecognizedPlanMonthlyZeroSnapshot(): void {
	const periodEndMs = Date.parse("2026-10-08T01:00:00.000Z");
	const usage: CommandCodeAccountUsage = {
		whoami: {
			user: { id: "u-cc-monthly", email: "dev@example.com" },
			orgLimits: [],
		},
		billingCredits: {
			credits: {
				planId: "pro",
				monthlyCredits: 0,
				purchasedCredits: 25,
				freeCredits: 5,
			},
		},
		subscription: {
			planId: "pro",
			status: "active",
			currentPeriodStart: "2026-09-08T01:00:00.000Z",
			currentPeriodEnd: periodEndMs,
		},
		usageSummary: {
			totalCost: 20,
			totalCount: 12,
			periodBasis: "billing-period",
		},
		planId: "pro",
		plan: "Pro",
		planMonthlyCredits: 20,
	};
	const snapshot = commandCodeUsageSnapshot(usage);
	expect(
		{
			windows: snapshot.windows,
			balance: snapshot.balance,
		},
		"a recognized Command Code plan with 0 monthly included credits left reports a 100% monthly window while keeping extra credits as balance only",
	).toEqual({
		windows: [
			{
				id: "monthly",
				label: "Monthly included",
				usedPercent: 100,
				resetsAt: periodEndMs,
				detail: "$0.00 of $20.00 left",
			},
		],
		balance: "extra credits $30.00 USD",
	});
}

export async function runJourney8CommandCodeAllowancePhase(world: HarnessWorld): Promise<void> {
	assertRecognizedPlanMonthlyZeroSnapshot();

	const trace = world.trace;
	world.io.seed(join(HARNESS_PROJECT_CWD, "notes.md"), NOTE_TEXT);

	const realDateNow = Date.now;
	let clockOffsetMs = 0;
	Date.now = () => realDateNow() + clockOffsetMs;

	const previousFetchResponder = world.fetchResponder;
	const baseNowMs = Date.now();
	const resetAtMs = baseNowMs + RESET_MS;
	const resetAtIso = new Date(resetAtMs).toISOString();
	const weeklyResetIso = new Date(baseNowMs + 7 * 86_400_000).toISOString();
	const periodStartIso = new Date(baseNowMs - 3 * 86_400_000).toISOString();

	const usageFetched = createBarrier();
	const fetchedPaths: string[] = [];

	world.fetchResponder = (input) => {
		const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!rawUrl.startsWith(`${CC_BASE_URL}/`)) return undefined;
		const parsed = new URL(rawUrl);
		fetchedPaths.push(`${parsed.pathname}${parsed.search}`);
		if (parsed.pathname === "/alpha/whoami") {
			return Promise.resolve(
				jsonResponse({
					success: true,
					user: { id: "u-cc-1", email: "dev@example.com" },
				}),
			);
		}
		if (parsed.pathname === "/alpha/billing/credits") {
			return Promise.resolve(
				jsonResponse({
					credits: {
						planId: "pro",
						monthlyCredits: 12,
						purchasedCredits: 25,
						freeCredits: 5,
					},
					windowLimits: {
						limited: true,
						fiveHour: { used: 100, cap: 100, resetAt: resetAtIso },
						weekly: { used: 40, cap: 500, resetAt: weeklyResetIso },
					},
				}),
			);
		}
		if (parsed.pathname === "/alpha/billing/subscriptions") {
			return Promise.resolve(
				jsonResponse({
					success: true,
					data: {
						planId: "pro",
						status: "active",
						currentPeriodStart: periodStartIso,
						currentPeriodEnd: weeklyResetIso,
					},
				}),
			);
		}
		if (parsed.pathname === "/alpha/usage/summary") {
			usageFetched.release();
			return Promise.resolve(
				jsonResponse({
					totalCost: 8,
					totalCount: 14,
					periodBasis: "billing-period",
				}),
			);
		}
		return Promise.resolve(new Response("Not found", { status: 404 }));
	};

	let created: Awaited<ReturnType<typeof world.createRootSession>> | undefined;
	try {
		world.authStorage.set(COMMAND_CODE_PROVIDER, {
			type: "oauth",
			access: "cc-sub-oauth-token",
			refresh: "",
			expires: baseNowMs + 86_400_000,
		});
		world.modelRegistry.registerProvider(COMMAND_CODE_PROVIDER, {
			api: HARNESS_API,
			baseUrl: CC_BASE_URL,
			apiKey: "cc-unused",
			models: [
				{
					id: CC_MODEL,
					name: "Command Code Subscription Worker",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_768,
					maxTokens: 4_096,
				},
			],
		});

		const sessionManager = world.createSessionManager();
		created = await world.createRootSession("root", {
			sessionManager,
			settings: {
				modelFavorites: [
					...world.settingsManager.getModelFavorites(),
					{ provider: COMMAND_CODE_PROVIDER, modelId: CC_MODEL },
				],
			},
		});
		const session = created.session;
		const ccModel = world.modelRegistry.find(COMMAND_CODE_PROVIDER, CC_MODEL);
		if (!ccModel) throw new Error("expected registered Command Code subscription model");
		session.setRouterPool({
			source: "sdk_models",
			models: [...session.getRouterCandidatePool().models, ccModel],
		});

		const warmRequest = createBarrier();
		const meteredRequest = createBarrier();
		const heldRequest = createBarrier();
		const wakes: Barrier[] = [createBarrier(), createBarrier(), createBarrier()];
		const wakeAt = (index: number): Barrier => {
			const barrier = wakes[index];
			if (barrier === undefined) throw new Error(`no wake barrier at ${index}`);
			return barrier;
		};

		world.provider.enqueueTrack("j8d-warm", CC_MODEL, carriesMarker("You are worker cc-warm."), {
			name: "j8d-warm-report",
			check: () => warmRequest.release(),
			reply: submitReport("j8d-warm-report-1", "Warm Command Code worker read the note."),
		});
		world.provider.enqueueTrack("j8d-held", CC_MODEL, carriesMarker("You are worker cc-held."), {
			name: "j8d-held-report",
			check: () => heldRequest.release(),
			reply: submitReport("j8d-held-report-1", "Held Command Code worker ran after the 5h window reset."),
		});
		world.provider.enqueueTrack("j8d-metered", METERED_MODEL, carriesMarker("You are worker metered-control."), {
			name: "j8d-metered-report",
			check: () => meteredRequest.release(),
			reply: submitReport("j8d-metered-report-1", "Metered control worker ran without waiting on Command Code."),
		});

		world.provider.enqueue(
			"root",
			{
				name: "j8d-start-warm",
				reply: () => ({
					content: [
						{
							type: "toolCall",
							...startOnProvider(
								"j8d-warm-1",
								COMMAND_CODE_PROVIDER,
								CC_MODEL,
								instructionsOf("cc-warm"),
								startedAgents(session),
							),
						},
					],
					stopReason: "toolUse",
				}),
			},
			text("j8d-warm-done", "Started the initial Command Code worker."),
			handoffTurn("j8d-wake-warm", wakeAt(0)),
			{
				name: "j8d-start-held",
				reply: () => ({
					content: [
						{
							type: "toolCall",
							...startOnProvider(
								"j8d-held-1",
								COMMAND_CODE_PROVIDER,
								CC_MODEL,
								instructionsOf("cc-held"),
								startedAgents(session),
							),
						},
					],
					stopReason: "toolUse",
				}),
			},
			{
				name: "j8d-start-metered",
				reply: () => ({
					content: [
						{
							type: "toolCall",
							...startOnProvider(
								"j8d-metered-1",
								HARNESS_PROVIDER,
								METERED_MODEL,
								instructionsOf("metered-control"),
								startedAgents(session),
							),
						},
					],
					stopReason: "toolUse",
				}),
			},
			text("j8d-held-done", "Queued the exhausted Command Code worker while the metered worker runs."),
			handoffTurn("j8d-wake-metered", wakeAt(1)),
			handoffTurn("j8d-wake-held", wakeAt(2)),
		);

		world.systemOne.enterPhase("j8d-command-code-allowance", INTAKE_JUDGMENTS_WITHOUT_GRANT, {
			expect: expectOwnerWords({
				sessionManager: () => sessionManager,
				userRequests: [WARM_PROMPT, HELD_PROMPT],
				optionalToolNames: ["secret_store"],
			}),
		});

		// First start: the cached usage reading is empty (unknown -> fail-open), and reading it triggers the Command Code usage fetch.
		await withDeadline(trace, "J8D warm start turn", session.prompt(WARM_PROMPT));
		const warmReceipt = delegateReceipts(session)[0];
		expect(warmReceipt?.isError, warmReceipt?.text ?? "missing warm delegate receipt").toBe(false);
		await withDeadline(trace, "J8D Command Code account usage fetch", usageFetched.promise);
		await withDeadline(trace, "J8D warm worker request", warmRequest.promise);
		await withDeadline(trace, "J8D warm worker handoff", wakeAt(0).promise);
		await withDeadline(trace, "J8D warm worker handoff settles", session.waitForForegroundIdle());
		await settle();

		expect(
			{
				whoami: fetchedPaths.includes("/alpha/whoami?limits=1"),
				credits: fetchedPaths.includes("/alpha/billing/credits"),
				subscriptions: fetchedPaths.includes("/alpha/billing/subscriptions"),
				summary: fetchedPaths.some((entry) => entry.startsWith("/alpha/usage/summary")),
			},
			"AccountUsageMonitor fetched all four Command Code account usage endpoints",
		).toEqual({
			whoami: true,
			credits: true,
			subscriptions: true,
			summary: true,
		});

		// Second turn: Command Code's 5h window is at 100% until resetAtIso despite $30.00 in extra credits;
		// the Command Code worker is held by allowance_exhausted while the metered worker on HARNESS_PROVIDER runs immediately.
		await withDeadline(trace, "J8D held + metered turn", session.prompt(HELD_PROMPT));
		await withDeadline(trace, "J8D metered control worker request", meteredRequest.promise);
		await withDeadline(trace, "J8D metered control handoff", wakeAt(1).promise);
		await withDeadline(trace, "J8D metered control handoff settles", session.waitForForegroundIdle());

		const [, heldStart, meteredStart] = delegateReceipts(session).map(startOf);
		if (heldStart === undefined || meteredStart === undefined) {
			throw new Error("expected receipts for both held Command Code worker and metered control worker");
		}

		const ccRequestsWhileHeld = world.provider.requests.filter((request) => request.model.id === CC_MODEL).length;
		expect(
			{
				heldStarted: heldStart.started,
				heldCodes: heldStart.h,
				heldToldAllowance: heldStart.text.includes(
					`waiting: capacity: the subscription allowance is used up (a usage window is at 100%); it reopens at ${resetAtIso}`,
				),
				meteredStarted: meteredStart.started,
				meteredCodes: meteredStart.h,
				meteredStatus: session.getLaneRecords().find((record) => record.laneId === meteredStart.laneId)?.status,
				heldStatus: session.getLaneRecords().find((record) => record.laneId === heldStart.laneId)?.status,
				ccRequestsWhileHeld,
				fleetAlarms: world.timers.armedDelays("fleet"),
			},
			"extra credits never mask an exhausted 5h subscription window: the Command Code worker waits on allowance_exhausted with a reopen alarm while the metered worker completes",
		).toEqual({
			heldStarted: true,
			heldCodes: ["QUEUED"],
			heldToldAllowance: true,
			meteredStarted: true,
			meteredCodes: undefined,
			meteredStatus: "succeeded",
			heldStatus: "queued",
			ccRequestsWhileHeld: 1,
			fleetAlarms: [WALL_ALARM_RECHECK_MS],
		});

		// Advance past resetAtMs (+ reopen jitter): the 5h window expires, weekly window has room (8%), and the fleet alarm releases the held worker.
		clockOffsetMs += RESET_MS + MAX_REOPEN_JITTER_MS + REOPEN_SLACK_MS;
		world.timers.advance("fleet", WALL_ALARM_RECHECK_MS);

		await withDeadline(trace, "J8D held Command Code worker runs after reset", heldRequest.promise);
		await withDeadline(trace, "J8D held Command Code worker handoff", wakeAt(2).promise);
		await withDeadline(trace, "J8D held Command Code worker handoff settles", session.waitForForegroundIdle());

		expect(
			{
				heldStatus: session.getLaneRecords().find((record) => record.laneId === heldStart.laneId)?.status,
				ccRequestsTotal: world.provider.requests.filter((request) => request.model.id === CC_MODEL).length,
			},
			"once the 5h window resets, the queued Command Code worker runs and finishes cleanly",
		).toEqual({
			heldStatus: "succeeded",
			ccRequestsTotal: 2,
		});

		expect(
			await world.disposeSessionInBody(session),
			"the Command Code allowance root disposes cleanly",
		).toBeUndefined();
		trace.mark("root", "j8.command-code-allowance");
	} finally {
		Date.now = realDateNow;
		world.fetchResponder = previousFetchResponder;
		world.modelRegistry.unregisterProvider(COMMAND_CODE_PROVIDER);
		world.authStorage.remove(COMMAND_CODE_PROVIDER);
	}
}
