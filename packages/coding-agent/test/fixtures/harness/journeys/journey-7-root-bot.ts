import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { BOT_TOOL_NAME } from "../../../../src/core/delegation/bot-creation.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { deliveredLines } from "./journey-5-shared.ts";
import {
	acceptedJson,
	agentsOn,
	allBots,
	botRecord,
	carries,
	enqueueBot,
	enqueueRoot,
	lastResult,
	loadBotToolStep,
	MODEL_ID,
	modelOf,
	offeredTools,
	onlyAgentOn,
	PHASE_JUDGMENTS,
	reached,
	TRACK,
} from "./journey-7-shared.ts";
import { fencedToolOutput } from "./shared.ts";

/** The purpose the root gives the bot; the harness names the bot from it, so the description decides the id. */
const DESCRIPTION = "Answers retry questions";
/** The id the harness derives from that purpose, and the name the screen shows for it. */
const BOT_ID = "answers-retry-questions";
const BOT_NAME = displayNameFor(BOT_ID);
const SOUL = "You answer questions about the retry limit with one short sentence.";
const ASKED = "How high is the retry limit?";
/** The bot's whole answer: a plain fact that names no test, check, commit or change, so it claims nothing System One reads. */
const ANSWER = "The retry limit is three.";
const HANDOFF_HEADER = "Background worker terminal handoff:";

/**
 * Leg 1: the root creates a bot and asks it. Creation records the bot and starts nothing; the ask starts it with its soul
 * and the question, and the answer comes back to the root as the event that starts the root's next turn.
 */
