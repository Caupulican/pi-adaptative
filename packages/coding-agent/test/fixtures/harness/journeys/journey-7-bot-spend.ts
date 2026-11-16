import "../builtin-install.ts";
import { isDeepStrictEqual } from "node:util";
import { createEmptyUsage, type Usage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { BOT_CHARGE_MARK_CUSTOM_TYPE } from "../../../../src/core/bots/bot-charge-mark.ts";
import { aggregateDailyUsageAsync } from "../../../../src/core/cost/daily-usage.ts";
import { BOT_SESSION_USAGE_LABEL } from "../../../../src/core/cost/usage-records.ts";
import { rollingDayWindow } from "../../../../src/core/proactivity/proactivity-controller.ts";
import { usageScope } from "../../../../src/core/session-analytics.ts";
import { spawnedUsageReportIdPrefix } from "../../../../src/core/spawned-usage.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { HARNESS_PROVIDER, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	botCharges,
	botNoticeTexts,
	botRecord,
	botRosterState,
	botSessionFilesText,
	botSessionIds,
	carries,
	createChargedRoot,
	createOwnerBot,
	enqueueBot,
	fileLines,
	MODEL_ID,
	reached,
	TRACK,
	waitForBotRosterState,
} from "./journey-7-shared.ts";

const SPENDER = "spender";
const SOUL = "You answer owner questions about the connection pool with one short sentence.";
/** Every question asks what something is, and every answer states a fact that names no test, check, commit or change. */
const FIRST_QUESTION = "How many connections does the pool hold?";
const FIRST_ANSWER = "The pool holds eight connections.";
const SECOND_QUESTION = "How long does an idle connection stay open?";
const SECOND_ANSWER = "An idle connection stays open for thirty seconds.";
const THIRD_QUESTION = "Which connection is closed first?";
const THIRD_ANSWER = "The oldest idle connection is closed first.";
const FOURTH_QUESTION = "How does the pool pick a connection?";
const FOURTH_ANSWER = "The pool picks the most recently returned connection.";

/** A priced reply's usage: its dollars split between input and output, each a binary-exact fraction so sums stay exact. */
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

const FIRST_USAGE = priced(1000, 100, 0.25);
const SECOND_USAGE = priced(2000, 200, 0.5);
const OVER_USAGE = priced(6000, 600, 1.5);
/** The root's worker bound: a bot's request is held to it, and only the fourth reply passes it. */
const CEILING_USD = 1;
/** The stop the product tells the owner in the bot's chat (text-en/bot-team.ts `botTurnOverBudget`), whole. */
const OVER_BOUND = `Bot ${SPENDER}: its turn was stopped at the spend bound ($${OVER_USAGE.cost.total.toFixed(2)} spent on metered models on this request, its workers included; workerDelegation.maxUsd on metered spend is $${CEILING_USD.toFixed(2)}).`;

/** The `through` of every charge mark in the bot's own transcript, oldest first. */
function chargeMarks(world: HarnessWorld): unknown[] {
	return fileLines(botSessionFilesText(world, SPENDER))
		.filter((line) => line.type === "custom" && line.customType === BOT_CHARGE_MARK_CUSTOM_TYPE)
		.map((line) => (line.data as { through?: unknown } | undefined)?.through);
}

/** What the root's daily brake reads over the rolling day: the spawned spend of every session file of the root's scope. */
async function dailySpawnedUsd(manager: SessionManager): Promise<number> {
	const filePath = manager.getSessionFile();
	if (filePath === undefined) throw new Error("the bot-spend root has no session file");
	const totals = await aggregateDailyUsageAsync(
		usageScope(manager),
		manager.usesDefaultSessionDir(),
		rollingDayWindow(Date.now()),
		{ filePath, entries: manager.getEntries() },
	);
	return totals.spawnedCost;
}

function spenderRequests(world: HarnessWorld): number {
	return world.provider.requests.filter((request: ScriptedRequest) =>
		(request.context.systemPrompt ?? "").includes(SOUL),
	).length;
}

/**
 * Leg: an owner's bot answers with priced usage, and its spend reaches the main session as charged ranges. Each answer
 * lands one bot-session charge in the main session's file, each range starting where the last ended, and the main
 * session's cost view and the daily brake's reader count each dollar once. Every message after the first reaches a
 * session closed (retired) and reopened from the same file, so each owner message opens a session with no owner words
 * left to settle and no System One question is asked in either mode; a reopened session whose turn spends nothing
 * charges nothing again, and the bot's transcript marks how far the main session holds its charges. A reply that passes
 * the main session's worker bound stops the bot's turn with the product's sentence.
 */
export async function runJourney7BotSpendPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session, manager } = await createChargedRoot(world, "bot-spend", {
		workerDelegation: { maxUsd: CEILING_USD },
	});
	try {
		await runLeg(world, session, manager);
	} finally {
		expect(await world.disposeSessionInBody(session), "the root session disposes cleanly").toBeUndefined();
	}
	trace.mark("root", "j7.bot-spend");
}

