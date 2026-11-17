import "../builtin-install.ts";
import { expect, vi } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { LeaderDelegationLedger } from "../../../../src/core/delegation/leader-delegation-ledger.ts";
import { createBarrier, HARNESS_PROVIDER } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { deliveredLines } from "./journey-5-shared.ts";
import {
	acceptedJson,
	botRecord,
	carries,
	delegationsOf,
	enqueueBot,
	enqueueRoot,
	GOAL_LEADER_OPENING,
	loadBotToolStep,
	MODEL_ID,
	offeredActions,
	PHASE_JUDGMENTS,
	reached,
	refusalOf,
	TRACK,
} from "./journey-7-shared.ts";

const LEADER = "chief";
const LEADER_SOUL = "You lead a goal for the orchestrator, split it into parts, and report once at the end.";
const LEADER_FRAGMENT = "split it into parts, and report once at the end";
const GOAL = "Report how many days a week holds.";
const PART_GOAL = "Count the days in one week.";
const TOP_REPORT = "The part is in: seven.";
const PART_REPORT = "The count is seven.";
/** What a leader handing a part on without naming a standing leader is told: the exact sentence. */
const NAME_A_LEADER =
	"A leader hands a part on only to a standing leader: name one with agentId (bot_message list marks them). Only the orchestrator appoints a goal leader or creates a bot; for a leader you do not have, ask it with ask_root.";

/**
 * Leg 5, second half: with `leaders.maxDepth` raised to two, a leader's goal may hand a part to a standing leader. The root
 * appoints a goal leader for its goal; that leader's hand-on without naming a standing leader is refused and opens nothing,
 * since only the orchestrator appoints; named, the standing leader takes the part. The second objective names the first as
 * its parent, the part's leader reports to the leader that handed it on, and the first closes only after the second.
 */
