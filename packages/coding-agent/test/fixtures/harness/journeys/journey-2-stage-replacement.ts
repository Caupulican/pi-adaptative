import { expect } from "vitest";
import { editPersistedGoal, replaceGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { ObjectiveExecutionInterruptedError } from "../../../../src/core/objective-execution/current-objective-execution.ts";
import { goalObjectiveId } from "../../../../src/core/orchestration/work-state-projection.ts";
import { calls, createBarrier, type ScriptedRequest, text } from "../scripted-provider.ts";
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
		const orderings = [
			"same-a",
			"fresh-b",
			"accepted-a",
			"late-a",
			"late-a-same-words",
			...(stage === "preflight" ? (["fresh-edit", "accepted-a-edit", "late-a-edit"] as const) : []),
			...(stage === "postflight" ? (["before-stage-a", "before-stage-a-same-words"] as const) : []),
		] as const;
		for (const ordering of orderings) {
			const sameIdEdit = ordering === "fresh-edit" || ordering === "accepted-a-edit" || ordering === "late-a-edit";
			const fresh = ordering === "fresh-b" || ordering === "fresh-edit";
			const accepted = ordering === "accepted-a" || ordering === "accepted-a-edit";
			const lateEdit = ordering === "late-a-edit";
			const providerHeld = ordering === "before-stage-a" || ordering === "before-stage-a-same-words";
			const late = ordering === "late-a" || ordering === "late-a-same-words" || providerHeld || lateEdit;
			const label = `${stage === "preflight" ? "goal-stage" : "goal-postflight-stage"}-${ordering}`;
			const aWords = `Inspect the original ${label} source boundary.`;
			const bWords =
				ordering === "late-a-same-words" || ordering === "before-stage-a-same-words"
					? aWords
					: `Inspect the replacement ${label} source boundary.`;
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
								expect(projection).toContain(fresh ? bWords : aWords);
								if (aWords !== bWords) expect(projection).not.toContain(fresh ? aWords : bWords);
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
				const changeGoal = (): void => {
					const result = sameIdEdit
						? editPersistedGoal(session, { userGoal: bWords })
						: replaceGoal(
								{ goalId: `${label}-b`, userGoal: bWords, tokenBudget: 100_000 },
								new Date().toISOString(),
							);
					if (!result.ok) throw new Error(result.error);
					if (!sameIdEdit) session.saveGoalStateSnapshot(result.state);
				};
				if (fresh) changeGoal();
				world.systemOne.enterPhase(`${label}-before-stage`, {});
				armed = true;
				const nextAnswer = `The current ${label} boundary remains under inspection.`;
				const stageAnswer =
					stage === "preflight" && late && !lateEdit
						? nextAnswer
						: `The observed ${label} boundary remains under inspection.`;
				const requestsBeforeStage = world.provider.requests.length;
				const warningsBeforeStage = world.warnings.length;
				if (stage === "postflight")
					world.provider.enqueue(
						"root",
						calls(`${label}-read`, [{ id: `${label}-read`, name: "read", arguments: { path: readPath } }]),
					);
				const stageReply = {
					...text(`${label}-stage-answer`, stageAnswer),
					...(providerHeld ? { gate: release.promise } : {}),
					check: (request: ScriptedRequest) => {
						if (stage === "postflight") {
							const read = latestBatchResults(request).find((result) => result.toolName === "read");
							expect(read?.isError, `${label}: real source read succeeds before final reply`).toBe(false);
							expect(read?.text, `${label}: real source receipt reaches the final provider request`).toContain(
								readWords,
							);
							if (providerHeld)
								expect(
									session.getGoalStateSnapshot()?.goalId,
									`${label}: A owns the admitted final response`,
								).toBe(`${label}-a`);
							if (providerHeld) {
								// The bound A execution now refuses postflight before its transport starts.
								// Keep the response held without declaring an unreachable postflight pack.
								world.systemOne.enterPhase(`${label}-held-final-response`, {});
								reached.release();
							} else holdStage();
						} else if (!stageSettled && (!late || lateEdit))
							world.systemOne.enterPhase(`${label}-stage-postflight`, postflight);
					},
				};
				if (lateEdit)
					world.provider.enqueueTrack(`${label}-original-response`, "root", () => !stageSettled, {
						...stageReply,
						optional: true,
					});
				else world.provider.enqueue("root", stageReply);
				pending = session.prompt(`Inspect the ${label} boundary.`, {
					internalContextType: "stage-replacement-control",
					goalExecutionId: session.getGoalStateSnapshot()?.goalId,
					processSlashCommands: false,
					autoContinueGoal: false,
				});
				await withDeadline(
					world.trace,
					`${label}: real ${providerHeld ? "final provider response" : stage} held`,
					reached.promise,
				);
				const requestsAtHeld = world.provider.requests.length;
				const projectionAtHeld = projection;
				if (stage === "postflight") {
					expect(requestsAtHeld - requestsBeforeStage, `${label}: read and final reply precede postflight`).toBe(
						2,
					);
					expect(
						durableReplies(stageAnswer),
						`${label}: original response is durable before replacement`,
					).toHaveLength(providerHeld ? 0 : 1);
				}
				const entriesAtHeld = manager.getBranch().length;
				const goalBeforeChange = session.getGoalStateSnapshot();
				if (late) changeGoal();
				const goalAtRelease = session.getGoalStateSnapshot();
				// Distinct-goal supersession interrupts before later provider work. A same-goal edit may
				// retain its admitted response; that response installs its normal postflight only when reached.
				if (!providerHeld) world.systemOne.enterPhase(`${label}-released-stage`, {});
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
				if (lateEdit) {
					await withDeadline(
						world.trace,
						`${label}: original response producer joins`,
						world.provider.waitForProducers(),
					);
					world.provider.retireOptional(`${label}-original-response`);
				}
				const goalAfterStage = session.getGoalStateSnapshot();
				const stageProviderRequests = world.provider.requests.length - requestsAtHeld;
				const stageMessages = manager
					.getBranch()
					.slice(entriesAtHeld)
					.filter((entry) => entry.type === "message");
				const unmatchedUsageWarning = `Goal usage cursor is no longer resolvable for '${label}-a'; 24 pending tokens and $0.000000 pending spend could not be attributed and were dropped.`;
				const stageWarnings = world.warnings.slice(warningsBeforeStage);
				const unmatchedUsageWarnings = providerHeld
					? stageWarnings.filter((message) => message === unmatchedUsageWarning)
					: [];
				// Classify only this exact paid A-response disclosure. Every unrelated warning remains
				// in the world's strict terminal warning check.
				if (providerHeld)
					for (let index = world.warnings.length - 1; index >= warningsBeforeStage; index--)
						if (world.warnings[index] === unmatchedUsageWarning) world.warnings.splice(index, 1);
				if (accepted) changeGoal();
				const beforeNext = world.provider.requests.length;
				world.systemOne.enterPhase(
					`${label}-next-route`,
					late
						? Object.fromEntries(
								Object.entries(judgments.replacement).filter(
									([id]) =>
										!sameIdEdit ||
										![
											"objective_coherent",
											"ambiguity_severity",
											"missing_information",
											"acceptance_complete",
											"grounding_sufficient",
										].includes(id),
								),
							)
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
											].includes(id) &&
											ordering !== "same-a" &&
											!sameIdEdit,
									),
								),
							},
				);
				// A preflight refusal leaves the potential answer queued for B. Postflight already consumed
				// its distinct original answer, so B receives its own response after the held judgment settles.
				// A same-ID edit retires its independent optional original response before this required one.
				if (late && (stage === "postflight" || stageProviderRequests > 0 || lateEdit))
					world.provider.enqueue("root", {
						...text(`${label}-next-answer`, nextAnswer),
						check: (request) => {
							if (lateEdit) expect(JSON.stringify(request.context)).toContain(bWords);
						},
					});
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
					projectionAtHeld,
					observedGoalId,
					goalBeforeChange,
					goalAtRelease,
					goalAfterStage,
					stageOutcome,
					stageProviderRequests,
					stageMessages,
					stageWarnings,
					unmatchedUsageWarnings,
					originalResponse: durableReplies(stageAnswer),
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
				if (providerHeld) {
					expect(projectionAtHeld, observations).toBe("");
					expect(projection, observations).toBe("");
					expect(observedGoalId, observations).toBeUndefined();
					expect(durableReplies(stageAnswer), observations).toMatchObject([
						{ message: { usage: { totalTokens: 24 } } },
					]);
					expect(unmatchedUsageWarnings, observations).toEqual([unmatchedUsageWarning]);
				}
				// Already accepted guidance remains valid. Pending guidance must still match the objective it observed.
				expect(session.objectiveExecutionController?.getLastRoute()?.route, observations).toBe(
					late ? "implement" : "blocked_external",
				);
				expect(session.objectiveExecutionController?.getLastRoute()?.objective_id, observations).toBe(
					goalObjectiveId(`${label}-${ordering === "same-a" || sameIdEdit ? "a" : "b"}`),
				);
				const reasons = session.objectiveExecutionController?.getLastRoute()?.reason_codes ?? [];
				const blockedReason =
					stage === "preflight" ? "system_one_preflight_block" : "system_one_postflight_blocked";
				if (late) expect(reasons, observations).not.toContain(blockedReason);
				else expect(reasons, observations).toContain(blockedReason);
				expect(next.submitted, observations).toBe(late);
				expect(world.provider.requests.length - beforeNext, observations).toBe(late ? 1 : 0);
				if (late && !lateEdit) {
					expect(stageError, observations).toBeInstanceOf(ObjectiveExecutionInterruptedError);
					if (stageError instanceof ObjectiveExecutionInterruptedError)
						expect(stageError.reason, observations).toBe("goal_replaced");
					expect(stageProviderRequests, observations).toBe(0);
					expect(goalAfterStage, observations).toEqual(goalAtRelease);
					expect(durableReplies(nextAnswer), observations).toHaveLength(1);
				}
				if (sameIdEdit) {
					expect(session.getGoalStateSnapshot(), observations).toMatchObject({
						goalId: `${label}-a`,
						userGoal: bWords,
					});
				}
				if (lateEdit) {
					expect(goalAtRelease?.goalId, observations).toBe(goalBeforeChange?.goalId);
					expect(goalAtRelease?.userGoal, observations).toBe(bWords);
					expect(goalBeforeChange?.userGoal, observations).toBe(aWords);
					expect(goalAtRelease?.progressRevision, observations).toBe(
						(goalBeforeChange?.progressRevision ?? 0) + 1,
					);
					expect([0, 1], observations).toContain(stageProviderRequests);
					expect(durableReplies(stageAnswer), observations).toHaveLength(stageProviderRequests);
					if (stageError !== undefined)
						expect(stageError, observations).toBeInstanceOf(ObjectiveExecutionInterruptedError);
					expect(goalAfterStage, observations).toMatchObject({
						goalId: `${label}-a`,
						userGoal: bWords,
						status: "active",
						progressRevision: goalAtRelease?.progressRevision,
						tokensUsed: (goalAtRelease?.tokensUsed ?? 0) + stageProviderRequests * 24,
					});
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
