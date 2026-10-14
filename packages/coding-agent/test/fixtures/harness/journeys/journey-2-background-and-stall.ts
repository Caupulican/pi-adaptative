import "../builtin-install.ts";
import { expect } from "vitest";
import { buildObjectiveRoutePrompt } from "../../../../src/core/goals/goal-continuation-prompt.ts";
import type { ObjectiveRoute } from "../../../../src/core/objective-execution/objective-route.ts";
import { goalObjectiveId } from "../../../../src/core/orchestration/work-state-projection.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import { requestTexts } from "./shared.ts";

export async function runJourney2BackgroundAndStallPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// E9 stall threshold, legacy goal mode: an auxiliary root holds an open requirement and its initial turn is held after admission.
	// The goal loop waits for that turn to settle, then twenty-one text-only continuation turns each record an implicit no_progress.
	if (!world.systemOne.enabled) {
		const e9Aux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		const e9Session = e9Aux.session;
		const e9InitialReached = createBarrier();
		const e9Gate = createBarrier();
		const e9Seen: { snapshot?: ReturnType<typeof e9Session.getGoalRuntimeSnapshot>; recovery?: boolean } = {};
		world.provider.enqueue(
			"root",
			calls("e9-goal-start", [
				{
					id: "e9-goal-1",
					name: "goal",
					arguments: { action: "start", goalId: "e9-goal", userGoal: "Keep the limit at 5." },
				},
			]),
			calls("e9-requirement", [
				{
					id: "e9-req-1",
					name: "goal",
					arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" },
				},
			]),
			text("e9-goal-ready", "The goal is ready."),
			{
				name: "e9-initial",
				check: () => e9InitialReached.release(),
				gate: e9Gate.promise,
				reply: { content: [{ type: "text", text: "Working on the goal." }] },
			},
		);
		for (let turn = 1; turn <= 21; turn += 1) {
			world.provider.enqueue(
				"root",
				turn === 21
					? {
							name: "e9-continuation-21",
							check: (request) => {
								e9Seen.snapshot = e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
								e9Seen.recovery = requestTexts(request).some((value) =>
									value.includes("RECOVERY REQUIRED: 20 turns"),
								);
							},
							reply: { content: [{ type: "text", text: "No change yet." }] },
						}
					: text(`e9-continuation-${turn}`, "No change yet."),
			);
		}
		world.systemOne.enterPhase("e9-goal", {});
		await withDeadline(trace, "E9 goal ready", e9Session.prompt("Set up the goal.", { autoContinueGoal: false }));
		const e9Before = e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
		expect(e9Before.continuation.openRequirementIds.length, "the setup leaves exactly one open requirement").toBe(1);
		const e9Initial = e9Session.prompt("Work on the goal.", { autoContinueGoal: false });
		await withDeadline(trace, "E9 initial turn admitted", e9InitialReached.promise);
		const e9Loop = e9Session.continueGoalLoop({ maxTurns: 21, maxStallTurns: 20 });
		e9Gate.release();
		await withDeadline(trace, "E9 initial turn", e9Initial);
		const e9Result = await withDeadline(trace, "E9 goal loop", e9Loop, 300_000);
		const e9Snapshot = e9Seen.snapshot;
		expect(e9Snapshot?.goalState?.goalId, "the loop reaches the aux goal's twenty-first request").toBe("e9-goal");
		expect(e9Snapshot?.goalState?.progressRevision, "no progress was recorded, so the revision is unchanged").toBe(
			e9Before.goalState?.progressRevision,
		);
		expect(e9Snapshot?.continuation.action, "the stall threshold continues, it never stops").toBe("continue");
		expect(e9Snapshot?.continuation.reasonCode, "the threshold is named stall_limit_reached").toBe(
			"stall_limit_reached",
		);
		expect(e9Snapshot?.continuation.stallTurns, "twenty unchanged turns have run").toBe(20);
		expect(e9Snapshot?.continuation.maxStallTurns, "the configured threshold is twenty").toBe(20);
		expect(e9Snapshot?.continuation.openRequirementIds, "the open requirement stays open").toEqual(
			e9Before.continuation.openRequirementIds,
		);
		expect(e9Seen.recovery, "the twenty-first continuation carries the recovery instruction").toBe(true);
		expect(e9Result.stopReason, "the host invocation cap ends the loop after twenty-one turns").toBe(
			"max_turns_reached",
		);
		expect(e9Result.turnsSubmitted, "twenty-one continuation turns were submitted").toBe(21);
		expect(
			await world.disposeSessionInBody(e9Session),
			"the E9 auxiliary goal root disposes cleanly",
		).toBeUndefined();
		trace.mark("root", "e9-stall-legacy");
	}
	// E9 ON is host-driven: explicit continueGoalLoop({ maxTurns: 1 }) calls drive each cycle. The setup prompt passes
	// autoContinueGoal:false, so no scheduled auto-continue runs in this block. This qualifies E9 only; the default workflow and
	// global continuation policy are unchanged.
	// E9 stall threshold, objective-primary mode: three one-turn goal cycles on one objective. The first two route to implement with equal
	// reason codes; the third repeats the strategy and replans. Each route is read from the native controller and matched to its ledger row by cycle.
	if (world.systemOne.enabled) {
		const e9Aux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		const e9Session = e9Aux.session;
		world.provider.enqueue(
			"root",
			calls("e9-goal-start", [
				{
					id: "e9-goal-1",
					name: "goal",
					arguments: { action: "start", goalId: "e9-goal", userGoal: "Keep the limit at 5." },
				},
			]),
			calls("e9-requirement", [
				{
					id: "e9-req-1",
					name: "goal",
					arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" },
				},
			]),
			text("e9-goal-ready", "The goal is ready."),
		);
		world.systemOne.enterPhase("e9-goal", {
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
		});
		await withDeadline(trace, "E9 goal ready", e9Session.prompt("Set up the goal.", { autoContinueGoal: false }));
		expect(
			e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 }).continuation.openRequirementIds.length,
			"the setup leaves exactly one open requirement",
		).toBe(1);
		// The cycle pattern of the orchestration objective cycle, routed to the executable edit path; the third cycle reports a repeated strategy.
		// Judgment groups by cycle. Objective intake is asked once, in the first cycle; the implement turn is checked for its patch and side effects;
		// the replan turn is checked for its repairs. The strategy_repetition answer is the only difference between the implement and replan groups.
		const e9Intake = {
			objective_coherent: { kind: "noul", probability: 0.97 },
			ambiguity_severity: { kind: "score", level: 0, confidence: 1 },
			missing_information: { kind: "noul", probability: 0.02 },
			acceptance_complete: { kind: "noul", probability: 0.97 },
			grounding_sufficient: { kind: "noul", probability: 0.97 },
		} as const;
		const e9Shared = {
			work_remaining: { kind: "noul", probability: 0.97 },
			missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
			evidence_sufficient: { kind: "noul", probability: 0.97 },
			semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
			context_stale: { kind: "noul", probability: 0.02 },
			independent_worker_required: { kind: "noul", probability: 0.02 },
			capability_escalation_required: { kind: "noul", probability: 0.02 },
			capability_gap_suspected: { kind: "noul", probability: 0.02 },
			completion_plausible: { kind: "noul", probability: 0.02 },
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "edit", confidence: 0.97 },
			claim_supported: { kind: "noul", probability: 0.97 },
			action_accomplished_step: { kind: "noul", probability: 0.02 },
			conclusions_supported: { kind: "noul", probability: 0.97 },
			scope_violation: { kind: "noul", probability: 0.02 },
			unrelated_behavior_change: { kind: "noul", probability: 0.02 },
			replan_required: { kind: "noul", probability: 0.02 },
			next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
		} as const;
		const e9Implement = {
			strategy_repetition: { kind: "noul", probability: 0.02 },
			patch_matches_requirements: { kind: "noul", probability: 0.97 },
			side_effects_acceptable: { kind: "noul", probability: 0.97 },
		} as const;
		const e9Replan = {
			strategy_repetition: { kind: "noul", probability: 0.97 },
			repairs_sufficient: { kind: "noul", probability: 0.97 },
			root_cause_addressed: { kind: "noul", probability: 0.97 },
		} as const;
		const e9CycleJudgments = (cycle: number): Parameters<typeof world.systemOne.enterPhase>[1] => {
			if (cycle === 1) return { ...e9Shared, ...e9Intake, ...e9Implement };
			if (cycle === 2) return { ...e9Shared, ...e9Implement };
			return { ...e9Shared, ...e9Replan };
		};
		// The transport text each cycle's root request actually received, keyed by cycle.
		const e9CycleTexts = new Map<number, string[]>();
		// The E9 intake criteria bound to the native objective, counted before each answer; the cycle-1 callback is their only producer.
		const e9IntakeBinding = { criteria: 0 };
		const e9Routes: ObjectiveRoute[] = [];
		for (const cycle of [1, 2, 3]) {
			world.systemOne.enterPhase(
				`e9-cycle-${cycle}`,
				e9CycleJudgments(cycle),
				cycle === 1
					? {
							expect: (request) => {
								if (!isRecordObject(request.state) || !("acceptanceCriteria" in request.state)) return;
								const record =
									e9Session.backgroundLanes.getTaskRuntimeSnapshot()?.objectives[goalObjectiveId("e9-goal")]
										?.objective;
								if (record === undefined)
									throw new Error("the native runtime holds no objective for the E9 goal at intake");
								const requirements = e9Session.getGoalStateSnapshot()?.requirements ?? [];
								const decoded = request.state.acceptanceCriteria;
								if (!Array.isArray(decoded))
									throw new Error("the E9 intake carries no acceptance criteria list");
								expect(decoded.length, "the intake transports every native acceptance criterion").toBe(
									record.acceptanceCriteria.length,
								);
								for (const [index, native] of record.acceptanceCriteria.entries()) {
									const item: unknown = decoded[index];
									const requirement = requirements.find((candidate) => candidate.id === native.id);
									expect(
										isRecordObject(item) && item.id === native.id && item.description === native.description,
										`intake criterion ${index} is the native objective criterion`,
									).toBe(true);
									expect(
										requirement?.text === native.description,
										`intake criterion ${index} is the goal requirement text`,
									).toBe(true);
									e9IntakeBinding.criteria += 1;
								}
							},
						}
					: undefined,
			);
			world.provider.enqueue("root", {
				name: `e9-cycle-root-${cycle}`,
				check: (request) => {
					e9CycleTexts.set(cycle, requestTexts(request));
				},
				reply: { content: [{ type: "text", text: `Objective cycle ${cycle} reply.` }] },
			});
			const result = await withDeadline(
				trace,
				`E9 cycle ${cycle}`,
				e9Session.continueGoalLoop({ maxTurns: 1, maxStallTurns: 20 }),
				120_000,
			);
			expect(result.stopReason, `cycle ${cycle} submits its one root turn`).toBe("max_turns_reached");
			expect(result.turnsSubmitted, `cycle ${cycle} submits exactly one turn`).toBe(1);
			const route = e9Session.objectiveExecutionController?.getLastRoute();
			if (route === undefined) throw new Error(`E9 cycle ${cycle} recorded no objective route`);
			e9Routes.push(route);
		}
		expect(new Set(e9Routes.map((route) => route.cycle_id)).size, "each cycle has its own route identity").toBe(3);
		expect(e9Routes[0]?.route, "the first cycle routes to implement").toBe("implement");
		expect(e9Routes[0]?.reason_codes, "the first cycle names its implementation reason").toEqual([
			"implementation_required",
		]);
		expect(e9Routes[1]?.route, "the second cycle routes to implement as well").toBe("implement");
		expect(e9Routes[1]?.reason_codes, "the first two routes carry equal reason codes").toEqual(
			e9Routes[0]?.reason_codes,
		);
		expect(e9Routes[2]?.route, "the third cycle replans on the repeated strategy").toBe("replan");
		expect(e9Routes[2]?.reason_codes, "the third route names the repeated strategy").toEqual([
			"strategy_repetition_detected",
		]);
		for (const [index, route] of e9Routes.entries()) {
			const owner = buildObjectiveRoutePrompt(route).text;
			expect(
				e9CycleTexts.get(index + 1)?.some((value) => value.includes(owner)) ?? false,
				`cycle ${index + 1} transport carries the owner route text for ${route.route}`,
			).toBe(true);
		}
		expect(e9IntakeBinding.criteria, "the E9 intake binds the native criteria before its answer").toBeGreaterThan(0);
		const e9Objective = e9Routes[0]?.objective_id;
		if (e9Objective === undefined) throw new Error("E9 has no objective id");
		const e9Ledger = e9Session.getDecisionLedger()?.recentRoutes(e9Session.sessionId, e9Objective, 8) ?? [];
		const e9Matched = e9Routes.map((route) => e9Ledger.filter((row) => row.cycleId === route.cycle_id));
		e9Matched.forEach((rows, index) => {
			const route = e9Routes[index];
			if (route === undefined) throw new Error("E9 route index out of range");
			expect(rows, `cycle ${route.cycle_id} has exactly one ledger row`).toHaveLength(1);
			const [row] = rows;
			expect(row?.route, `the ledger row for cycle ${route.cycle_id} carries the route`).toBe(route.route);
			expect(
				row?.reasonCodes,
				`the ledger row for cycle ${route.cycle_id} carries the route's reason codes`,
			).toEqual(route.reason_codes);
			expect(row?.executor, `cycle ${route.cycle_id} is executed by the root`).toBe("root");
			expect(typeof row?.evidenceMarker, `cycle ${route.cycle_id} row carries a numeric evidence marker`).toBe(
				"number",
			);
		});
		const e9Markers = e9Matched.map((rows) => rows[0]?.evidenceMarker);
		expect(
			e9Markers,
			"the three matched rows share one evidence marker: no new evidence separates the replan from the implement cycles",
		).toEqual([e9Markers[0], e9Markers[0], e9Markers[0]]);
		expect(
			await world.disposeSessionInBody(e9Session),
			"the E9 auxiliary objective root disposes cleanly",
		).toBeUndefined();
		trace.mark("root", "e9-stall-objective");
	}
}
