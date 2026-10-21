import "../builtin-install.ts";
import { expect } from "vitest";
import { cancelPersistedGoal, replaceGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../../../../src/core/goals/goal-tool-core.ts";
import { appendGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import { createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { verifyGoalRetrievalReplacement } from "./journey-2-goal-retrieval-replacement.ts";

const ROUTE_JUDGMENTS = {
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

const TURN_JUDGMENTS = {
	...ROUTE_JUDGMENTS,
	objective_coherent: { kind: "noul", probability: 0.97 },
	ambiguity_severity: { kind: "score", level: 0, confidence: 1 },
	missing_information: { kind: "noul", probability: 0.02 },
	acceptance_complete: { kind: "noul", probability: 0.97 },
	grounding_sufficient: { kind: "noul", probability: 0.97 },
	step_relevant: { kind: "noul", probability: 0.97 },
	evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
	unsupported_assumption_present: { kind: "noul", probability: 0.02 },
	route: { kind: "choice", choice: "inspect", confidence: 0.97 },
	claim_supported: { kind: "noul", probability: 0.97 },
	patch_matches_requirements: { kind: "noul", probability: 0.97 },
	side_effects_acceptable: { kind: "noul", probability: 0.97 },
	action_accomplished_step: { kind: "noul", probability: 0.02 },
	conclusions_supported: { kind: "noul", probability: 0.97 },
	scope_violation: { kind: "noul", probability: 0.02 },
	unrelated_behavior_change: { kind: "noul", probability: 0.02 },
	replan_required: { kind: "noul", probability: 0.02 },
	next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
} as const;

// The completed cancel/start control in CI asks none of these three judgments for B's turn.
const {
	claim_supported: _claimSupported,
	patch_matches_requirements: _patchMatchesRequirements,
	side_effects_acceptable: _sideEffectsAcceptable,
	...REPLACEMENT_TURN_JUDGMENTS
} = TURN_JUDGMENTS;

const {
	objective_coherent: _objectiveCoherent,
	ambiguity_severity: _ambiguitySeverity,
	missing_information: _missingInformation,
	acceptance_complete: _acceptanceComplete,
	grounding_sufficient: _groundingSufficient,
	...CONTINUATION_TURN_JUDGMENTS
} = REPLACEMENT_TURN_JUDGMENTS;

/** Extend journey 2's goal orchestration across a late route judgment and a real goal replacement. */
export async function verifyGoalReplacementDuringRoute(world: HarnessWorld): Promise<void> {
	for (const directReplacement of [false, true]) await verifyReplacementVariant(world, directReplacement);
	await verifyReplacementVariant(world, true, true);
	await verifyGoalRetrievalReplacement(world, {
		bootstrap: TURN_JUDGMENTS,
		first: REPLACEMENT_TURN_JUDGMENTS,
		later: CONTINUATION_TURN_JUDGMENTS,
		route: ROUTE_JUDGMENTS,
	});
}

async function verifyReplacementVariant(
	world: HarnessWorld,
	directReplacement: boolean,
	holdAtPreflight = false,
): Promise<void> {
	const label = holdAtPreflight
		? "goal-direct-replacement-during-preflight"
		: directReplacement
			? "goal-direct-replacement-during-route"
			: "goal-cancel-start-during-route";
	const agentDir = `${world.agentDir}-${label}`;
	const manager = world.createSessionManager(agentDir);
	const now = new Date().toISOString();
	appendGoalStateSnapshot(
		manager,
		createGoalState({ goalId: `${label}-a`, userGoal: "Inspect the first source boundary.", now }),
	);
	const routeReached = createBarrier();
	const releaseRoute = createBarrier();
	let preflightArmed = false;
	const extensionErrors: string[] = [];
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					if (!preflightArmed) return;
					preflightArmed = false;
					routeReached.release();
					await releaseRoute.promise;
				});
			},
		],
	});
	await session.bindExtensions({
		uiContext: world.humanInput.ui,
		onError: (error) => extensionErrors.push(error.error),
	});
	let oldPass: ReturnType<typeof session.continueGoalOnce> | undefined;
	const failures: unknown[] = [];
	try {
		// Normal-order control also admits A through the real objective certificates before its next route is held.
		world.systemOne.enterPhase(`${label}-a-control`, TURN_JUDGMENTS);
		world.provider.enqueue("root", text(`${label}-a-control`, "The first boundary remains under inspection."));
		const first = await withDeadline(
			world.trace,
			`${label}: normal A continuation`,
			session.continueGoalOnce({ maxStallTurns: 3 }),
		);
		expect({ submitted: first.submitted, outcome: first.turnOutcome }).toEqual({
			submitted: true,
			outcome: "completed",
		});
		await withDeadline(world.trace, `${label}: A foreground released`, session.waitForForegroundIdle());
		const beforeRequests = world.provider.requests.length;
		const beforeEntries = manager.getBranch().length;
		const pendingContext = `${label}: retained next-turn evidence`;
		if (world.systemOne.enabled) {
			if (holdAtPreflight) {
				await session.sendCustomMessage(
					{ customType: "goal-replacement-context", content: pendingContext, display: false },
					{ deliverAs: "nextTurn" },
				);
				preflightArmed = true;
				world.systemOne.enterPhase(`${label}-held-a-preflight`, ROUTE_JUDGMENTS);
			} else
				world.systemOne.enterPhase(`${label}-held-a-route`, ROUTE_JUDGMENTS, {
					gate: releaseRoute.promise,
					expect: (request) => {
						expect(
							"completion_plausible" in request.questions,
							`${label}: the held transport is the route judgment`,
						).toBe(true);
						expect(JSON.stringify(request.state), `${label}: the judge reads A's objective`).toContain(
							`${label}-a`,
						);
					},
					onAdmit: () => routeReached.release(),
				});
			oldPass = session.continueGoalOnce({ maxStallTurns: 3 });
			await withDeadline(world.trace, `${label}: A reaches the held production boundary`, routeReached.promise);
		}
		const current = session.getGoalStateSnapshot();
		if (current === undefined) throw new Error(`${label}: no goal A to cancel`);
		const replacement = {
			goalId: `${label}-b`,
			userGoal: "Inspect the second source boundary.",
			tokenBudget: 50_000,
		};
		const started = directReplacement
			? replaceGoal(replacement, now)
			: (() => {
					const cancelled = cancelPersistedGoal(session, now);
					if (!cancelled.ok) throw new Error(cancelled.error);
					return applyGoalAction(cancelled.state, { action: "start", ...replacement }, now);
				})();
		if (!started.ok) throw new Error(started.error);
		session.saveGoalStateSnapshot(started.state);
		const replacementBefore = session.getGoalStateSnapshot();
		expect(replacementBefore?.goalId).toBe(`${label}-b`);
		expect(world.provider.requests, `${label}: replacement needs no provider turn`).toHaveLength(beforeRequests);
		// A held transport request answers from its captured phase. B's script is ready before it
		// settles, so an unintended old turn is observed as a real request rather than an unscripted-I/O failure.
		world.systemOne.enterPhase(`${label}-b-control`, REPLACEMENT_TURN_JUDGMENTS);
		const answer = "The second boundary remains under inspection.";
		world.provider.enqueue("root", text(`${label}-b-control`, answer));
		releaseRoute.release();
		if (oldPass !== undefined) {
			const stale = await withDeadline(world.trace, `${label}: late A route settles`, oldPass);
			if (stale.submitted || world.provider.requests.length !== beforeRequests) {
				throw new Error(
					`${label}: stale A executed after replacement; observations=${JSON.stringify({
						submitted: stale.submitted,
						providerRequests: world.provider.requests.length - beforeRequests,
						before: replacementBefore,
						after: session.getGoalStateSnapshot(),
						messages: manager
							.getBranch()
							.slice(beforeEntries)
							.filter((entry) => entry.type === "message"),
					})}`,
				);
			}
			expect(stale.submitted, `${label}: stale A cannot submit a continuation`).toBe(false);
		}
		expect(world.provider.requests, `${label}: A's late judgment starts no provider request`).toHaveLength(
			beforeRequests,
		);
		expect(
			session.getGoalStateSnapshot(),
			`${label}: A cannot alter B's goal, budget or continuation counters`,
		).toEqual(replacementBefore);
		expect(
			manager
				.getBranch()
				.slice(beforeEntries)
				.filter((entry) => entry.type === "message"),
			`${label}: stale A adds no user or assistant message`,
		).toEqual([]);

		const control = await withDeadline(
			world.trace,
			`${label}: normal B continuation`,
			session.continueGoalOnce({ maxStallTurns: 3 }),
		);
		expect({ submitted: control.submitted, outcome: control.turnOutcome }).toEqual({
			submitted: true,
			outcome: "completed",
		});
		await withDeadline(world.trace, `${label}: B foreground released`, session.waitForForegroundIdle());
		if (holdAtPreflight && world.systemOne.enabled) {
			const request = world.provider.requests[beforeRequests];
			expect(request, `${label}: B owns the preserved context request`).toBeDefined();
			expect(
				JSON.stringify(request?.context.messages).split(pendingContext).length - 1,
				`${label}: refused A consumes no next-turn evidence; B receives it once`,
			).toBe(1);
		}
		expect(extensionErrors, `${label}: actual lifecycle hook reports no errors`).toEqual([]);
		expect(world.provider.requests, `${label}: B submits exactly one normal continuation`).toHaveLength(
			beforeRequests + 1,
		);
		expect(session.getGoalStateSnapshot()).toMatchObject({
			goalId: `${label}-b`,
			status: "active",
			tokenBudget: 50_000,
		});
		expect(
			manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((block) => block.type === "text" && block.text === answer),
				),
			`${label}: B's final response is durable once`,
		).toHaveLength(1);
	} catch (error) {
		failures.push(error);
	} finally {
		releaseRoute.release();
		if (oldPass !== undefined) {
			try {
				await withDeadline(world.trace, `${label}: released route physically settles`, oldPass);
			} catch (error) {
				if (!failures.includes(error)) failures.push(error);
			}
		}
		try {
			expect(await world.disposeSessionInBody(session), `${label}: root disposes without held work`).toBeUndefined();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${label}: invariant and cleanup failures`);
	world.trace.mark("root", label);
}