async function runLeg(world: HarnessWorld, session: AgentSession, manager: SessionManager): Promise<void> {
	const trace = world.trace;
	const rootFile = manager.getSessionFile();
	if (rootFile === undefined) throw new Error("the bot-spend root has no session file");
	createOwnerBot(session, SPENDER, MODEL_ID.spender, SOUL);
	const seen = { reopened: { secondQuestion: false, secondAnswer: false, third: false } };
	enqueueBot(
		world,
		TRACK.spender,
		MODEL_ID.spender,
		SOUL,
		{ name: "j7-spender-first", reply: { content: [{ type: "text", text: FIRST_ANSWER }], usage: FIRST_USAGE } },
		{ name: "j7-spender-second", reply: { content: [{ type: "text", text: SECOND_ANSWER }], usage: SECOND_USAGE } },
		{
			name: "j7-spender-reopened",
			check: (request) => {
				seen.reopened = {
					secondQuestion: carries(request, SECOND_QUESTION),
					secondAnswer: carries(request, SECOND_ANSWER),
					third: carries(request, THIRD_QUESTION),
				};
			},
			// A reply that spends nothing: the reopened session's cumulative usage stays where the last charge ended.
			reply: { content: [{ type: "text", text: THIRD_ANSWER }], usage: createEmptyUsage() },
		},
		{ name: "j7-spender-over", reply: { content: [{ type: "text", text: FOURTH_ANSWER }], usage: OVER_USAGE } },
	);
	// Each owner message opens the bot's session, so its turn, which calls no tool, leaves its words unjudged and nothing
	// settles them: no System One question is asked in this leg (as for the owner-messages leg's first message).
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-spend", {});
	const baselineDailyUsd = await dailySpawnedUsd(manager);
	const recordsReach = (count: number, label: string) =>
		withDeadline(
			trace,
			label,
			world.io.waitForMutation(() => botCharges(rootFile, botSessionId()).length >= count),
		);
	let botSessionIdValue: string | undefined;
	const botSessionId = (): string => {
		if (botSessionIdValue === undefined)
			throw new Error("the spender's session id was read before its session existed");
		return botSessionIdValue;
	};
	const retire = async (label: string, through: Usage) => {
		const retired = session.retirePersistentBot(SPENDER);
		expect(
			{
				retired,
				recordRetired: botRecord(session, SPENDER).retired === true,
				roster: botRosterState(session, SPENDER),
			},
			`${label}: retiring the idle bot marks its record retired and closes its session`,
		).toEqual({
			retired: { retired: true, detail: `Bot ${SPENDER} retired.` },
			recordRetired: true,
			roster: "retired",
		});
		// The session's close marks in its transcript how far the main session's file holds its charges.
		await withDeadline(
			trace,
			`${label}: the closed session marked its charges`,
			world.io.waitForMutation(() => isDeepStrictEqual(chargeMarks(world).at(-1), through)),
		);
	};
	const ask = async (question: string, step: string, label: string) => {
		const sent = await session.sendOperatorMessageToBot(SPENDER, question);
		await withDeadline(trace, label, world.provider.whenReached(reached(TRACK.spender, step)));
		await waitForBotRosterState(world, session, SPENDER, "idle");
		return sent.mode;
	};
	const reportPrefix = () => `${spawnedUsageReportIdPrefix(BOT_SESSION_USAGE_LABEL)}${botSessionId()}:`;

	// Step 1: the first answer's spend lands one charge in the main session's file, from zero through what it spent.
	const firstMode = await ask(FIRST_QUESTION, "j7-spender-first", "J7 bot spend: the bot answered the first question");
	const idsAfterFirst = botSessionIds(world, SPENDER);
	expect(idsAfterFirst, "the bot's first message opened one session file").toHaveLength(1);
	botSessionIdValue = idsAfterFirst[0];
	await recordsReach(1, "J7 bot spend: the first charge reached the main session's file");
	const [first] = botCharges(rootFile, botSessionId());
	if (first === undefined) throw new Error("the first bot charge is missing");
	expect(
		{
			mode: firstMode,
			records: botCharges(rootFile, botSessionId()).length,
			label: first.label,
			reportIdNamespaced: first.reportId?.startsWith(reportPrefix()) === true,
			model: `${first.provider}/${first.model}`,
			fromCost: first.from?.cost.total,
			fromTokens: first.from?.totalTokens,
			throughCost: first.through?.cost.total,
			usageCost: first.usage.cost.total,
			recordedAt: typeof first.recordedAt,
			costView: session.getCostSummary().subagentCost,
			daily: (await dailySpawnedUsd(manager)) - baselineDailyUsd,
		},
		"the first answer lands one bot-session charge of the bot's session, ranged from zero through its spend, counted once by the cost view and the daily reader",
	).toEqual({
		mode: "started",
		records: 1,
		label: BOT_SESSION_USAGE_LABEL,
		reportIdNamespaced: true,
		model: `${HARNESS_PROVIDER}/${MODEL_ID.spender}`,
		fromCost: 0,
		fromTokens: 0,
		throughCost: FIRST_USAGE.cost.total,
		usageCost: FIRST_USAGE.cost.total,
		recordedAt: "string",
		costView: expect.closeTo(FIRST_USAGE.cost.total, 10),
		daily: expect.closeTo(FIRST_USAGE.cost.total, 10),
	});
	if (first.through === undefined) throw new Error("the first bot charge carries no range end");
	await retire("J7 bot spend: after the first answer", first.through);

	// Step 2: the second answer, in the session reopened from the same file, is charged from where the first ended.
	const secondMode = await ask(
		SECOND_QUESTION,
		"j7-spender-second",
		"J7 bot spend: the reopened bot answered the second question",
	);
	await recordsReach(2, "J7 bot spend: the second charge reached the main session's file");
	const afterSecond = botCharges(rootFile, botSessionId());
	const second = afterSecond[1];
	if (second?.through === undefined) throw new Error("the second bot charge carries no range end");
	const totalAfterSecond = FIRST_USAGE.cost.total + SECOND_USAGE.cost.total;
	expect(
		{
			mode: secondMode,
			records: afterSecond.length,
			firstKept: afterSecond[0]?.reportId === first.reportId,
			continues: isDeepStrictEqual(second.from, first.through),
			reportIdNamespaced: second.reportId?.startsWith(reportPrefix()) === true,
			throughCost: second.through.cost.total,
			usageCost: second.usage.cost.total,
			sessionIds: botSessionIds(world, SPENDER),
			costView: session.getCostSummary().subagentCost,
			daily: (await dailySpawnedUsd(manager)) - baselineDailyUsd,
		},
		"the second answer is charged from the first charge's end through its own spend, and the union counts each dollar once",
	).toEqual({
		mode: "followed_up",
		records: 2,
		firstKept: true,
		continues: true,
		reportIdNamespaced: true,
		throughCost: totalAfterSecond,
		usageCost: SECOND_USAGE.cost.total,
		sessionIds: [botSessionId()],
		costView: expect.closeTo(totalAfterSecond, 10),
		daily: expect.closeTo(totalAfterSecond, 10),
	});
	await retire("J7 bot spend: after the second answer", second.through);

	// Step 3: a reopened session whose turn spends nothing charges no range again.
	const dailyBeforeReopen = await dailySpawnedUsd(manager);
	const thirdMode = await ask(
		THIRD_QUESTION,
		"j7-spender-reopened",
		"J7 bot spend: the reopened bot answered at no cost",
	);
	const afterReopen = botCharges(rootFile, botSessionId());
	expect(
		{
			mode: thirdMode,
			carried: seen.reopened,
			reportIds: afterReopen.map((report) => report.reportId),
			sessionIds: botSessionIds(world, SPENDER),
			costView: session.getCostSummary().subagentCost,
			daily: await dailySpawnedUsd(manager),
			lastMark: chargeMarks(world).at(-1),
		},
		"the reopened session continues the conversation, charges no range again and keeps the mark of the last charge in its transcript",
	).toEqual({
		mode: "followed_up",
		carried: { secondQuestion: true, secondAnswer: true, third: true },
		reportIds: [first.reportId, second.reportId],
		sessionIds: [botSessionId()],
		costView: expect.closeTo(totalAfterSecond, 10),
		daily: dailyBeforeReopen,
		lastMark: second.through,
	});
	await retire("J7 bot spend: after the reopened answer", second.through);

	// Step 4: a reply past the main session's worker bound stops the bot's turn, and its spend is still charged once.
	const overMode = await ask(FOURTH_QUESTION, "j7-spender-over", "J7 bot spend: the bot's over-bound reply was sent");
	await withDeadline(
		trace,
		"J7 bot spend: the bot's chat holds the spend-bound stop",
		world.io.waitForMutation(() => botNoticeTexts(world, SPENDER).some((text) => text.includes(OVER_BOUND))),
	);
	await recordsReach(3, "J7 bot spend: the over-bound charge reached the main session's file");
	const afterOver = botCharges(rootFile, botSessionId());
	const third = afterOver[2];
	if (third === undefined) throw new Error("the over-bound bot charge is missing");
	const totalAfterOver = totalAfterSecond + OVER_USAGE.cost.total;
	expect(
		botNoticeTexts(world, SPENDER).join("\n"),
		"the bot's chat tells the owner the turn was stopped at the worker bound",
	).toContain(OVER_BOUND);
	expect(
		{
			mode: overMode,
			records: afterOver.length,
			earlierKept: afterOver.slice(0, 2).map((report) => report.reportId),
			continues: isDeepStrictEqual(third.from, second.through),
			usageCost: third.usage.cost.total,
			throughCost: third.through?.cost.total,
			costView: session.getCostSummary().subagentCost,
			daily: (await dailySpawnedUsd(manager)) - baselineDailyUsd,
			requests: spenderRequests(world),
		},
		"the stopped turn's spend is charged once from the last charge's end, and its one request is the bot's last",
	).toEqual({
		mode: "followed_up",
		records: 3,
		earlierKept: [first.reportId, second.reportId],
		continues: true,
		usageCost: OVER_USAGE.cost.total,
		throughCost: totalAfterOver,
		costView: expect.closeTo(totalAfterOver, 10),
		daily: expect.closeTo(totalAfterOver, 10),
		requests: 4,
	});
}
