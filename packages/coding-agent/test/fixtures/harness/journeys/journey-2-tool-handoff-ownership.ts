import { expect } from "vitest";
import {
	type BackgroundToolTaskRecord,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "../../../../src/core/background-tool-task-controller.ts";
import { cancelPersistedGoal, replaceGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState, type GoalState } from "../../../../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../../../../src/core/goals/goal-tool-core.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";
import { handoffFor, latestBatchResults, requestTexts } from "./shared.ts";

/** Observe physical invocation ownership separately from a later background scheduling boundary. */
export async function verifyToolHandoffOwnership(
	world: HarnessWorld,
	turnJudgments: Readonly<Record<string, ScriptedJudgment>>,
): Promise<void> {
	for (const variant of ["clock-a", "clock-unbound-a", "manual-a", "adopt-b", "replace-b"] as const) {
		const label = `tool-handoff-origin-${variant}`;
		const callId = `${label}-call`;
		const command = `node ${label}`;
		const marker = `Physical output for ${label}.`;
		const agentDir = `${world.agentDir}-${label}`;
		const manager = world.createSessionManager(agentDir);
		const physical = createBarrier();
		const release = createBarrier();
		const handedOff = createBarrier();
		const delivered = createBarrier();
		const errors: string[] = [];
		let armed = false;
		let taskId: string | undefined;
		let startEpoch: number | undefined;
		let handoffEpoch: number | undefined;
		let goalAtPhysicalStart: string | undefined;
		let goalAfterOwnerAction: string | undefined;
		let terminalContent = "";
		let terminalCount = 0;
		let terminalProviderPayloads = 0;
		let potentialProviderGoal: string | undefined;
		const stageIds = ["step_relevant", "evidence_sufficient_to_act", "unsupported_assumption_present", "route"];
		const postIds = [
			"action_accomplished_step",
			"conclusions_supported",
			"scope_violation",
			"unrelated_behavior_change",
			"replan_required",
			"next_status",
		];
		const preflight = {
			...Object.fromEntries(Object.entries(turnJudgments).filter(([id]) => stageIds.includes(id))),
			route: { kind: "choice", choice: "reason", confidence: 0.97 },
			// The actual foreground bash calls are judged in this phase after preflight.
			// Their scripted local output has no external effect, and the internal prompt records no owner request.
			leaves_machine: { kind: "noul", probability: 0.02 },
			cannot_be_undone: { kind: "noul", probability: 0.02 },
			touches_outside_task: { kind: "noul", probability: 0.02 },
			acquires_external_code: { kind: "noul", probability: 0.02 },
			request_authorizes: { kind: "noul", probability: 0.02 },
		} as const;
		const postflight = Object.fromEntries(Object.entries(turnJudgments).filter(([id]) => postIds.includes(id)));
		const { session, settingsManager } = await world.createRootSession("root", {
			agentDir,
			sessionManager: manager,
			settings: {
				memorySystem: "okf",
				autoLearn: { enabled: false },
				backgroundTool: { callAfterMs: variant === "manual-a" ? 0 : 1_000 },
			},
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						if (!armed) return;
						armed = false;
						world.systemOne.enterPhase(`${label}-preflight`, preflight);
					});
				},
			],
		});
		const record = () =>
			loadBackgroundToolTaskRecordsNewestFirst(manager).find(
				(value): value is BackgroundToolTaskRecord => isRecordObject(value) && value.toolCallId === callId,
			);
		const counters = (goal: GoalState | undefined) =>
			goal && {
				goalId: goal.goalId,
				status: goal.status,
				tokensUsed: goal.tokensUsed,
				continuationSpendUsd: goal.continuationSpendUsd,
				continuationTurnsUsed: goal.continuationTurnsUsed,
				progressRevision: goal.progressRevision,
				stallTurns: goal.stallTurns,
			};
		let boundary = "session-created";
		let reported = false;
		const diagnostic: Record<string, unknown> = {};
		const report = (failure?: unknown): string => {
			const receipt = record();
			const essential = {
				variant,
				explicitExecutionGoal: variant !== "clock-unbound-a",
				systemOneEnabled: world.systemOne.enabled,
				executionLoopMode: session.executionLoopMode,
				boundary,
				goalAtPhysicalStart,
				goalAfterOwnerAction,
				startEpoch,
				handoffEpoch,
				goalNow: counters(session.getGoalStateSnapshot()),
				taskId,
				terminalCount,
				terminalRecord: receipt && { ...receipt, output: receipt.output.slice(0, 512) },
				callAfterMs: settingsManager.getBackgroundToolSettings().callAfterMs,
				failure: failure === undefined ? undefined : String(failure).slice(0, 512),
			};
			const serialized = JSON.stringify({ ...essential, ...diagnostic });
			const bytes = Buffer.byteLength(serialized, "utf8");
			const output = bytes <= 7_680 ? serialized : JSON.stringify({ ...essential, oversizedReportBytes: bytes });
			console.info(`TOOL_HANDOFF_OWNERSHIP ${output}`);
			reported = true;
			expect(bytes, output).toBeLessThanOrEqual(7_680);
			return output;
		};
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "background_tools") {
				const running = event.tasks.find((task) => task.toolCallId === callId);
				if (!running) return;
				taskId = running.taskId;
				handoffEpoch = session.getForegroundActivity().epoch;
				boundary = "background-running";
				handedOff.release();
			}
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "background-tool-completion" &&
				typeof event.message.content === "string" &&
				taskId &&
				event.message.content.includes(`- ${taskId}:`)
			) {
				terminalContent = event.message.content;
				terminalCount++;
				boundary = "terminal-message-event";
				delivered.release();
			}
		});
		let pending: Promise<string> | undefined;
		const failures: unknown[] = [];
		try {
			await session.bindExtensions({ uiContext: world.humanInput.ui, onError: (error) => errors.push(error.error) });
			session.saveGoalStateSnapshot(
				createGoalState({
					goalId: `${label}-a`,
					userGoal: "Inspect the original source boundary.",
					tokenBudget: 100_000,
					now: new Date().toISOString(),
				}),
			);
			world.systemOne.enterPhase(`${label}-baseline`, {
				...turnJudgments,
				route: { kind: "choice", choice: "reason", confidence: 0.97 },
			});
			world.provider.enqueue("root", text(`${label}-baseline`, "The original boundary remains under inspection."));
			expect(
				(await withDeadline(world.trace, `${label}: baseline`, session.continueGoalOnce({ maxStallTurns: 3 })))
					.submitted,
			).toBe(true);
			await withDeadline(world.trace, `${label}: baseline idle`, session.waitForForegroundIdle());
			const beforeShell = world.shell.requests.length;
			world.shell.enqueue({
				name: `${label}-physical`,
				command,
				output: `${marker}\n`,
				exitCode: 0,
				gate: release.promise,
				check: () => {
					goalAtPhysicalStart = session.getGoalStateSnapshot()?.goalId;
					startEpoch = session.getForegroundActivity().epoch;
					boundary = "physical-executor-started";
					expect(goalAtPhysicalStart).toBe(`${label}-a`);
					expect(startEpoch).toBeDefined();
					expect(record(), `${label}: physical body starts before task handoff`).toBeUndefined();
					const now = new Date().toISOString();
					if (variant === "adopt-b") {
						const cancelled = cancelPersistedGoal(session, now);
						if (!cancelled.ok) throw new Error(cancelled.error);
						const started = applyGoalAction(
							cancelled.state,
							{
								action: "start",
								goalId: `${label}-b`,
								userGoal: "Inspect the successor source boundary.",
								tokenBudget: 100_000,
							},
							now,
						);
						if (!started.ok) throw new Error(started.error);
						session.saveGoalStateSnapshot(started.state);
					} else if (variant === "replace-b") {
						const replaced = replaceGoal(
							{
								goalId: `${label}-b`,
								userGoal: "Inspect the replacement source boundary.",
								tokenBudget: 100_000,
							},
							now,
						);
						if (!replaced.ok) throw new Error(replaced.error);
						session.saveGoalStateSnapshot(replaced.state);
					}
					goalAfterOwnerAction = session.getGoalStateSnapshot()?.goalId;
					physical.release();
				},
			});
			world.systemOne.enterPhase(`${label}-before-tool`, {});
			armed = true;
			world.provider.enqueue(
				"root",
				calls(`${label}-start`, [{ id: callId, name: "bash", arguments: { command, background: false } }]),
			);
			if (variant !== "replace-b")
				world.provider.enqueue("root", {
					...text(`${label}-closing`, "The operation remains active."),
					check: (request) => {
						expect(latestBatchResults(request).find((result) => result.toolName === "bash")?.text).toContain(
							taskId,
						);
						world.systemOne.enterPhase(`${label}-postflight`, postflight);
					},
				});
			pending = session
				.prompt("Inspect the current source boundary.", {
					internalContextType: "tool-origin-control",
					...(variant === "clock-unbound-a" ? {} : { goalExecutionId: `${label}-a` }),
					processSlashCommands: false,
					autoContinueGoal: false,
				})
				.then(
					() => "resolved",
					(error: unknown) => (error instanceof Error ? error.message : String(error)),
				);
			await withDeadline(world.trace, `${label}: physical invocation started`, physical.promise);
			if (variant === "manual-a") expect(session.backgroundRunningToolCalls(callId)).toBe(1);
			await withDeadline(world.trace, `${label}: actual handoff`, handedOff.promise);
			const runningRecord = record();
			const originalOutcome = await withDeadline(world.trace, `${label}: original submission settles`, pending);
			await withDeadline(
				world.trace,
				`${label}: original submission physically releases`,
				session.waitForForegroundIdle(),
			);
			const activityBeforeTerminal = session.getForegroundActivity();
			boundary = "original-submission-released";
			const goalBeforeTerminal = session.getGoalStateSnapshot();
			const beforeTerminalRequests = world.provider.requests.length;
			const beforeTerminalEntries = manager.getBranch().length;
			const parentAnswer = "The source boundary remains under inspection.";
			world.systemOne.enterPhase(`${label}-terminal`, {});
			world.provider.enqueue("root", {
				...text(`${label}-potential-parent`, parentAnswer),
				check: (request) => {
					if (taskId === undefined) throw new Error(`${label}: terminal request has no task identity`);
					expect(handoffFor(request, taskId), `${label}: actual provider reads the task terminal`).toBe(true);
					expect(
						requestTexts(request).some((value) => value.includes(marker)),
						`${label}: actual provider receives physical output`,
					).toBe(true);
					terminalProviderPayloads++;
					potentialProviderGoal = session.getGoalStateSnapshot()?.goalId;
				},
			});
			release.release();
			await withDeadline(world.trace, `${label}: durable terminal message`, delivered.promise);
			await withDeadline(world.trace, `${label}: terminal foreground settles`, session.waitForForegroundIdle());
			const automaticRequests = world.provider.requests.length - beforeTerminalRequests;
			const goalAfterTerminal = session.getGoalStateSnapshot();
			const terminalMessages = manager
				.getBranch()
				.slice(beforeTerminalEntries)
				.filter((entry) => entry.type === "message" || entry.type === "custom_message");
			Object.assign(diagnostic, {
				runningRecord,
				originalOutcome,
				activityBeforeTerminal,
				goalBeforeTerminal: counters(goalBeforeTerminal),
				goalAfterTerminal: counters(goalAfterTerminal),
				automaticRequests,
				terminalContent,
				terminalMessageCount: terminalMessages.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "background-tool-completion",
				).length,
				terminalAssistantCount: terminalMessages.filter(
					(entry) => entry.type === "message" && entry.message.role === "assistant",
				).length,
			});
			let explicitBSubmitted: boolean | undefined;
			if (variant === "replace-b") {
				// A's terminal is durable evidence; only explicit input may begin work charged to B.
				expect(automaticRequests, report()).toBe(0);
				expect(terminalProviderPayloads).toBe(0);
				expect(diagnostic.terminalAssistantCount).toBe(0);
				expect(counters(goalAfterTerminal)).toEqual(counters(goalBeforeTerminal));
				world.systemOne.enterPhase(`${label}-explicit-b`, {
					...turnJudgments,
					route: { kind: "choice", choice: "reason", confidence: 0.97 },
				});
				const beforeExplicitRequests = world.provider.requests.length;
				explicitBSubmitted = (
					await withDeadline(
						world.trace,
						`${label}: explicit B control`,
						session.continueGoalOnce({ maxStallTurns: 3 }),
					)
				).submitted;
				await withDeadline(world.trace, `${label}: explicit B idle`, session.waitForForegroundIdle());
				Object.assign(diagnostic, {
					explicitBRequests: world.provider.requests.length - beforeExplicitRequests,
					goalAfterExplicitB: counters(session.getGoalStateSnapshot()),
				});
				expect(diagnostic.explicitBRequests).toBe(1);
				expect(session.getGoalStateSnapshot()?.goalId).toBe(`${label}-b`);
				expect((session.getGoalStateSnapshot()?.tokensUsed ?? 0) - (goalAfterTerminal?.tokensUsed ?? 0)).toBe(24);
			}
			const terminalRecord = record();
			const resources = session.getResourceSnapshot();
			const originalCalls = manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((part) => part.type === "toolCall" && part.id === callId),
				);
			const handoffStubs = manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === callId,
				);
			boundary = "all-controls-collected";
			Object.assign(diagnostic, {
				originalCallCount: originalCalls.length,
				handoffStubCount: handoffStubs.length,
				explicitBSubmitted,
				terminalProviderPayloads,
				potentialProviderGoal,
				physicalExecutions: resources.backgroundToolTasks.physicalExecutions,
				shellRequests: world.shell.requests
					.slice(beforeShell)
					.map(({ sequence, command, cwd, detached }) => ({ sequence, command, cwd, detached })),
				errors,
			});
			const observations = report();
			const expectedTaskGoal = `${label}-${variant === "adopt-b" ? "b" : "a"}`;
			expect(handoffEpoch, observations).toBe(startEpoch);
			expect(activityBeforeTerminal.busy, observations).toBe(false);
			expect(originalCalls, observations).toHaveLength(1);
			expect(handoffStubs, observations).toHaveLength(1);
			expect(runningRecord, observations).toMatchObject({
				taskId,
				toolCallId: callId,
				status: "running",
				goalId: expectedTaskGoal,
			});
			expect(terminalRecord, observations).toMatchObject({
				taskId,
				toolCallId: callId,
				status: "completed",
				terminalDelivery: "delivered",
				goalId: expectedTaskGoal,
			});
			expect(terminalRecord?.output, observations).toContain(marker);
			expect(terminalRecord?.piToolInvocation?.requestId, observations).toBe(
				runningRecord?.piToolInvocation?.requestId,
			);
			expect(terminalRecord?.executionContext, observations).toEqual(runningRecord?.executionContext);
			expect(terminalContent, observations).toContain(marker);
			expect(terminalCount, observations).toBe(1);
			expect(terminalProviderPayloads, observations).toBe(1);
			expect(potentialProviderGoal, observations).toBe(
				`${label}-${variant === "adopt-b" || variant === "replace-b" ? "b" : "a"}`,
			);
			expect(diagnostic.terminalMessageCount, observations).toBe(1);
			expect(resources.backgroundToolTasks.physicalExecutions, observations).toBe(0);
			expect(world.shell.requests.slice(beforeShell), observations).toHaveLength(1);
			expect(errors, observations).toEqual([]);
			if (variant === "replace-b") expect(explicitBSubmitted, observations).toBe(true);
			else {
				expect(originalOutcome, observations).toBe("resolved");
				expect(automaticRequests, observations).toBe(1);
				expect(diagnostic.terminalAssistantCount, observations).toBe(1);
				expect((goalAfterTerminal?.tokensUsed ?? 0) - (goalBeforeTerminal?.tokensUsed ?? 0), observations).toBe(24);
			}
		} catch (error) {
			failures.push(error);
			if (!reported)
				try {
					report(error);
				} catch (reportError) {
					failures.push(reportError);
				}
		} finally {
			release.release();
			if (pending)
				await withDeadline(world.trace, `${label}: original run joined`, pending).catch((error: unknown) =>
					failures.push(error),
				);
			try {
				expect(await world.disposeSessionInBody(session)).toBeUndefined();
			} catch (error) {
				failures.push(error);
			} finally {
				if (terminalCount > 0) {
					const finalMessages = manager
						.getBranch()
						.filter(
							(entry) =>
								entry.type === "custom_message" &&
								entry.customType === "background-tool-completion" &&
								typeof entry.content === "string" &&
								taskId &&
								entry.content.includes(`- ${taskId}:`),
						);
					const cleanup = JSON.stringify({
						variant,
						terminalCount,
						durableTerminalMessages: finalMessages.length,
						physicalExecutions: session.getResourceSnapshot().backgroundToolTasks.physicalExecutions,
					});
					console.info(`TOOL_HANDOFF_OWNERSHIP_CLEANUP ${cleanup}`);
					try {
						expect(Buffer.byteLength(cleanup, "utf8")).toBeLessThanOrEqual(512);
						expect(terminalCount, cleanup).toBe(1);
						expect(finalMessages, cleanup).toHaveLength(1);
					} catch (error) {
						failures.push(error);
					}
				}
				unsubscribe();
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, `${label}: diagnostic and cleanup failures`);
		world.trace.mark("root", label);
	}
}
