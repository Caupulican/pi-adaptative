import { expect } from "vitest";
import { replaceGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { ObjectiveExecutionInterruptedError } from "../../../../src/core/objective-execution/current-objective-execution.ts";
import { goalObjectiveId } from "../../../../src/core/orchestration/work-state-projection.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";
import { latestBatchResults } from "./shared.ts";

interface StageJudgments {
	readonly first: Readonly<Record<string, ScriptedJudgment>>;
	readonly replacement: Readonly<Record<string, ScriptedJudgment>>;
	readonly route: Readonly<Record<string, ScriptedJudgment>>;
}

/** Compare a late stage result with already accepted guidance through the actual next objective route. */
export async function verifyStageReplacement(world: HarnessWorld, judgments: StageJudgments): Promise<void> {
	if (!world.systemOne.enabled) return;
	for (const stage of ["preflight", "postflight"] as const) {
		for (const ordering of ["same-a", "fresh-b", "accepted-a", "late-a", "late-a-same-words"] as const) {
			const late = ordering === "late-a" || ordering === "late-a-same-words";
			const label = `${stage === "preflight" ? "goal-stage" : "goal-postflight-stage"}-${ordering}`;
			const aWords = `Inspect the original ${label} source boundary.`;
			const bWords = ordering === "late-a-same-words" ? aWords : `Inspect the replacement ${label} source boundary.`;
			const readPath = projectPath("src", `${label}-${ordering === "fresh-b" ? "b" : "a"}.txt`);
			const readWords = `Evidence line for ${label}-${ordering === "fresh-b" ? "b" : "a"}.`;
			const manager = world.createSessionManager(`${world.agentDir}-${label}`);
			const durableReplies = (answer: string) =>
				manager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some((part) => part.type === "text" && part.text === answer),
					);
			const reached = createBarrier();
			const release = createBarrier();
			let armed = false;
			let projection = "";
			let observedGoalId: string | undefined;
			const errors: string[] = [];
			const preflightIds = [
				"step_relevant",
				"evidence_sufficient_to_act",
				"unsupported_assumption_present",
				"route",
			];
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
			const neutralPreflight = {
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "reason", confidence: 0.97 },
			} as const;
			const holdStage = (): void => {
				world.systemOne.enterPhase(
					`${label}-held-stage`,
					stage === "preflight"
						? {
								...neutralPreflight,
								route: { kind: "choice", choice: "blocked", confidence: 0.97 },
							}
						: {
								...postflight,
								next_status: { kind: "choice", choice: "blocked", confidence: 0.97 },
							},
					{
						gate: release.promise,
						expect: (request) => {
							expect(Object.keys(request.questions).sort()).toEqual(
								[...(stage === "preflight" ? preflightIds : postflightIds)].sort(),
							);
							projection = JSON.stringify(request.state);
							observedGoalId = session.getGoalStateSnapshot()?.goalId;
							expect(observedGoalId).toBe(`${label}-${ordering === "fresh-b" ? "b" : "a"}`);
							if (stage === "preflight") {
								expect(projection).toContain(ordering === "fresh-b" ? bWords : aWords);
								if (aWords !== bWords)
									expect(projection).not.toContain(ordering === "fresh-b" ? aWords : bWords);
							} else {
								expect(request.state).toMatchObject({
									last_action: {
										tool: "read",
										status: "succeeded",
										intent: expect.stringContaining(readPath),
									},
								});
							}
						},
						onAdmit: () => reached.release(),
					},
				);
			};
			const { session } = await world.createRootSession("root", {
				agentDir: `${world.agentDir}-${label}`,
				sessionManager: manager,
				settings: { memorySystem: "okf", autoLearn: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", () => {
							if (!armed) return;
							armed = false;
							if (stage === "preflight") holdStage();
							else world.systemOne.enterPhase(`${label}-neutral-preflight`, neutralPreflight);
						});
					},
				],
			});
			let pending: Promise<void> | undefined;
			let stageSettled = false;
			let stageError: unknown;
			let readFilePrepared = false;
			let priorReadBytes: Buffer | string | undefined;
			const failures: unknown[] = [];
			try {
				if (stage === "postflight") {
					priorReadBytes = world.io.existsSync(readPath) ? world.io.readFileSync(readPath) : undefined;
					readFilePrepared = true;
					world.io.writeFileSync(readPath, `${readWords}\n`);
				}
				await session.bindExtensions({
					uiContext: world.humanInput.ui,
					onError: (error) => errors.push(error.error),
				});
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
				world.provider.enqueue(
					"root",
					text(`${label}-baseline`, "The original boundary remains under inspection."),
				);
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
				const stageAnswer =
					stage === "preflight" && late ? nextAnswer : `The observed ${label} boundary remains under inspection.`;
				const requestsBeforeStage = world.provider.requests.length;
				if (stage === "postflight")
					world.provider.enqueue(
						"root",
						calls(`${label}-read`, [{ id: `${label}-read`, name: "read", arguments: { path: readPath } }]),
					);
				world.provider.enqueue("root", {
					...text(`${label}-stage-answer`, stageAnswer),
					check: (request) => {
						if (stage === "postflight") {
							const read = latestBatchResults(request).find((result) => result.toolName === "read");
							expect(read?.isError, `${label}: real source read succeeds before final reply`).toBe(false);
							expect(read?.text, `${label}: real source receipt reaches the final provider request`).toContain(
								readWords,
							);
							holdStage();
						} else if (!stageSettled && !late)
							world.systemOne.enterPhase(`${label}-stage-postflight`, postflight);
					},
				});
				pending = session.prompt(`Inspect the ${label} boundary.`, {
					internalContextType: "stage-replacement-control",
					goalExecutionId: session.getGoalStateSnapshot()?.goalId,
					processSlashCommands: false,
					autoContinueGoal: false,
				});
				await withDeadline(world.trace, `${label}: real ${stage} transport held`, reached.promise);
				const requestsAtHeld = world.provider.requests.length;
				if (stage === "postflight") {
					expect(requestsAtHeld - requestsBeforeStage, `${label}: read and final reply precede postflight`).toBe(
						2,
					);
					expect(
						durableReplies(stageAnswer),
						`${label}: original response is durable before replacement`,
					).toHaveLength(1);
				}
				const entriesAtHeld = manager.getBranch().length;
				if (late) replace();
				const goalAtRelease = session.getGoalStateSnapshot();
				// A superseded stage interrupts before any later provider round. Ordinary preflight controls
				// install postflight from their provider callback; postflight's original answer already persisted.
				world.systemOne.enterPhase(`${label}-released-stage`, {});
				release.release();
				const stageOutcome = await withDeadline(world.trace, `${label}: held stage settles`, pending).then(
					() => "resolved",
					(error: unknown) => {
						stageError = error;
						return error instanceof Error ? error.message : String(error);
					},
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
				// A preflight refusal leaves the potential answer queued for B. Postflight already consumed
				// its distinct original answer, so B receives its own response after the held judgment settles.
				if (late && (stage === "postflight" || stageProviderRequests > 0))
					world.provider.enqueue("root", text(`${label}-next-answer`, nextAnswer));
				const next = await withDeadline(
					world.trace,
					`${label}: next actual objective route`,
					session.continueGoalOnce({ maxStallTurns: 3 }),
				);
				await withDeadline(world.trace, `${label}: next route released`, session.waitForForegroundIdle());
				const observations = JSON.stringify({
					stage,
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
					expect(stageProviderRequests, observations).toBe(stage === "preflight" ? 1 : 0);
				}
				if (stage === "postflight") expect(durableReplies(stageAnswer), observations).toHaveLength(1);
				// Already accepted guidance remains valid. The diagnostic isolates an answer admitted only after its observed goal was replaced.
				expect(session.objectiveExecutionController?.getLastRoute()?.route, observations).toBe(
					late ? "implement" : "blocked_external",
				);
				expect(session.objectiveExecutionController?.getLastRoute()?.objective_id, observations).toBe(
					goalObjectiveId(`${label}-${ordering === "same-a" ? "a" : "b"}`),
				);
				const reasons = session.objectiveExecutionController?.getLastRoute()?.reason_codes ?? [];
				const blockedReason =
					stage === "preflight" ? "system_one_preflight_block" : "system_one_postflight_blocked";
				if (late) expect(reasons, observations).not.toContain(blockedReason);
				else expect(reasons, observations).toContain(blockedReason);
				expect(next.submitted, observations).toBe(late);
				expect(world.provider.requests.length - beforeNext, observations).toBe(late ? 1 : 0);
				if (late) {
					expect(stageError, observations).toBeInstanceOf(ObjectiveExecutionInterruptedError);
					if (stageError instanceof ObjectiveExecutionInterruptedError)
						expect(stageError.reason, observations).toBe("goal_replaced");
					expect(stageProviderRequests, observations).toBe(0);
					expect(goalAfterStage, observations).toEqual(goalAtRelease);
					expect(durableReplies(nextAnswer), observations).toHaveLength(1);
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
				if (readFilePrepared) {
					try {
						if (priorReadBytes !== undefined) world.io.writeFileSync(readPath, priorReadBytes);
						else if (world.io.existsSync(readPath)) world.io.unlinkSync(readPath);
					} catch (error) {
						failures.push(error);
					}
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, `${label}: invariant and cleanup failures`);
			world.trace.mark("root", label);
		}
	}
}
