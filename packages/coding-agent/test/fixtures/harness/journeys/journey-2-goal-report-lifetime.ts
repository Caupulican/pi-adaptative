import { expect } from "vitest";
import { editPersistedGoal, replaceGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import type { GoalState } from "../../../../src/core/goals/goal-state.ts";
import { getLatestGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { scriptRequirementCheckSpawn } from "./journey-9-shared.ts";
import { expectOwnerWords, ICM_INTAKE_JUDGMENTS, LIMITS_PATH, latestBatchResults } from "./shared.ts";

const COMMAND = `rg MAX_RETRIES ${LIMITS_PATH}`;
const OBJECTIVE = `Run ${JSON.stringify(COMMAND)} and require exit code 0. Output must contain "MAX_RETRIES".`;

/** A checked completion keeps its saved proof when the submission's final report loses custody. */
export async function verifyGoalReportLifetime(world: HarnessWorld): Promise<void> {
	for (const interruption of ["abort", "replace", "amend"] as const) {
		const label = `goal-report-${interruption}`;
		const manager = world.createSessionManager(`${world.agentDir}-${label}`);
		// Admission and acceptance use the owner's exact check contract in both journey profiles.
		const { session } = await world.createRootSession("root", {
			agentDir: `${world.agentDir}-${label}`,
			sessionManager: manager,
			settings: {
				memorySystem: "okf",
				autoLearn: { enabled: false },
				autonomy: { goalAutoContinueDelayMs: 60_000 },
			},
		});
		const originalPlan = session.agent.planContext;
		const originalAdmission = session.agent.admitProviderRequest;
		let replayReportAdmission: (() => Promise<unknown>) | undefined;
		let reportPreparations = 0;
		if (interruption === "abort") {
			if (!originalPlan || !originalAdmission)
				throw new Error("The report requires the foreground request planner and admission.");
			session.agent.admitProviderRequest = (request, signal) => {
				if (request.sourceContext.committedToolReport)
					replayReportAdmission = async () => originalAdmission(request, signal);
				return originalAdmission(request, signal);
			};
			session.agent.planContext = async (...args) => {
				const plan = await originalPlan(...args);
				if (session.getGoalStateSnapshot()?.status !== "completed") return plan;
				return {
					...plan,
					prepareCommit: () => {
						if (reportPreparations++ === 0) return false;
						return plan.prepareCommit?.() ?? true;
					},
				};
			};
		}
		const reached = createBarrier();
		const release = createBarrier();
		const source = String(world.io.readFileSync(LIMITS_PATH, "utf8"));
		const shellMark = world.shell.requests.length;
		const requestMark = world.provider.requests.length;
		const staleText = `${label}: this completion report lost its submission.`;
		let completed: GoalState | undefined;
		let completedHead: string | undefined;
		let prompt: Promise<void> | undefined;
		const scriptedCheck = scriptRequirementCheckSpawn(world, COMMAND);
		world.systemOne.enterPhase(
			label,
			{
				...ICM_INTAKE_JUDGMENTS,
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				outcomes_achieved: { kind: "noul", probability: 0.97 },
				required_behavior_unverified: { kind: "noul", probability: 0.02 },
				material_claim_unsupported: { kind: "noul", probability: 0.02 },
				missing_requirement: { kind: "noul", probability: 0.02 },
			},
			{
				expect: (request) => {
					expectOwnerWords({
						sessionManager: () => manager,
						userRequests: [OBJECTIVE, "Confirm this turn is available."],
						optionalToolNames: ["secret_store"],
					})(request);
					if (!("outcomes_achieved" in request.questions)) return;
					if (!isRecordObject(request.state)) throw new Error(`${label}: completion projection has no state`);
					expect(
						request.state.acceptance_matrix,
						`${label}: completion judges the exact owner check`,
					).toMatchObject([{ text: OBJECTIVE, required: true }]);
					expect(request.state.evidence, `${label}: completion sees the observed source output`).toEqual(
						expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(source.trim()) })]),
					);
				},
			},
		);
		world.shell.enqueue({ name: `${label}-check`, command: COMMAND, output: source, exitCode: 0 });
		const assertGoalCall = (request: Parameters<typeof latestBatchResults>[0]) => {
			const result = latestBatchResults(request).find((item) => item.toolName === "goal");
			expect(result?.isError, `${label}: ${result?.text ?? "no goal result"}`).toBe(false);
		};
		world.provider.enqueue(
			"root",
			calls(`${label}-start`, [
				{ id: `${label}-start`, name: "goal", arguments: { action: "start", goalId: label, userGoal: OBJECTIVE } },
			]),
			{
				...calls(`${label}-requirement`, [
					{
						id: `${label}-requirement`,
						name: "goal",
						arguments: {
							action: "add_requirement",
							text: OBJECTIVE,
							check: { command: COMMAND, outputContains: "MAX_RETRIES" },
						},
					},
				]),
				check: assertGoalCall,
			},
			{
				...calls(`${label}-source`, [
					{
						id: `${label}-source`,
						name: "goal",
						arguments: {
							action: "add_evidence",
							kind: "file",
							uri: LIMITS_PATH,
							summary: "The source file is present.",
						},
					},
				]),
				check: assertGoalCall,
			},
			{
				...calls(`${label}-complete`, [
					{
						id: `${label}-complete`,
						name: "goal",
						arguments: { action: "complete", account: { changes: [], assumptions: [], regressions: [] } },
					},
				]),
				check: assertGoalCall,
			},
			{
				name: `${label}-held-report`,
				gate: release.promise,
				ignoresAbort: true,
				check: (request) => {
					assertGoalCall(request);
					expect(request.context.tools ?? [], `${label}: the final provider request exposes no tools`).toEqual([]);
					completed = session.getGoalStateSnapshot();
					completedHead = manager.getLeafId() ?? undefined;
					expect(completed).toMatchObject({ goalId: label, status: "completed" });
					expect(completed?.requirements).toHaveLength(1);
					expect(completed?.requirements[0]).toMatchObject({ status: "satisfied", proofKey: expect.any(String) });
					expect(
						completed?.evidence.some(
							(item) => item.kind === "check" && item.verified && item.outcome === "succeeded",
						),
					).toBe(true);
					reached.release();
				},
				reply: { content: [{ type: "text", text: staleText }] },
			},
		);
		try {
			prompt = session.prompt(OBJECTIVE, { autoContinueGoal: false });
			await withDeadline(
				world.trace,
				`${label}: checked completion reaches its final provider request`,
				Promise.race([
					reached.promise,
					prompt.then(() => {
						throw new Error(`${label}: the submission ended before its report request`);
					}),
				]),
			);
			if (!completed || !completedHead) throw new Error(`${label}: the completed journal head is missing`);
			const pinnedHead = completedHead;
			const judgmentMark = world.systemOne.decoded.length;
			const readSavedProof = () =>
				getLatestGoalStateSnapshot({
					getLatestCustomEntryOnBranch: (type, from) =>
						manager.getLatestCustomEntryOnBranch(type, from ?? pinnedHead),
				});
			expect(readSavedProof()).toEqual(completed);
			let cancellation: Promise<void> | undefined;
			if (interruption === "abort") {
				if (!replayReportAdmission) throw new Error("The dispatched report did not pass through goal admission.");
				await expect(
					replayReportAdmission(),
					"the dispatched receipt cannot authorize another report",
				).rejects.toThrow("goal_execution_not_active");
				cancellation = session.abort(`${label}: owner cancelled the report`);
			} else if (interruption === "replace") {
				const replacement = replaceGoal(
					{ goalId: `${label}-next`, userGoal: "Inspect the next source boundary." },
					new Date().toISOString(),
				);
				if (!replacement.ok) throw new Error(replacement.error);
				session.saveGoalStateSnapshot(replacement.state);
			} else {
				const amended = editPersistedGoal(session, { userGoal: `${OBJECTIVE} Also inspect the source filename.` });
				if (!amended.ok) throw new Error(amended.error);
				expect(amended.state).toMatchObject({
					goalId: label,
					status: "active",
					ownerCorrection: { objective: `${OBJECTIVE} Also inspect the source filename.` },
				});
			}
			release.release();
			if (cancellation) await withDeadline(world.trace, `${label}: cancellation settles`, cancellation);
			await withDeadline(world.trace, `${label}: original submission settles`, prompt);
			await withDeadline(world.trace, `${label}: foreground custody is released`, session.waitForForegroundIdle());
			if (interruption === "amend")
				expect(
					world.systemOne.decoded.slice(judgmentMark),
					`${label}: the obsolete submission makes no claim or postflight judgment against the owner's correction`,
				).toEqual([]);
			expect(readSavedProof(), `${label}: the checked completion remains intact in its original journal`).toEqual(
				completed,
			);
			const current = session.getGoalStateSnapshot();
			if (interruption === "abort")
				expect(current, `${label}: report cancellation leaves the checked goal completed`).toMatchObject({
					goalId: label,
					status: "completed",
					requirements: completed.requirements,
					evidence: completed.evidence,
				});
			else if (interruption === "replace")
				expect(current, `${label}: the old report cannot overwrite the replacement`).toMatchObject({
					goalId: `${label}-next`,
					status: "active",
				});
			else
				expect(current, `${label}: the old report cannot settle the owner's correction`).toMatchObject({
					goalId: label,
					status: "active",
					ownerCorrection: { objective: `${OBJECTIVE} Also inspect the source filename.` },
					evidence: completed.evidence,
				});
			const staleReplies = session.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.flatMap((part) =>
							part.type === "text" && part.text.includes(staleText) ? [part.text] : [],
						)
					: [],
			);
			expect(staleReplies, `${label}: stale report text never reaches the session`).toEqual([]);
			const persistedReplies = manager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant"
						? entry.message.content.flatMap((part) =>
								part.type === "text" && part.text.includes(staleText) ? [part.text] : [],
							)
						: [],
				);
			expect(persistedReplies, `${label}: the journal contains no stale final report`).toEqual([]);
			expect(
				world.shell.requests.slice(shellMark).map((request) => request.command),
				`${label}: completion executes only its admitted check`,
			).toEqual([COMMAND]);
			expect(world.io.readFileSync(LIMITS_PATH, "utf8"), `${label}: reporting changes no source`).toBe(source);
			expect(
				world.provider.requests.slice(requestMark),
				`${label}: one final report follows the four goal calls`,
			).toHaveLength(5);
			if (interruption === "abort")
				expect(
					reportPreparations,
					"a stale plan spends no report dispatch before its replacement is accepted",
				).toBe(2);
			const answer = `${label}: the next owner turn is available.`;
			world.provider.enqueue("root", {
				name: `${label}-next-owner`,
				reply: { content: [{ type: "text", text: answer }] },
			});
			await withDeadline(
				world.trace,
				`${label}: next owner submission`,
				session.prompt("Confirm this turn is available.", { autoContinueGoal: false }),
			);
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: answer }],
			});
			expect(readSavedProof(), `${label}: a later owner turn preserves the finished proof`).toEqual(completed);
		} finally {
			session.agent.planContext = originalPlan;
			session.agent.admitProviderRequest = originalAdmission;
			release.release();
			if (prompt) await prompt.catch(() => {});
			scriptedCheck.restore();
			expect(
				await world.disposeSessionInBody(session),
				`${label}: the report owner disposes cleanly`,
			).toBeUndefined();
		}
	}
	world.trace.mark("root", "goal-report-lifetime");
}
