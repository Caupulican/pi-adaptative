import { expect } from "vitest";
import { replaceGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { goalObjectiveId } from "../../../../src/core/orchestration/work-state-projection.ts";
import { createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";

interface StageJudgments {
	readonly first: Readonly<Record<string, ScriptedJudgment>>;
	readonly replacement: Readonly<Record<string, ScriptedJudgment>>;
	readonly route: Readonly<Record<string, ScriptedJudgment>>;
}

/** Compare a late stage result with already accepted guidance through the actual next objective route. */
export async function verifyPreflightReplacement(world: HarnessWorld, judgments: StageJudgments): Promise<void> {
	if (!world.systemOne.enabled) return;
	for (const ordering of ["same-a", "fresh-b", "accepted-a", "late-a", "late-a-same-words"] as const) {
		const late = ordering === "late-a" || ordering === "late-a-same-words";
		const label = `goal-stage-${ordering}`;
		const aWords = `Inspect the original ${label} source boundary.`;
		const bWords = ordering === "late-a-same-words" ? aWords : `Inspect the replacement ${label} source boundary.`;
		const manager = world.createSessionManager(`${world.agentDir}-${label}`);
		const reached = createBarrier();
		const release = createBarrier();
		let armed = false;
		let projection = "";
		let observedGoalId: string | undefined;
		const errors: string[] = [];
		const preflightIds = ["step_relevant", "evidence_sufficient_to_act", "unsupported_assumption_present", "route"];
		const postflightIds = [
			"action_accomplished_step",
			"conclusions_supported",
			"scope_violation",
			"unrelated_behavior_change",
			"replan_required",
			"next_status",
		];
		const postflight = Object.fromEntries(
			Object.entries(judgments.first).filter(([id]) => postflightIds.includes(id)),
		);
		const { session } = await world.createRootSession("root", {
			agentDir: `${world.agentDir}-${label}`,
			sessionManager: manager,
			settings: { memorySystem: "okf", autoLearn: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						if (!armed) return;
						armed = false;
						world.systemOne.enterPhase(
							`${label}-held-stage`,
							{
								step_relevant: { kind: "noul", probability: 0.97 },
								evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
								unsupported_assumption_present: { kind: "noul", probability: 0.02 },
								route: { kind: "choice", choice: "blocked", confidence: 0.97 },
							},
							{
								gate: release.promise,
								expect: (request) => {
									expect(Object.keys(request.questions).sort()).toEqual([...preflightIds].sort());
									projection = JSON.stringify(request.state);
									observedGoalId = session.getGoalStateSnapshot()?.goalId;
									expect(observedGoalId).toBe(`${label}-${ordering === "fresh-b" ? "b" : "a"}`);
									expect(projection).toContain(ordering === "fresh-b" ? bWords : aWords);
									if (aWords !== bWords)
										expect(projection).not.toContain(ordering === "fresh-b" ? aWords : bWords);
								},
								onAdmit: () => reached.release(),
							},
						);
					});
				},
			],
		});
		let pending: Promise<void> | undefined;
		let stageSettled = false;
		const failures: unknown[] = [];
		try {
			await session.bindExtensions({ uiContext: world.humanInput.ui, onError: (error) => errors.push(error.error) });
			session.saveGoalStateSnapshot(
				createGoalState({
					goalId: `${label}-a`,
					userGoal: aWords,
					tokenBudget: 100_000,
					now: new Date().toISOString(),
				}),
			);
			// A neutral accepted preflight leaves no next-compose directive in the baseline.
			world.systemOne.enterPhase(`${label}-baseline`, {
				...judgments.first,
				route: { kind: "choice", choice: "reason", confidence: 0.97 },
			});
			world.provider.enqueue("root", text(`${label}-baseline`, "The original boundary remains under inspection."));
			expect(
				(await withDeadline(world.trace, `${label}: baseline`, session.continueGoalOnce({ maxStallTurns: 3 })))
					.submitted,
			).toBe(true);
			await withDeadline(world.trace, `${label}: baseline released`, session.waitForForegroundIdle());
			const replace = (): void => {
				const result = replaceGoal(
					{ goalId: `${label}-b`, userGoal: bWords, tokenBudget: 100_000 },
					new Date().toISOString(),
				);
				if (!result.ok) throw new Error(result.error);
				session.saveGoalStateSnapshot(result.state);
			};
			if (ordering === "fresh-b") replace();
			world.systemOne.enterPhase(`${label}-before-stage`, {});
			armed = true;
			const nextAnswer = `The current ${label} boundary remains under inspection.`;
			const stageAnswer = late ? nextAnswer : `${label} boundary remains under inspection.`;
			world.provider.enqueue("root", {
				...text(`${label}-stage-answer`, stageAnswer),
				check: () => {
					if (!stageSettled) world.systemOne.enterPhase(`${label}-stage-postflight`, postflight);
				},
			});
			pending = session.prompt(`Inspect the ${label} boundary.`, {
				internalContextType: "stage-replacement-control",
				goalExecutionId: session.getGoalStateSnapshot()?.goalId,
				processSlashCommands: false,
				autoContinueGoal: false,
			});
			await withDeadline(world.trace, `${label}: real preflight transport held`, reached.promise);
			const requestsAtHeld = world.provider.requests.length;
			const entriesAtHeld = manager.getBranch().length;
			if (late) replace();
			const goalAtRelease = session.getGoalStateSnapshot();
			world.systemOne.enterPhase(`${label}-released-stage`, {});
			release.release();
			const stageOutcome = await withDeadline(world.trace, `${label}: held stage settles`, pending).then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			stageSettled = true;
			await withDeadline(world.trace, `${label}: stage released`, session.waitForForegroundIdle());
			const goalAfterStage = session.getGoalStateSnapshot();
			const stageProviderRequests = world.provider.requests.length - requestsAtHeld;
			const stageMessages = manager
				.getBranch()
				.slice(entriesAtHeld)
				.filter((entry) => entry.type === "message");
			if (ordering === "accepted-a") replace();
			const beforeNext = world.provider.requests.length;
			world.systemOne.enterPhase(
				`${label}-next-route`,
				late
					? judgments.replacement
					: {
							...judgments.route,
							...Object.fromEntries(
								Object.entries(judgments.replacement).filter(
									([id]) =>
										[
											"objective_coherent",
											"ambiguity_severity",
											"missing_information",
											"acceptance_complete",
											"grounding_sufficient",
										].includes(id) && ordering !== "same-a",
								),
							),
						},
			);
			// On the intended refusal path B consumes the potential answer already queued before A's release.
			// If A wrongly consumed it, keep the next route observable and fail the forbidden provider effect below.
			if (late && stageProviderRequests > 0)
				world.provider.enqueue("root", text(`${label}-next-answer`, nextAnswer));
			const next = await withDeadline(
				world.trace,
				`${label}: next actual objective route`,
				session.continueGoalOnce({ maxStallTurns: 3 }),
			);
			await withDeadline(world.trace, `${label}: next route released`, session.waitForForegroundIdle());
			const observations = JSON.stringify({
				ordering,
				projection,
				observedGoalId,
				goalAtRelease,
				goalAfterStage,
				stageOutcome,
				stageProviderRequests,
				stageMessages,
				nextSubmitted: next.submitted,
				nextRoute: session.objectiveExecutionController?.getLastRoute(),
				goalAfterNext: session.getGoalStateSnapshot(),
				nextProviderRequests: world.provider.requests.length - beforeNext,
			});
			if (!late) {
				expect(stageOutcome, observations).toBe("resolved");
				expect(stageProviderRequests, observations).toBe(1);
			}
			// Already accepted guidance remains valid. The diagnostic isolates an answer admitted only after its observed goal was replaced.
			expect(session.objectiveExecutionController?.getLastRoute()?.route, observations).toBe(
				late ? "implement" : "blocked_external",
			);
			expect(session.objectiveExecutionController?.getLastRoute()?.objective_id, observations).toBe(
				goalObjectiveId(`${label}-${ordering === "same-a" ? "a" : "b"}`),
			);
			const reasons = session.objectiveExecutionController?.getLastRoute()?.reason_codes ?? [];
			if (late) expect(reasons, observations).not.toContain("system_one_preflight_block");
			else expect(reasons, observations).toContain("system_one_preflight_block");
			expect(next.submitted, observations).toBe(late);
			expect(world.provider.requests.length - beforeNext, observations).toBe(late ? 1 : 0);
			if (late) {
				expect(stageProviderRequests, observations).toBe(0);
				expect(goalAfterStage, observations).toEqual(goalAtRelease);
				expect(
					manager
						.getBranch()
						.filter(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "assistant" &&
								entry.message.content.some((part) => part.type === "text" && part.text === nextAnswer),
						),
					observations,
				).toHaveLength(1);
			}
			expect(errors, observations).toEqual([]);
		} catch (error) {
			failures.push(error);
		} finally {
			release.release();
			if (pending) {
				try {
					await withDeadline(world.trace, `${label}: released stage physically settles`, pending);
				} catch (error) {
					if (!stageSettled && !failures.includes(error)) failures.push(error);
				}
			}
			try {
				expect(await world.disposeSessionInBody(session)).toBeUndefined();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, `${label}: invariant and cleanup failures`);
		world.trace.mark("root", label);
	}
}