export async function runJourney7RootBotPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the root session disposes cleanly").toBeUndefined();
	}
	trace.mark("root", "j7.root-bot");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	// The bot answers only once the root has read the ask's own result, so the answer cannot land in the asking turn.
	const asked = createBarrier();
	const seen = {
		create: "" as string,
		created: {} as Record<string, unknown>,
		ask: {} as Record<string, unknown>,
		botRequest: {} as Record<string, unknown>,
		wakeLines: [] as string[],
		list: {} as Record<string, unknown>,
		// Read in the request that follows the create call, before anything asks the bot to work.
		afterCreate: { requests: -1, agents: -1 },
		// Read while the bot works: the lane its work is recorded under, which its handoff names.
		lanes: [] as Array<{ agentId?: string; laneId: string }>,
	};

	enqueueBot(world, TRACK.retry, MODEL_ID.retry, SOUL, {
		name: "j7-retry-answer",
		gate: asked.promise,
		check: (request) => {
			seen.botRequest = {
				soul: SOUL,
				carriesSoul: (request.context.systemPrompt ?? "").includes(SOUL),
				carriesQuestion: carries(request, ASKED),
				offersBotMessage: offeredTools(request).includes("bot_message"),
			};
			seen.lanes = session.backgroundLanes
				.getLaneRecords()
				.map((record) => ({ ...(record.agentId ? { agentId: record.agentId } : {}), laneId: record.laneId }));
		},
		reply: { content: [{ type: "text", text: ANSWER }] },
	});

	enqueueRoot(
		world,
		loadBotToolStep("j7-root-load"),
		{
			name: "j7-root-create",
			check: (request) => {
				if (!offeredTools(request).includes(BOT_TOOL_NAME))
					throw new Error(`the root is not offered ${BOT_TOOL_NAME}: ${offeredTools(request).join(", ")}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-root-create-1",
						name: BOT_TOOL_NAME,
						arguments: {
							action: "create",
							description: DESCRIPTION,
							soul: SOUL,
							model: modelOf(MODEL_ID.retry),
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-root-ask",
			check: (request) => {
				const result = lastResult(request, BOT_TOOL_NAME);
				if (result === undefined) throw new Error("the latest batch carries no bot create result");
				seen.create = fencedToolOutput(result.text);
				seen.created = acceptedJson(request, BOT_TOOL_NAME);
				seen.afterCreate = {
					requests: world.provider.requests.filter((entry) => entry.model.id === MODEL_ID.retry).length,
					agents: agentsOn(session, MODEL_ID.retry).length,
				};
			},
			reply: () => ({
				content: [
					{
						type: "toolCall",
						id: "j7-root-ask-1",
						name: BOT_TOOL_NAME,
						arguments: { action: "ask", agentId: BOT_ID, message: ASKED },
					},
				],
				stopReason: "toolUse",
			}),
		},
		{
			name: "j7-root-asked",
			check: (request) => {
				seen.ask = acceptedJson(request, BOT_TOOL_NAME);
				asked.release();
			},
			reply: { content: [{ type: "text", text: "The bot was asked." }] },
		},
		{
			name: "j7-root-answer",
			until: (request) => deliveredLines(request).includes(HANDOFF_HEADER),
			reply: (request) => {
				const lines = deliveredLines(request);
				if (!lines.includes(HANDOFF_HEADER)) return { content: [{ type: "text", text: "Nothing to read yet." }] };
				seen.wakeLines = lines;
				return {
					content: [
						{ type: "text", text: "The answer is in." },
						{
							type: "toolCall" as const,
							id: "j7-root-list-1",
							name: BOT_TOOL_NAME,
							arguments: { action: "list" },
						},
					],
					stopReason: "toolUse" as const,
				};
			},
		},
		{
			name: "j7-root-list",
			check: (request) => {
				seen.list = acceptedJson(request, BOT_TOOL_NAME);
			},
			reply: { content: [{ type: "text", text: "The listing is read." }] },
		},
	);
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-root-bot", PHASE_JUDGMENTS);

	await withDeadline(
		trace,
		"J7 leg 1: the root asks for a bot",
		session.prompt("Create a bot that answers retry questions and ask it how high the retry limit is."),
	);
	await withDeadline(
		trace,
		"J7 leg 1: the bot answered the root",
		world.provider.whenReached(reached(TRACK.root, "j7-root-list")),
	);
	await withDeadline(trace, "J7 leg 1: the root is idle", session.waitForForegroundIdle());

	// What creation answered, and what it recorded without starting anything.
	expect(
		{ text: JSON.parse(seen.create) as unknown, details: seen.created },
		"creation answers with the id the harness derived from the purpose, the bot's model, that it is read-only and that the root made it",
	).toEqual({
		text: { agentId: BOT_ID, modelRef: modelOf(MODEL_ID.retry), canWrite: false, createdBy: "root" },
		details: { agentId: BOT_ID, modelRef: modelOf(MODEL_ID.retry), canWrite: false, createdBy: "root" },
	});
	const record = botRecord(session, BOT_ID);
	expect(
		{
			agentId: record.agentId,
			displayName: record.displayName,
			namedFor: record.displayName === BOT_NAME,
			description: record.description,
			soul: record.soul,
			createdBy: record.createdBy,
			model: `${record.provider}/${record.modelId}`,
			leader: record.leader === true,
			canWrite: record.canWrite === true,
			retired: record.retired === true,
		},
		"creation records the bot as a read-only non-leader the root made, on the model the call named, and starts no worker",
	).toEqual({
		agentId: BOT_ID,
		displayName: BOT_NAME,
		namedFor: true,
		description: DESCRIPTION,
		soul: SOUL,
		createdBy: "root",
		model: modelOf(MODEL_ID.retry),
		leader: false,
		canWrite: false,
		retired: false,
	});
	expect(
		seen.afterCreate,
		"creation starts no worker: the request after the create call reached no model of the bot and started no agent for it",
	).toEqual({ requests: 0, agents: 0 });
	expect(seen.ask, "the ask answers at once that the message was sent to the bot").toEqual({
		sent: true,
		agentId: BOT_ID,
	});
	expect(seen.botRequest, "the bot's first request opens on its soul and carries the question it was asked").toEqual({
		soul: SOUL,
		carriesSoul: true,
		carriesQuestion: true,
		offersBotMessage: true,
	});

	// The answer reaches the root as the event that starts its next turn, which names the bot's lane and quotes its words.
	const botLane = seen.lanes.find((lane) => lane.agentId !== undefined);
	expect(botLane, "the bot's worker is recorded under a lane of its own while it works").toBeDefined();
	const agentId = onlyAgentOn(session, MODEL_ID.retry).agentId;
	const laneLines = seen.wakeLines.filter((line) => line.startsWith("- "));
	expect(
		{
			header: seen.wakeLines[0],
			lanes: laneLines,
			namesTheBot: seen.wakeLines.includes(`  Bot: ${BOT_ID} (${BOT_NAME})`),
			tellsTheAnswer: seen.wakeLines.includes("  Claim Summary (untrusted worker evidence):")
				? seen.wakeLines.some((line) => line.includes(ANSWER))
				: false,
			laneIsTheBots: botLane?.agentId === agentId,
		},
		"the answer starts a root turn of its own: one handoff header, one lane line naming the bot's lane and the bot it is, and the bot's words as the claim summary",
	).toEqual({
		header: HANDOFF_HEADER,
		lanes: [`- ${botLane?.laneId}: succeeded reason=worker_completed_plain_text`],
		namesTheBot: true,
		tellsTheAnswer: true,
		laneIsTheBots: true,
	});
	expect(
		seen.list,
		"bot list answers with the one bot the root made: its id, the name its record shows, its model, leadership and creator",
	).toEqual({
		bots: [
			{
				agentId: BOT_ID,
				displayName: BOT_NAME,
				modelRef: modelOf(MODEL_ID.retry),
				leader: false,
				retired: false,
				createdBy: "root",
			},
		],
	});
	expect(
		allBots(session).map((bot) => bot.agentId),
		"the store holds the one bot this leg made",
	).toEqual([BOT_ID]);
}
