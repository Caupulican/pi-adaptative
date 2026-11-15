import "../builtin-install.ts";
import { createEmptyUsage, type Usage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { botOrchestrationHome } from "../../../../src/core/bots/bot-home.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { OWNER_STOPPED_REASON } from "../../../../src/core/delegation/worker-fleet-stop.ts";
import { OrchestrationEventStore } from "../../../../src/core/orchestration/event-store.ts";
import { readTaskRuntimeProjection } from "../../../../src/core/orchestration/task-runtime-reader.ts";
import { workerTerminalNotificationId } from "../../../../src/core/orchestration/worker-terminal-notification.ts";
import {
	orchestrationSessionDir,
	ownerOrchestrationHome,
} from "../../../../src/kernel/session/session-bundle-paths.ts";
import { workerTranscriptLocation } from "../../../../src/kernel/session/worker-storage-identity.ts";
import {
	createBarrier,
	HARNESS_PROVIDER,
	type ScriptedReply,
	type ScriptedRequest,
	type ScriptStep,
} from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	BOT_DELEGATION_JUDGMENTS,
	botCharges,
	botNoticeTexts,
	botSemanticSpend,
	botSessionIds,
	createChargedRoot,
	createOwnerBot,
	enqueueBot,
	lastResult,
	MODEL_ID,
	offeredTools,
	reached,
	TRACK,
	waitForBotRosterState,
	waitForBotRosterView,
} from "./journey-7-shared.ts";
import { carriesMarker, newestText, startCall, submitReport } from "./journey-8-shared.ts";

const DELEGATOR = "pool-director";
const DELEGATOR_SOUL =
	"You direct workers that read the connection pool settings and answer the owner in one sentence.";
const READ_ONLY_DELEGATOR = "pool-reader";
const READ_ONLY_SOUL = "You direct read-only workers over the connection pool settings and answer in one sentence.";
const BOUNDED_DELEGATOR = "pool-timer";
const BOUNDED_SOUL = "You direct workers that read the pool's timeout settings and answer the owner in one sentence.";

/** Every question asks what something is, and every answer states a fact that names no test, check, commit or change. */
const FIRST_QUESTION = "How many connections does the pool hold? Have a worker read the settings.";
const SECOND_QUESTION = "How many idle connections does the pool keep? Have another worker count them.";
const READ_ONLY_QUESTION = "Which connection is closed first? Have a worker read the settings.";
const BOUNDED_QUESTION = "How long does the pool wait for a connection? Have a worker read the settings.";
const FIRST_MARKER = "[j7-delegate-first]";
const HELD_MARKER = "[j7-delegate-held]";
const READ_ONLY_MARKER = "[j7-delegate-read-only]";
const BOUNDED_MARKER = "[j7-delegate-bounded]";
const ROOT_MARKER = "[j7-delegate-root]";
/** The owner's message to the root's worker by its id: it asks what a bot would be asked. */
const ROOT_WORKER_MESSAGE = "How many requests wait for a connection?";
const FIRST_REPORT = "The pool holds eight connections.";
const FIRST_ANSWER = "The worker read that the pool holds eight connections.";
const READ_ONLY_REPORT = "The oldest idle connection is closed first.";
const READ_ONLY_ANSWER = "The worker read that the oldest idle connection is closed first.";
const BOUNDED_REPORT = "The pool waits five seconds for a connection.";
const BOUNDED_ANSWER = "The worker read that the pool waits five seconds for a connection.";
const SECOND_STARTED = "Another worker is counting the idle connections.";
/** What the product tells the owner of a stop that ended the bot's work (text-en/bot-team.ts `botStopped`), whole. */
const STOPPED = `Stopped ${DELEGATOR} (halt).`;
const HANDOFF = "Background worker terminal handoff:";
/** The usage each scripted System One answer reports (`ScriptedSystemOneTransport`), as a receipt records it: input/output. */
const SYSTEM_ONE_ANSWER_TOKENS = "10/5";
/** The product's refusal of a message to a delegate worker's id (`assertBotId`, bot-runtime-bindings.ts), whole. */
const notABot = (id: string): string =>
	`"${id}" is a delegate worker, not a bot; manage it with the delegate tool (status, send, cancel). Bots are created with /bot new or the bot tool under another name.`;