export async function runJourney7DepthPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession(MODEL_ID.root, {
		sessionManager: world.createSessionManager(),
		settings: { leaders: { maxDepth: 2 } },
	});
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the deeper session disposes cleanly").toBeUndefined();
	}
	trace.mark("root", "j7.depth");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	// The same standing leader the owner made: the setting, not the leader, decides how deep a goal may nest.
	session.upsertPersistentBot({
		agentId: LEADER,
		displayName: displayNameFor(LEADER),
		provider: HARNESS_PROVIDER,
		modelId: MODEL_ID.leader,
		soul: LEADER_SOUL,
		createdBy: "owner",
	});
	session.upsertPersistentBot({ agentId: LEADER, leader: true });

	const seen = {
		leadResult: {} as Record<string, unknown>,
		briefOffersDelegation: false,
		actionNames: [] as string[],
		refusal: {} as Record<string, unknown>,
		goalsAtRefusal: 0,
		partResult: {} as Record<string, unknown>,
		partHeardPartGoal: false,
		handedOnLine: false,
		wakeLines: [] as string[],
	};

	// A goal leader appointed by the root runs on the session's model, so it is told apart by the soul it was created with.
	enqueueBot(
		world,
		TRACK.goalLeader,
		MODEL_ID.goalLeader,
		GOAL_LEADER_OPENING,
		{
			name: "j7-depth-brief",
			check: (request) => {
				const brief = request.context.messages.map((message) => JSON.stringify(message)).join("\n");
				seen.actionNames = offeredActions(request, "bot_message");
				seen.briefOffersDelegation = brief.includes(
					"You may hand a part of the goal to a leader of your own with bot_message action lead",
				);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-depth-lead-unnamed-1",
						name: "bot_message",
						arguments: { action: "lead", goal: PART_GOAL },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-depth-refused",
			check: (request) => {
				seen.refusal = refusalOf(request, "bot_message");
				seen.goalsAtRefusal = delegationsOf(session).length;
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-depth-lead-1",
						name: "bot_message",
						arguments: { action: "lead", goal: PART_GOAL, agentId: LEADER },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-depth-part-result",
			check: (request) => {
				seen.partResult = acceptedJson(request, "bot_message");
			},
			reply: { content: [{ type: "text", text: "Waiting." }] },
		},
		{
			name: "j7-depth-report",
			maxRequests: 8,
			until: (request) => carries(request, "you handed on"),
			reply: (request) => {
				if (!carries(request, "you handed on")) return { content: [{ type: "text", text: "Waiting." }] };
				seen.handedOnLine = true;
				return { content: [{ type: "text", text: TOP_REPORT }] };
			},
		},
	);
	enqueueBot(world, TRACK.leaderDepth, MODEL_ID.leader, LEADER_FRAGMENT, {
		name: "j7-part-brief",
		check: (request) => {
			seen.partHeardPartGoal = carries(request, PART_GOAL);
		},
		reply: { content: [{ type: "text", text: PART_REPORT }] },
	});
	enqueueRoot(
		world,
		loadBotToolStep("j7-depth-load"),
		{
			name: "j7-depth-call",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-depth-call-1",
						name: "bot",
						arguments: { action: "lead", goal: GOAL },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-depth-lead-result",
			check: (request) => {
				seen.leadResult = acceptedJson(request, "bot");
			},
			reply: { content: [{ type: "text", text: "The goal is running." }] },
		},
		{
			name: "j7-depth-outcome",
			maxRequests: 8,
			until: (request) => deliveredLines(request).some((line) => line.startsWith("Leader ")),
			reply: (request) => {
				const lines = deliveredLines(request);
				if (!lines.some((line) => line.startsWith("Leader "))) {
					return { content: [{ type: "text", text: "Nothing to read yet." }] };
				}
				seen.wakeLines = lines;
				return { content: [{ type: "text", text: "Noted." }] };
			},
		},
	);
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-depth", PHASE_JUDGMENTS);

	await runRecovery(world, session, () => seen.leadResult.leader);
	await withDeadline(trace, "J7 leg 5: the root is idle", session.waitForForegroundIdle());

	expect(
		{ refusal: seen.refusal, goals: seen.goalsAtRefusal },
		"a leader handing a part on without naming a standing leader is refused in one sentence, and no goal is opened for it",
	).toEqual({ refusal: { tool: "bot_message", sentence: NAME_A_LEADER }, goals: 1 });

	const rootEnvelope = seen.leadResult.envelope as Record<string, unknown> | undefined;
	const partEnvelope = seen.partResult.envelope as Record<string, unknown> | undefined;
	expect(
		{
			rootGoalLeader: seen.leadResult.goalLeader,
			rootDepth: rootEnvelope?.remainingDepth,
			rootCapabilities: rootEnvelope?.capabilities,
			// The goal leader's own goal may hand a part on, and its tool says so.
			briefOffersDelegation: seen.briefOffersDelegation,
			offersLeadAction: seen.actionNames.includes("lead"),
			partDelegated: seen.partResult.delegated,
			partLeader: seen.partResult.leader,
			partGoalLeader: seen.partResult.goalLeader,
			partDepth: partEnvelope?.remainingDepth,
			partCapabilities: partEnvelope?.capabilities,
			partHeardPartGoal: seen.partHeardPartGoal,
		},
		"at depth two the root's goal leader may hand a part on to the standing leader it names, read-only, and that leader reads the part's goal",
	).toEqual({
		rootGoalLeader: true,
		rootDepth: 1,
		rootCapabilities: ["read", "create_bots", "delegate"],
		briefOffersDelegation: true,
		offersLeadAction: true,
		partDelegated: true,
		partLeader: LEADER,
		partGoalLeader: false,
		partDepth: 0,
		partCapabilities: ["read", "create_bots"],
		partHeardPartGoal: true,
	});

	const records = delegationsOf(session);
	const part = records.find((record) => record.charter.leader === LEADER);
	if (part === undefined) throw new Error(`no delegation was led by ${LEADER}`);
	const first = records.find((record) => record.objectiveId === part.charter.parentObjectiveId);
	if (first === undefined) throw new Error("the part names no delegation as its parent");
	const outcomeLine = seen.wakeLines.find((line) => line.startsWith("Leader "));
	expect(
		{
			firstIsRoot: first.charter.parentObjectiveId === undefined,
			firstAppointedBy: first.charter.appointedBy,
			partAppointedBy: part.charter.appointedBy,
			chain: part.charter.envelope.chain.map((hop) => hop.objectiveId),
			partSettled: [part.state, part.closeReason],
			firstSettled: [first.state, first.closeReason],
			// The first closes only after the goal it handed on: its own Outcome carries the part's.
			firstClosedAfterPart:
				first.closedAt !== undefined && part.closedAt !== undefined && first.closedAt >= part.closedAt,
			handedOnLine: seen.handedOnLine,
			// A goal leader is named by its goal's first line, so its name may hold spaces.
			toldOnce: seen.wakeLines.filter((line) => /^Leader .+ finished the goal "/.test(line)).length,
			goalInOutcome: outcomeLine?.includes(`the goal "${GOAL}"`),
			reportsTop: seen.wakeLines.join("\n").includes(TOP_REPORT),
		},
		"the second objective names the first as its parent and closes first, and the root is told once, of the first, with its leader's report",
	).toEqual({
		firstIsRoot: true,
		firstAppointedBy: "root",
		partAppointedBy: "owner",
		chain: [first.objectiveId, part.objectiveId],
		partSettled: ["closed", "settled"],
		firstSettled: ["closed", "settled"],
		firstClosedAfterPart: true,
		handedOnLine: true,
		toldOnce: 1,
		goalInOutcome: true,
		reportsTop: true,
	});
}

async function runRecovery(world: HarnessWorld, session: AgentSession, goalLeader: () => unknown): Promise<void> {
	const lanes = session.backgroundLanes;
	const reconcileMessages = lanes.reconcileDelegatedMessages.bind(lanes);
	const retireBot = lanes.retirePersistentBot.bind(lanes);
	const recordReceipt = LeaderDelegationLedger.prototype.recordChildOutcomeDelivered;
	let failedReconcile = false;
	let failedReceipt = false;
	let retirementAttempts = 0;
	const retired = createBarrier();
	const reconcile = vi.spyOn(lanes, "reconcileDelegatedMessages").mockImplementation((objectiveId) => {
		if (
			!failedReconcile &&
			delegationsOf(session).some(
				(record) =>
					record.objectiveId === objectiveId && record.charter.leader === LEADER && record.state === "closed",
			)
		) {
			failedReconcile = true;
			throw new Error("Injected failure while reconciling the closed child.");
		}
		reconcileMessages(objectiveId);
	});
	const record = vi
		.spyOn(LeaderDelegationLedger.prototype, "recordChildOutcomeDelivered")
		.mockImplementation(function (this: LeaderDelegationLedger, objectiveId) {
			if (!failedReceipt) {
				failedReceipt = true;
				throw new Error("Injected failure before persisting the nested outcome receipt.");
			}
			return recordReceipt.call(this, objectiveId);
		});
	const send = vi.spyOn(lanes, "sendOperatorMessageToBot");
	const retire = vi.spyOn(lanes, "retirePersistentBot").mockImplementation((alias) => {
		if (alias === goalLeader() && ++retirementAttempts === 1)
			return { retired: false, detail: "Injected first retirement failure." };
		const result = retireBot(alias);
		if (alias === goalLeader() && result.retired) retired.release();
		return result;
	});
	const retry = async (label: string, check: () => void) => {
		const delay = await withDeadline(world.trace, label, world.timers.whenArmed("leaders"));
		check();
		expect(delay).toBeGreaterThan(0);
		expect(world.timers.advance("leaders", delay)).toBe(1);
	};
	try {
		await withDeadline(world.trace, "J7 leg 5: the root appoints a goal leader", session.prompt(GOAL));
		await retry("J7 leg 5: the failed reconcile pass armed a retry", () => {
			expect(failedReconcile).toBe(true);
			expect(failedReceipt).toBe(false);
		});
		await retry("J7 leg 5: the failed nested receipt armed a retry", () => {
			expect(failedReceipt).toBe(true);
			expect(delegationsOf(session).find((entry) => entry.charter.leader === LEADER)?.outcomeDeliveredToParent).toBe(
				false,
			);
		});
		await withDeadline(
			world.trace,
			"J7 leg 5: the goal's outcome reached the root",
			world.provider.whenReached(reached(TRACK.root, "j7-depth-outcome")),
		);
		const alias = goalLeader();
		if (typeof alias !== "string") throw new Error("The goal leader was not recorded.");
		const child = delegationsOf(session).find((entry) => entry.charter.leader === LEADER);
		expect(child?.outcomeDeliveredToParent).toBe(true);
		expect(
			send.mock.calls.filter(([, , options]) => options?.idempotencyKey === `leader-outcome:${child?.objectiveId}`),
		).toHaveLength(1);
		await retry("J7 leg 5: the failed goal leader retirement armed a retry", () => {
			expect(retirementAttempts).toBe(1);
			expect(botRecord(session, alias).retired).not.toBe(true);
		});
		await withDeadline(world.trace, "J7 leg 5: the retry retired the goal leader", retired.promise);
		expect(retirementAttempts).toBe(2);
		expect(botRecord(session, alias).retired).toBe(true);
	} finally {
		retire.mockRestore();
		send.mockRestore();
		record.mockRestore();
		reconcile.mockRestore();
	}
}
