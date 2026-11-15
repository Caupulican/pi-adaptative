import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { projectActivityLane } from "../../../../src/modes/interactive/components/activity-lane.ts";
import { buildOperatorPovSegments } from "../../../../src/modes/interactive/components/operator-pov-bar.ts";
import { createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

const LABEL = "owner-goal-intent";
const OWNER_MESSAGE =
	"Fix the failing imports in the limits module and keep going until the build is green and every test passes.";

/**
 * An owner message that names no goal phrase starts a goal when System One judges it a standing outcome. The judgment runs
 * after the message is delivered: the owner's turn ends first (the evaluator is held until then), and the goal starts from
 * the judgment alone, with the hidden harness note that asks the agent to record the end state and the steps. With System
 * One off the same message asks nothing and starts no goal. While the goal is unfinished the operator bar marks it and the
 * activity lane names it with the product's words; with no goal neither shows one.
 */
/**
 * The goal's marks as the interface draws them from the session's live state: the operator bar's goal segment (read as the
 * interactive layout's source reads the session) and the activity lane's goal items.
 */
function goalMarks(session: AgentSession) {
	// The bar styles System One's and CI's segments with the theme every world loads (`runHarnessWorld`).
	const goalState = session.getGoalStateSnapshot();
	const segment = buildOperatorPovSegments({
		getProjection: () => session.operatorProjection.getProjection(),
		getRouteSnapshot: () => session.getForegroundRouteSnapshot(),
		getSemanticPlaneHealth: () => session.getSemanticPlaneHealth(),
		getCostSummary: () => session.getCostSummary(),
		isUsingSubscription: () => (session.model ? session.modelRegistry.isUsingSubscription(session.model) : false),
		getSessionWorkState: () => session.getSessionWorkState(),
		getGoalState: () => goalState,
	}).find((candidate) => candidate.id === "goal");
	const lane = projectActivityLane({
		goalState,
		taskState: session.getTaskStepsStateSnapshot(),
		laneRecords: session.getLaneRecords(),
	});
	return {
		bar: segment && { label: segment.label, value: segment.value, tone: segment.tone },
		lane: [...lane.active, ...lane.terminal]
			.filter((item) => item.kind === "goal")
			.map((item) => ({ label: item.label, status: item.status })),
	};
}

export async function verifyOwnerGoalIntent(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-${LABEL}`;
	const manager = world.createSessionManager(agentDir);
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		// No continuation turn: the leg ends with the goal started and the note delivered.
		settings: { memorySystem: "okf", autoLearn: { enabled: false }, autonomy: { goalAutoContinue: false } },
	});
	const extensionErrors: string[] = [];
	const failures: unknown[] = [];
	const goalStarted = createBarrier();
	const noteDelivered = createBarrier();
	const warnings: string[] = [];
	session.subscribe((event) => {
		if (event.type === "goal_state_changed" && event.state !== undefined) goalStarted.release();
		if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === LABEL) {
			noteDelivered.release();
		}
		if (event.type === "warning") warnings.push(event.message);
	});
	try {
		await session.bindExtensions({
			uiContext: world.humanInput.ui,
			onError: (error) => extensionErrors.push(error.error),
		});
		const requestsBefore = world.systemOne.requests.length;
		const judged = createBarrier();
		world.systemOne.enterPhase(
			LABEL,
			{
				sets_standing_outcome: { kind: "noul", probability: 0.97 },
				message_evidence_sufficient: { kind: "noul", probability: 0.97 },
			},
			{ gate: judged.promise },
		);
		world.provider.enqueue("root", text(`${LABEL}-turn`, "Understood; starting with the imports."));
		await withDeadline(
			world.trace,
			`${LABEL}: owner turn`,
			session.prompt(OWNER_MESSAGE, { autoContinueGoal: false }),
		);
		await withDeadline(world.trace, `${LABEL}: owner turn released the foreground`, session.waitForForegroundIdle());
		expect(session.getGoalStateSnapshot(), "no goal exists before the judgment answers").toBeUndefined();
		if (!world.systemOne.enabled) {
			expect(world.systemOne.requests.length, "System One off asks nothing about the message").toBe(requestsBefore);
			expect(session.getGoalStateSnapshot(), "System One off starts no goal from it").toBeUndefined();
			expect(goalMarks(session), "with no goal neither the operator bar nor the activity lane shows one").toEqual({
				bar: undefined,
				lane: [],
			});
			expect(extensionErrors, "no extension error").toEqual([]);
		} else {
			judged.release();
			await withDeadline(world.trace, `${LABEL}: the judged outcome started a goal`, goalStarted.promise);
			await withDeadline(world.trace, `${LABEL}: the harness note reached the session`, noteDelivered.promise);
			const asked = world.systemOne.decoded.filter((request) => request.phase === LABEL);
			expect(
				asked.map((request) => Object.keys(request.questions).sort()),
				"one request carried exactly the two questions",
			).toEqual([["message_evidence_sufficient", "sets_standing_outcome"]]);
			expect(JSON.stringify(asked[0]?.state), "the question reads the owner's own words").toContain(
				"Fix the failing imports in the limits module",
			);
			const goal = session.getGoalStateSnapshot();
			expect(goal, "the owner's message is the goal's objective, running").toMatchObject({
				status: "active",
				userGoal: expect.stringContaining("Fix the failing imports in the limits module"),
			});
			expect(goal?.tokenBudget, "an owner message grants no token budget").toBeUndefined();
			expect(
				goalMarks(session),
				"the unfinished goal, running with no requirement recorded yet, is marked on the operator bar on the accent tone and named in the activity lane",
			).toEqual({
				bar: { label: "Goal", value: "◎", tone: "accent" },
				lane: [{ label: "goal", status: "active" }],
			});
			const notes = manager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom_message" && entry.customType === LABEL ? [entry] : []));
			expect(notes, "one note, hidden from the owner").toHaveLength(1);
			expect(notes[0]?.display).toBe(false);
			expect(
				notes[0]?.content,
				"the note names the goal and asks for the end state and steps as requirements",
			).toEqual(expect.stringContaining(`goal '${goal?.goalId}' was started from it`));
			expect(notes[0]?.content).toEqual(expect.stringContaining("action add_requirement"));
			expect(warnings, "the start raised no warning").toEqual([]);
			expect(extensionErrors, "no extension error").toEqual([]);
		}
	} catch (error) {
		failures.push(error);
	} finally {
		try {
			expect(await world.disposeSessionInBody(session), `${LABEL}: no retained work`).toBeUndefined();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${LABEL}: invariant and cleanup failures`);
	world.trace.mark("root", LABEL);
}