/** The worker's priced reply: the dollars split between input and output, binary-exact so the sums stay exact. */
function priced(input: number, output: number, usd: number): Usage {
	const usage = createEmptyUsage();
	return {
		...usage,
		input,
		output,
		totalTokens: input + output,
		cost: { ...usage.cost, input: usd / 2, output: usd / 2, total: usd },
	};
}

const WORKER_USAGE = priced(1000, 100, 0.25);
/** The main session's worker bound, which holds a bot's request with its workers' spend: within it the bound worker's spend. */
const WORKER_BOUND_USD = 1;
const BOUNDED_WORKER_USAGE = priced(3000, 300, 0.75);
/** The bot's priced answer to its worker's handoff: with the worker's spend, it takes the request past the bound. */
const BOUNDED_ANSWER_USAGE = priced(2000, 200, 0.5);
/** The stop the product tells the owner in the bot's chat (text-en/bot-team.ts `botTurnOverBudget`), whole. */
const OVER_BOUND = `Bot ${BOUNDED_DELEGATOR}: its turn was stopped at the spend bound ($${(BOUNDED_WORKER_USAGE.cost.total + BOUNDED_ANSWER_USAGE.cost.total).toFixed(2)} spent on this request, its workers included; workerDelegation.maxUsd is $${WORKER_BOUND_USD.toFixed(2)}).`;

/** The stable agent id a `delegate start` result names, read out of the result the bot's next request carries. */
function startedAgentId(request: ScriptedRequest): string {
	const result = lastResult(request, "delegate");
	if (result === undefined) throw new Error("the bot's request carries no delegate result");
	if (result.isError) throw new Error(`the bot's delegate start was refused: ${result.text}`);
	const agentId = /stable agentId ([^,\s]+),/.exec(result.text)?.[1];
	if (agentId === undefined) throw new Error(`the delegate start result names no agent: ${result.text}`);
	return agentId;
}

/** A bot's start of a read-only worker on the workers' model: one of its own when it names the workers already made. */
function botStart(id: string, instructions: string, independentOf: readonly string[] = []): ScriptedReply {
	return {
		content: [{ type: "toolCall", ...startCall(id, instructions, MODEL_ID.delegateWorker, independentOf) }],
		stopReason: "toolUse",
	};
}

/** The bot's turn a worker's terminal handoff opens: its input is that handoff, carrying the worker's report. */
function handoffStep(name: string, report: string, answer: string, usage?: Usage): ScriptStep {
	return {
		name,
		check: (request) => {
			const input = newestText(request);
			if (!input.includes(HANDOFF) || !input.includes(report))
				throw new Error(`${name}: the turn's input is not the worker's handoff: ${input}`);
		},
		reply: { content: [{ type: "text", text: answer }], ...(usage ? { usage } : {}) },
	};
}

/** The requests a bot's own session made: its soul opens the system prompt of each. */
function requestsOf(world: HarnessWorld, soul: string): number {
	return world.provider.requests.filter((request) => (request.context.systemPrompt ?? "").includes(soul)).length;
}

/**
 * Leg: a bot directs workers of its own. The owner asks a writing bot a question; in its own session the bot holds
 * `delegate`, `assign`, `plan` and `task_watch`, starts a worker, and the worker's terminal handoff opens the
 * bot's next turn, in which it answers. The worker's conversation lies in the bot's home, under the bot's session, and
 * nothing of that session is in the owner's orchestration home; the worker's spend reaches the main session as the bot
 * session's charge. The owner's stop of the bot while a second worker runs cancels that worker, and its end opens no turn
 * of the bot. A read-only bot's worker is planned read-only: the bot changes no file, so neither does its worker. Under
 * the main session's worker bound (`workerDelegation.maxUsd`), a bot's request is held to it with its worker's spend: the
 * bot's answer to its worker's handoff that takes the request past it is stopped with the product's sentence. A delegate
 * worker of the owner's own session is never a bot: while it runs the roster lists no entry for it, and a message naming
 * it is refused with the product's sentence and leaves no bot record.
 */
