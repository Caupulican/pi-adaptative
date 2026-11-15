import "../builtin-install.ts";
import { createEmptyUsage, type Usage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { botOrchestrationHome } from "../../../../src/core/bots/bot-home.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
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
} from "./journey-7-shared.ts";
import { carriesMarker, newestText, settle, startCall, submitReport } from "./journey-8-shared.ts";

const DELEGATOR = "pool-director";
const DELEGATOR_SOUL =
	"You direct workers that read the connection pool settings and answer the owner in one sentence.";
const READ_ONLY_DELEGATOR = "pool-reader";
const READ_ONLY_SOUL = "You direct read-only workers over the connection pool settings and answer in one sentence.";

/** Every question asks what something is, and every answer states a fact that names no test, check, commit or change. */
const FIRST_QUESTION = "How many connections does the pool hold? Have a worker read the settings.";
const SECOND_QUESTION = "How many idle connections does the pool keep? Have another worker count them.";
const READ_ONLY_QUESTION = "Which connection is closed first? Have a worker read the settings.";
const FIRST_MARKER = "[j7-delegate-first]";
const HELD_MARKER = "[j7-delegate-held]";
const READ_ONLY_MARKER = "[j7-delegate-read-only]";
const FIRST_REPORT = "The pool holds eight connections.";
const FIRST_ANSWER = "The worker read that the pool holds eight connections.";
const READ_ONLY_REPORT = "The oldest idle connection is closed first.";
const READ_ONLY_ANSWER = "The worker read that the oldest idle connection is closed first.";
/** What the product tells the owner of a stop that ended the bot's work (text-en/bot-team.ts `botStopped`), whole. */
const STOPPED = `Stopped ${DELEGATOR} (halt).`;
const HANDOFF = "Background worker terminal handoff:";

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
function handoffStep(name: string, report: string, answer: string): ScriptStep {
	return {
		name,
		check: (request) => {
			const input = newestText(request);
			if (!input.includes(HANDOFF) || !input.includes(report))
				throw new Error(`${name}: the turn's input is not the worker's handoff: ${input}`);
		},
		reply: { content: [{ type: "text", text: answer }] },
	};
}

/** The requests a bot's own session made: its soul opens the system prompt of each. */
function requestsOf(world: HarnessWorld, soul: string): number {
	return world.provider.requests.filter((request) => (request.context.systemPrompt ?? "").includes(soul)).length;
}

/**
 * Leg: a bot directs workers of its own. The owner asks a writing bot a question; in its own session the bot holds
 * `delegate`, `assign` and `task_watch` and no `plan`, starts a worker, and the worker's terminal handoff opens the
 * bot's next turn, in which it answers. The worker's conversation lies in the bot's home, under the bot's session, and
 * nothing of that session is in the owner's orchestration home; the worker's spend reaches the main session as the bot
 * session's charge. The owner's stop of the bot while a second worker runs cancels that worker, and its end opens no turn
 * of the bot. A read-only bot's worker is planned read-only: the bot changes no file, so neither does its worker.
 */
export async function runJourney7BotDelegatePhase(world: HarnessWorld): Promise<void> {
	const { session, rootFile } = await createChargedRoot(world, "bot-delegate");
	try {
		await runLeg(world, session, rootFile);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
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
			reply: { content: [{ type: "text", text: "Another worker is counting the idle connections." }] },
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
		await withDeadline(
			trace,
			"J7 bot delegate: the worker's spend reached the main session as the bot's charge",
			world.io.waitForMutation(() => charged() >= WORKER_USAGE.cost.total),
		);
		expect(
			{
				sent: sent.mode,
				otherSessions: otherSessions.length,
				holdsDelegate: seen.offered.includes("delegate"),
				holdsAssign: seen.offered.includes("assign"),
				holdsTaskWatch: seen.offered.includes("task_watch"),
				holdsPlan: seen.offered.includes("plan"),
				holdsBot: seen.offered.includes("bot"),
				workerTranscriptInBotHome: world.io.existsSync(location.sessionFile),
				botSessionInOwnerHome: world.io.existsSync(
					orchestrationSessionDir(ownerOrchestrationHome(world.agentDir), botSessionId),
				),
				charged: charged(),
			},
			"a bot's own session holds the director tools and no plan, starts a worker whose conversation lies in the bot's home, answers on the worker's handoff, and the worker's spend is charged to the main session as the bot's",
		).toEqual({
			sent: "started",
			otherSessions: 0,
			holdsDelegate: true,
			holdsAssign: true,
			holdsTaskWatch: true,
			holdsPlan: false,
			holdsBot: false,
			workerTranscriptInBotHome: true,
			botSessionInOwnerHome: false,
			charged: expect.closeTo(WORKER_USAGE.cost.total, 10),
		});

		// Step 5: the owner's stop while a second worker runs cancels it, and its end opens no turn of the bot.
		if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-delegate-stop", BOT_DELEGATION_JUDGMENTS);
		const secondSent = await session.sendOperatorMessageToBot(DELEGATOR, SECOND_QUESTION);
		await withDeadline(
			trace,
			"J7 bot delegate: the second worker is working",
			world.provider.whenReached(reached(TRACK.heldDelegateWorker, "j7-held-delegate-worker")),
		);
		await withDeadline(
			trace,
			"J7 bot delegate: the bot told the owner of its second worker",
			world.provider.whenReached(reached(TRACK.delegator, "j7-delegator-second-started")),
		);
		const stopped = session.stopPersistentBot(DELEGATOR);
		const requestsAtStop = requestsOf(world, DELEGATOR_SOUL);
		await withDeadline(trace, "J7 bot delegate: the stopped worker's request ended", heldWorkerEnded.promise);
		await waitForBotRosterState(world, session, DELEGATOR, "idle");
		for (let step = 0; step < 8; step++) await settle();
		expect(
			{
				sent: secondSent.mode,
				stopped,
				heldEnd: seen.heldEnd,
				botRequests: requestsOf(world, DELEGATOR_SOUL) - requestsAtStop,
			},
			"the owner's stop of a bot whose worker runs cancels that worker, says it stopped the bot, and the cancelled worker's end opens no turn of the bot",
		).toEqual({
			sent: "followed_up",
			stopped: { stopped: true, detail: STOPPED },
			heldEnd: "aborted",
			botRequests: 0,
		});
	} finally {
		heldWorkerGate.release();
	}

	await runReadOnlyStep(world, session);
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
			grantWrites: grantedTools.some((name) => name === "write" || name === "edit"),
		},
		"a read-only bot's worker reads and is offered no write or edit tool, as its start result's grant says",
	).toEqual({ sent: "started", workerReads: true, workerWrites: false, grantWrites: false });
}