export async function runJourney7BotDelegatePhase(world: HarnessWorld): Promise<void> {
	const { session, rootFile } = await createChargedRoot(world, "bot-delegate");
	try {
		await runLeg(world, session, rootFile);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	// The bound has its own main session, so it holds none of the workers above.
	const bounded = await createChargedRoot(world, "bot-delegate-bound", {
		workerDelegation: { maxUsd: WORKER_BOUND_USD },
	});
	try {
		await runWorkerBoundStep(world, bounded.session, bounded.rootFile);
	} finally {
		expect(
			await world.disposeSessionInBody(bounded.session),
			"the bounded owner's session disposes cleanly",
		).toBeUndefined();
	}
	world.trace.mark("root", "j7.bot-delegate");
}

async function runLeg(world: HarnessWorld, session: AgentSession, rootFile: string): Promise<void> {
	const { trace } = world;
	session.upsertPersistentBot({
		agentId: DELEGATOR,
		displayName: displayNameFor(DELEGATOR),
		provider: HARNESS_PROVIDER,
		modelId: MODEL_ID.delegator,
		soul: DELEGATOR_SOUL,
		canWrite: true,
		createdBy: "owner",
	});
	const firstWorkerGo = createBarrier();
	const heldWorkerGate = createBarrier();
	const heldWorkerEnded = createBarrier();
	const seen = {
		offered: [] as string[],
		firstAgent: undefined as string | undefined,
		heldEnd: undefined as string | undefined,
	};
	const firstAgent = (): string => {
		if (seen.firstAgent === undefined) throw new Error("the first worker's id was read before its start result");
		return seen.firstAgent;
	};

	enqueueBot(
		world,
		TRACK.delegator,
		MODEL_ID.delegator,
		DELEGATOR_SOUL,
		{
			name: "j7-delegator-start",
			check: (request) => {
				seen.offered = offeredTools(request);
			},
			reply: botStart(
				"j7-delegator-start-1",
				`${FIRST_MARKER} Read the pool settings and report how many connections the pool holds.`,
			),
		},
		{
			name: "j7-delegator-started",
			check: (request) => {
				seen.firstAgent = startedAgentId(request);
				firstWorkerGo.release();
			},
			reply: { content: [{ type: "text", text: "A worker is reading the pool settings." }] },
		},
		handoffStep("j7-delegator-handoff", FIRST_REPORT, FIRST_ANSWER),
		{
			name: "j7-delegator-second-start",
			// A second start names the worker already made, so it asks for a worker of its own.
			reply: () =>
				botStart(
					"j7-delegator-start-2",
					`${HELD_MARKER} Read the pool settings and report how many idle connections the pool keeps.`,
					[firstAgent()],
				),
		},
		{
			name: "j7-delegator-second-started",
			reply: { content: [{ type: "text", text: SECOND_STARTED }] },
		},
	);
	world.provider.enqueueTrack(TRACK.delegateWorker, MODEL_ID.delegateWorker, carriesMarker(FIRST_MARKER), {
		name: "j7-delegate-worker-report",
		gate: firstWorkerGo.promise,
		reply: { ...submitReport("j7-delegate-worker-report-1", FIRST_REPORT), usage: WORKER_USAGE },
	});
	world.provider.enqueueTrack(TRACK.heldDelegateWorker, MODEL_ID.delegateWorker, carriesMarker(HELD_MARKER), {
		name: "j7-held-delegate-worker",
		// Held until the owner's stop cancels the worker: the cancel aborts the request.
		gate: heldWorkerGate.promise,
		onTerminal: (_request, message) => {
			seen.heldEnd = message.stopReason;
			heldWorkerEnded.release();
		},
		reply: submitReport("j7-held-delegate-worker-report-1", "The pool keeps two idle connections."),
	});

	try {
		// Steps 1 to 4: the owner's question starts a turn that calls a tool, so its words are judged as an owner request that
		// calls a tool is in a bot's own session; the handoff's turn and the workers' answers ask nothing.
		if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-delegate", BOT_DELEGATION_JUDGMENTS);
		const sent = await session.sendOperatorMessageToBot(DELEGATOR, FIRST_QUESTION);
		await withDeadline(
			trace,
			"J7 bot delegate: the worker's handoff opened the bot's answering turn",
			world.provider.whenReached(reached(TRACK.delegator, "j7-delegator-handoff")),
		);
		await waitForBotRosterState(world, session, DELEGATOR, "idle");
		const [botSessionId, ...otherSessions] = botSessionIds(world, DELEGATOR);
		if (botSessionId === undefined) throw new Error("the delegating bot opened no session file");
		const location = workerTranscriptLocation(botOrchestrationHome(world.agentDir, DELEGATOR), {
			parentSessionId: botSessionId,
			logicalAgentId: firstAgent(),
		});
		const charged = () =>
			botCharges(rootFile, botSessionId).reduce((total, report) => total + report.usage.cost.total, 0);
		// The bot's whole spend: its worker's, and its own System One judgments' (none with System One off).
		const spent = () => WORKER_USAGE.cost.total + botSemanticSpend(world, DELEGATOR).usd;
		await withDeadline(
			trace,
			"J7 bot delegate: the worker's spend reached the main session as the bot's charge",
			world.io.waitForMutation(
				() => charged() >= spent() && (!world.systemOne.enabled || botSemanticSpend(world, DELEGATOR).receipts > 0),
			),
		);
		const judged = botSemanticSpend(world, DELEGATOR);
		expect(
			{
				sent: sent.mode,
				otherSessions: otherSessions.length,
				holdsDelegate: seen.offered.includes("delegate"),
				holdsAssign: seen.offered.includes("assign"),
				holdsTaskWatch: seen.offered.includes("task_watch"),
				holdsPlan: seen.offered.includes("plan"),
				workerTranscriptInBotHome: world.io.existsSync(location.sessionFile),
				botSessionInOwnerHome: world.io.existsSync(
					orchestrationSessionDir(ownerOrchestrationHome(world.agentDir), botSessionId),
				),
				judgedBySystemOne: judged.receipts > 0,
				judgedAtScriptedUsage: judged.tokens.every((tokens) => tokens === SYSTEM_ONE_ANSWER_TOKENS),
				charged: charged(),
			},
			"a bot's own session holds the director tools, plan among them, starts a worker whose conversation lies in the bot's home, answers on the worker's handoff, and the worker's spend is charged to the main session as the bot's, with the bot's own System One judgments",
		).toEqual({
			sent: "started",
			otherSessions: 0,
			holdsDelegate: true,
			holdsAssign: true,
			holdsTaskWatch: true,
			holdsPlan: true,
			workerTranscriptInBotHome: true,
			botSessionInOwnerHome: false,
			judgedBySystemOne: world.systemOne.enabled,
			judgedAtScriptedUsage: true,
			charged: expect.closeTo(WORKER_USAGE.cost.total + judged.usd, 10),
		});

		// Step 5: the owner's stop while a second worker runs cancels it, and its end opens no turn of the bot.
		if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-delegate-stop", BOT_DELEGATION_JUDGMENTS);
		const secondSent = await session.sendOperatorMessageToBot(DELEGATOR, SECOND_QUESTION);
		await withDeadline(
			trace,
			"J7 bot delegate: the second worker is working",
			world.provider.whenReached(reached(TRACK.heldDelegateWorker, "j7-held-delegate-worker")),
		);
		// The stop lands after the bot's turn ended, so what it ends is the worker alone: the turn's end records its last words
		// as the bot's outcome on the roster.
		await waitForBotRosterView(
			world,
			session,
			DELEGATOR,
			"ended the turn that told the owner of its second worker",
			(view) => view?.lastSummary === SECOND_STARTED,
		);
		const stopped = session.stopPersistentBot(DELEGATOR);
		const requestsAtStop = requestsOf(world, DELEGATOR_SOUL);
		await withDeadline(trace, "J7 bot delegate: the stopped worker's request ended", heldWorkerEnded.promise);
		// An end the owner's stop made is recorded delivered at once and wakes no one: once the cancelled attempt's end is
		// delivered, a turn it opened would already have been asked for. The first worker's end was recorded delivered when its
		// handoff reached the bot's session (the notification coordinator's confirmed delivery), before the bot's first answer.
		const bundle = new OrchestrationEventStore({
			orchestrationHome: botOrchestrationHome(world.agentDir, DELEGATOR),
			sessionId: botSessionId,
		});
		const attempts = () => {
			const projection = readTaskRuntimeProjection(bundle);
			return Object.values(projection.attempts).map((attempt) => ({
				status: attempt.status,
				end: projection.notifications[workerTerminalNotificationId(attempt.attemptId)]?.status,
			}));
		};
		await withDeadline(
			trace,
			"J7 bot delegate: the cancelled worker's end was delivered",
			world.io.waitForMutation(() =>
				attempts().some((attempt) => attempt.status === "cancelled" && attempt.end === "delivered"),
			),
		);
		await waitForBotRosterState(world, session, DELEGATOR, "idle");
		expect(
			{
				sent: secondSent.mode,
				stopped,
				heldEnd: seen.heldEnd,
				attempts: attempts().sort((a, b) => a.status.localeCompare(b.status)),
				botRequests: requestsOf(world, DELEGATOR_SOUL) - requestsAtStop,
			},
			"the owner's stop of a bot whose worker runs cancels that worker, says it stopped the bot, and the cancelled worker's end, delivered, opens no turn of the bot",
		).toEqual({
			sent: "followed_up",
			stopped: { stopped: true, detail: STOPPED },
			heldEnd: "aborted",
			attempts: [
				{ status: "cancelled", end: "delivered" },
				{ status: "completed", end: "delivered" },
			],
			botRequests: 0,
		});
	} finally {
		heldWorkerGate.release();
	}

	await runReadOnlyStep(world, session);
	await runRootWorkerStep(world, session);
}

/** Step 6: a read-only bot's worker, started without `readOnly`, is planned read-only: its parent changes no file. */
async function runReadOnlyStep(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	createOwnerBot(session, READ_ONLY_DELEGATOR, MODEL_ID.readOnlyDelegator, READ_ONLY_SOUL);
	const workerGo = createBarrier();
	const seen = { startText: "", workerTools: [] as string[] };
	enqueueBot(
		world,
		TRACK.readOnlyDelegator,
		MODEL_ID.readOnlyDelegator,
		READ_ONLY_SOUL,
		{
			name: "j7-read-only-delegator-start",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-read-only-delegator-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: HARNESS_PROVIDER, modelId: MODEL_ID.delegateWorker },
							instructions: `${READ_ONLY_MARKER} Read the pool settings and report which connection is closed first.`,
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-read-only-delegator-started",
			check: (request) => {
				startedAgentId(request);
				seen.startText = lastResult(request, "delegate")?.text ?? "";
				workerGo.release();
			},
			reply: { content: [{ type: "text", text: "A worker is reading the pool settings." }] },
		},
		handoffStep("j7-read-only-delegator-handoff", READ_ONLY_REPORT, READ_ONLY_ANSWER),
	);
	world.provider.enqueueTrack(TRACK.readOnlyDelegateWorker, MODEL_ID.delegateWorker, carriesMarker(READ_ONLY_MARKER), {
		name: "j7-read-only-delegate-worker",
		gate: workerGo.promise,
		check: (request) => {
			seen.workerTools = offeredTools(request);
		},
		reply: submitReport("j7-read-only-delegate-worker-report-1", READ_ONLY_REPORT),
	});
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-delegate-read-only", BOT_DELEGATION_JUDGMENTS);
	const sent = await session.sendOperatorMessageToBot(READ_ONLY_DELEGATOR, READ_ONLY_QUESTION);
	await withDeadline(
		trace,
		"J7 bot delegate: the read-only bot answered on its worker's handoff",
		world.provider.whenReached(reached(TRACK.readOnlyDelegator, "j7-read-only-delegator-handoff")),
	);
	await waitForBotRosterState(world, session, READ_ONLY_DELEGATOR, "idle");
	const grantedTools = /tools: ([^;]*)/.exec(seen.startText)?.[1]?.split(", ") ?? [];
	expect(
		{
			sent: sent.mode,
			workerReads: seen.workerTools.includes("read"),
			workerWrites: seen.workerTools.some((name) => name === "write" || name === "edit"),
			grantReads: grantedTools.includes("read"),
			grantWrites: grantedTools.some((name) => name === "write" || name === "edit"),
		},
		"a read-only bot's worker reads and is offered no write or edit tool, as its start result's grant says",
	).toEqual({ sent: "started", workerReads: true, workerWrites: false, grantReads: true, grantWrites: false });
}

/**
 * Step 6b: a delegate worker of the owner's own session is never a bot. While it runs, the roster the owner sees, which
 * projects the session's own workers and lanes onto the bots bound to them, holds the bots it held before the start and
 * no entry for the worker; a message naming the worker is refused with the product's sentence, and the bot store holds no
 * record for it after the refusal. The owner's stop then ends the worker, and its end wakes no turn.
 */
async function runRootWorkerStep(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	const workerGate = createBarrier();
	const workerEnded = createBarrier();
	let workerEnd: string | undefined;
	const rosterIds = () => session.listPersistentBots().map((bot) => bot.agentId);
	const rosterBefore = rosterIds();
	world.provider.enqueueTrack(TRACK.rootDelegateWorker, MODEL_ID.delegateWorker, carriesMarker(ROOT_MARKER), {
		name: "j7-root-delegate-worker",
		// Held until the owner's stop cancels the worker: the cancel aborts the request.
		gate: workerGate.promise,
		onTerminal: (_request, message) => {
			workerEnd = message.stopReason;
			workerEnded.release();
		},
		reply: submitReport("j7-root-delegate-worker-report-1", "The pool queues four waiting requests."),
	});
	try {
		const started = await session.backgroundLanes.startWorkerDelegation({
			instructions: `${ROOT_MARKER} Read the pool settings and report how many requests wait for a connection.`,
			authority: { model: { provider: HARNESS_PROVIDER, modelId: MODEL_ID.delegateWorker }, readOnly: true },
		});
		if (!started.started) throw new Error(`the root's worker start was refused: ${started.skipReason}`);
		const workerId = started.record.agentId ?? started.record.laneId;
		await withDeadline(
			trace,
			"J7 bot delegate: the root's worker is working",
			world.provider.whenReached(reached(TRACK.rootDelegateWorker, "j7-root-delegate-worker")),
		);
		const roster = rosterIds();
		const refusal = await session.sendOperatorMessageToBot(workerId, ROOT_WORKER_MESSAGE).then(
			(result) => `sent: ${result.mode}`,
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		const stored = session.getBotTeamStore().getBot(workerId) !== undefined;
		const stop = session.backgroundLanes.cancelOwnFleet(OWNER_STOPPED_REASON);
		await withDeadline(trace, "J7 bot delegate: the root's stopped worker's request ended", workerEnded.promise);
		expect(
			{
				roster,
				rostered: roster.includes(workerId),
				refusal,
				stored,
				stopped: stop.stopped,
				workerEnd,
			},
			"a running delegate worker of the owner's session is not listed as a bot, a message naming it is refused with the product's sentence, no bot record is written for it, and the owner's stop ends it",
		).toEqual({
			roster: rosterBefore,
			rostered: false,
			refusal: notABot(workerId),
			stored: false,
			stopped: 1,
			workerEnd: "aborted",
		});
	} finally {
		workerGate.release();
	}
}

/**
 * Step 7: under the main session's worker bound, a bot's worker spends within it, and the bot's priced answer to that
 * worker's handoff takes the request past it: the bound counts the worker's spend with the bot's, stops the turn and tells
 * the owner in the bot's chat with the product's sentence, and the whole spend is charged to the main session.
 */
async function runWorkerBoundStep(world: HarnessWorld, session: AgentSession, rootFile: string): Promise<void> {
	const { trace } = world;
	createOwnerBot(session, BOUNDED_DELEGATOR, MODEL_ID.boundedDelegator, BOUNDED_SOUL);
	const workerGo = createBarrier();
	enqueueBot(
		world,
		TRACK.boundedDelegator,
		MODEL_ID.boundedDelegator,
		BOUNDED_SOUL,
		{
			name: "j7-bounded-delegator-start",
			reply: botStart(
				"j7-bounded-delegator-start-1",
				`${BOUNDED_MARKER} Read the pool settings and report how long the pool waits for a connection.`,
			),
		},
		{
			name: "j7-bounded-delegator-started",
			check: (request) => {
				startedAgentId(request);
				workerGo.release();
			},
			reply: { content: [{ type: "text", text: "A worker is reading the pool settings." }] },
		},
		handoffStep("j7-bounded-delegator-handoff", BOUNDED_REPORT, BOUNDED_ANSWER, BOUNDED_ANSWER_USAGE),
	);
	world.provider.enqueueTrack(TRACK.boundedDelegateWorker, MODEL_ID.delegateWorker, carriesMarker(BOUNDED_MARKER), {
		name: "j7-bounded-delegate-worker",
		gate: workerGo.promise,
		reply: { ...submitReport("j7-bounded-delegate-worker-report-1", BOUNDED_REPORT), usage: BOUNDED_WORKER_USAGE },
	});
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-delegate-bound", BOT_DELEGATION_JUDGMENTS);
	const sent = await session.sendOperatorMessageToBot(BOUNDED_DELEGATOR, BOUNDED_QUESTION);
	await withDeadline(
		trace,
		"J7 bot delegate: the bounded bot answered its worker's handoff",
		world.provider.whenReached(reached(TRACK.boundedDelegator, "j7-bounded-delegator-handoff")),
	);
	await withDeadline(
		trace,
		"J7 bot delegate: the bounded bot's chat holds the spend-bound stop",
		world.io.waitForMutation(() =>
			botNoticeTexts(world, BOUNDED_DELEGATOR).some((text) => text.includes(OVER_BOUND)),
		),
	);
	await waitForBotRosterState(world, session, BOUNDED_DELEGATOR, "idle");
	const [botSessionId] = botSessionIds(world, BOUNDED_DELEGATOR);
	if (botSessionId === undefined) throw new Error("the bounded bot opened no session file");
	// The bot's whole spend: its worker's, its priced answer's, and its own System One judgments' (none with System One off).
	const spent = () =>
		BOUNDED_WORKER_USAGE.cost.total +
		BOUNDED_ANSWER_USAGE.cost.total +
		botSemanticSpend(world, BOUNDED_DELEGATOR).usd;
	const charged = () =>
		botCharges(rootFile, botSessionId).reduce((total, report) => total + report.usage.cost.total, 0);
	await withDeadline(
		trace,
		"J7 bot delegate: the bounded request's spend reached the main session as the bot's charge",
		world.io.waitForMutation(
			() =>
				charged() >= spent() &&
				(!world.systemOne.enabled || botSemanticSpend(world, BOUNDED_DELEGATOR).receipts > 0),
		),
	);
	const judged = botSemanticSpend(world, BOUNDED_DELEGATOR);
	expect(
		{
			sent: sent.mode,
			stopped: botNoticeTexts(world, BOUNDED_DELEGATOR).some((text) => text.includes(OVER_BOUND)),
			botRequests: requestsOf(world, BOUNDED_SOUL),
			judgedBySystemOne: judged.receipts > 0,
			judgedAtScriptedUsage: judged.tokens.every((tokens) => tokens === SYSTEM_ONE_ANSWER_TOKENS),
			charged: charged(),
		},
		"a bot's request is held to the main session's worker bound with its worker's spend: the answer that passes it stops the turn with the product's sentence, the bot asks nothing more, and the whole spend, its System One judgments included, is charged once",
	).toEqual({
		sent: "started",
		stopped: true,
		botRequests: 3,
		judgedBySystemOne: world.systemOne.enabled,
		judgedAtScriptedUsage: true,
		charged: expect.closeTo(BOUNDED_WORKER_USAGE.cost.total + BOUNDED_ANSWER_USAGE.cost.total + judged.usd, 10),
	});
}
