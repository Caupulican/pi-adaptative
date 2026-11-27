import { describe, expect, it } from "vitest";
import { projectRequirementRollup } from "../src/core/delegation/requirement-rollup.ts";
import {
	getTrustedRequirementEvidence,
	requirementKey,
	requirementProofKey,
} from "../src/core/goals/goal-acceptance.ts";
import { evaluateGoalContinuation } from "../src/core/goals/goal-continuation-controller.ts";
import { getGoalStateRevision, matchesGoalStateRevision } from "../src/core/goals/goal-lifecycle.ts";
import { settleObjectiveTerminal } from "../src/core/goals/goal-objective-terminal.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";
import { admitGoalWork } from "../src/core/goals/goal-work-admission.ts";
import { proveRequirementChecks } from "../src/core/goals/prove-requirement-checks.ts";
import { goalEvidenceObservation, reviewGoalCoverage } from "../src/core/goals/requirement-coverage.ts";
import { matchesRequirementBinding, projectRunnableRequirements } from "../src/core/goals/requirement-dependencies.ts";
import { GoalExecutionCustody } from "../src/core/objective-execution/current-objective-execution.ts";
import { goalObjectiveId } from "../src/core/orchestration/work-state-projection.ts";
import { createGoalToolDefinition } from "../src/core/tools/goal.ts";

const now = "2026-11-26T12:00:00.000Z";
function goal() {
	return createGoalState({ goalId: "validation", userGoal: "Validate recovery", now });
}

describe("requirement coverage admission", () => {
	it("keeps an independent task verdict from covering an unproven second criterion", () => {
		const coverage = projectRequirementRollup([
			{
				attemptId: "attempt",
				laneId: "worker",
				requirementIds: ["artifact", "live"],
				verificationAccepted: true,
				claim: {
					requestId: "worker",
					status: "completed",
					summary: "The manifest exists.",
					parentReviewRequired: false,
					hostVerdict: {
						verdict: "needs_more",
						coveredRequirementIds: ["artifact"],
						missing: ["live"],
						reasonCodes: [],
						at: now,
						judgedBy: "code",
					},
				},
			},
		]);
		expect(coverage.byRequirement.artifact?.evidenceRef?.source).toBe("verification");
		expect(coverage.uncovered).toEqual(["live"]);
	});

	it("preserves an installation receipt while a live requirement stays open", async () => {
		let state = applyGoalEvent(goal(), { type: "add_requirement", id: "artifact", text: "A manifest exists.", now });
		state = applyGoalEvent(state, {
			type: "add_requirement",
			id: "live",
			text: "The running service recovers and stays responsive.",
			now,
		});
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "manifest",
			kind: "file",
			uri: "install.json",
			summary: "Recovery worked.",
			verified: true,
			now,
		});
		const satisfy = { action: "satisfy_requirement" as const, requirementId: "artifact", evidenceIds: ["manifest"] };
		expect(applyGoalAction(state, satisfy, now).ok).toBe(false);
		const proofs = await reviewGoalCoverage(state, satisfy, ["artifact", "live"], now, {
			observe: (item) => goalEvidenceObservation(item, undefined),
			engine: () => ({
				evaluate: async (_program, input) => {
					expect(JSON.stringify(input?.observations)).toContain("install.json");
					expect(JSON.stringify(input?.observations)).not.toContain("Recovery worked.");
					return { answers: { covered_0: { type: "noul", noul: 0.99 }, covered_1: { type: "noul", noul: 0.01 } } };
				},
			}),
		});
		const result = applyGoalAction(state, satisfy, now, { coverageProofs: proofs });
		if (!result.ok) throw new Error(result.error);
		expect(getTrustedRequirementEvidence(result.state, result.state.requirements[0]!).map(({ id }) => id)).toEqual([
			"manifest",
		]);
		expect(
			applyGoalAction(result.state, { ...satisfy, requirementId: "live" }, now, { coverageProofs: proofs }).ok,
		).toBe(false);
		expect(result.state.requirements[1]?.status).toBe("open");
	});

	it("invalidates a check receipt when its requirement check changes", () => {
		const original = applyGoalEvent(goal(), {
			type: "add_requirement",
			id: "live",
			text: "Verify live readiness.",
			check: { command: "read old-status" },
			now,
		});
		const evidence = applyGoalEvent(original, {
			type: "add_evidence",
			id: "old-proof",
			kind: "check",
			requirementKey: requirementKey(original.requirements[0]!),
			verified: true,
			outcome: "succeeded",
			summary: "Old status was live.",
			now,
		});
		const satisfy = { action: "satisfy_requirement" as const, requirementId: "live", evidenceIds: ["old-proof"] };
		const accepted = applyGoalAction(evidence, satisfy, now, {
			coverageProofs: new Set([requirementProofKey(evidence.requirements[0]!, evidence.evidence)]),
		});
		if (!accepted.ok) throw new Error(accepted.error);
		const changed = applyGoalEvent(accepted.state, {
			type: "set_requirement_check",
			id: "live",
			check: { command: "read new-status" },
			now: "2026-11-26T12:01:00.000Z",
		});
		expect(changed.requirements[0]).toMatchObject({ status: "open", evidenceIds: [] });
		expect(applyGoalAction(changed, satisfy, now).ok).toBe(false);
	});
});

it("a final increment reruns a satisfied check and a previous pass cannot supersede a newer failure", async () => {
	let state = applyGoalEvent(goal(), {
		type: "add_requirement",
		id: "live",
		text: "The service responds.",
		check: { command: "read-status" },
		now,
	});
	const save = (next: typeof state) => {
		state = next;
	};
	await proveRequirementChecks({
		state,
		save,
		now: () => now,
		requireVerifiedEvidenceForCompletion: true,
		isCheckCoverageEstablished: () => true,
		runCheck: async () => ({ passed: true, reason: "The service responded.", output: "live", exitCode: 0 }),
	});
	expect(state.requirements[0]?.status).toBe("satisfied");
	const previousPass = state.evidence[0]!;
	const tool = createGoalToolDefinition({
		getGoalState: () => state,
		saveGoalState: save,
		now: () => now,
		admitRequirementCheck: () => undefined,
		runRequirementCheck: async () => ({ passed: false, reason: "The service failed.", output: "", exitCode: 1 }),
	});
	const result = await tool.execute(
		"finish",
		{ action: "increment" },
		undefined,
		undefined,
		{} as Parameters<typeof tool.execute>[4],
	);
	expect(result.isError).toBe(true);
	expect(state.requirements[0]?.status).toBe("open");
	expect(state.evidence.map((e) => e.outcome)).toEqual(["failed"]);
	expect(state.events.flatMap((event) => (event.type === "add_evidence" ? [event.outcome] : []))).toEqual([
		"succeeded",
		"failed",
	]);
	expect(
		applyGoalAction(
			state,
			{ action: "satisfy_requirement", requirementId: "live", evidenceIds: [previousPass.id] },
			now,
			{
				coverageProofs: new Set([requirementProofKey(state.requirements[0]!, [previousPass])]),
			},
		).ok,
	).toBe(false);
});

it.each(["new_failure", "new_pass", "replace_check"] as const)(
	"withdraws every acceptance that consumes a superseded measurement (%s)",
	(change) => {
		let state = goal();
		for (const id of ["probe", "consumer", "dependent", "independent"]) {
			state = applyGoalEvent(state, {
				type: "add_requirement",
				id,
				text: id,
				now,
				...(id === "probe" ? { check: { command: "read-status" } } : {}),
				...(id === "dependent" ? { dependencies: ["consumer"] } : {}),
			});
		}
		const key = requirementKey(state.requirements[0]!);
		state = applyGoalEvent(state, {
			type: "add_evidence",
			kind: "check",
			id: "pass",
			summary: "ready",
			requirementKey: key,
			verified: true,
			outcome: "succeeded",
			now,
		});
		state = applyGoalEvent(state, {
			type: "add_evidence",
			kind: "tool",
			id: "separate",
			summary: "observed",
			verified: true,
			outcome: "succeeded",
			now,
		});
		for (const [id, citation] of [
			["probe", "pass"],
			["consumer", "pass"],
			["independent", "separate"],
		] as const) {
			const requirement = state.requirements.find((r) => r.id === id)!;
			const receipts = state.evidence.filter((e) => e.id === citation);
			const accepted = applyGoalAction(
				state,
				{ action: "satisfy_requirement", requirementId: id, evidenceIds: [citation] },
				now,
				{ coverageProofs: new Set([requirementProofKey(requirement, receipts)]) },
			);
			if (!accepted.ok) throw new Error(accepted.error);
			state = accepted.state;
		}
		expect(projectRunnableRequirements(state.requirements, new Set(), () => false).runnable).toContain("dependent");
		const after = applyGoalEvent(
			state,
			change === "replace_check"
				? { type: "set_requirement_check", id: "probe", check: { command: "read-new-status" }, now }
				: {
						type: "add_evidence",
						kind: "check",
						id: "later",
						summary: "rechecked",
						verified: true,
						requirementKey: key,
						outcome: change === "new_pass" ? "succeeded" : "failed",
						now,
					},
		);
		expect(after.requirements.find((r) => r.id === "consumer")).toMatchObject({ status: "open", evidenceIds: [] });
		expect(after.requirements.find((r) => r.id === "independent")?.status).toBe("satisfied");
		const ready = projectRunnableRequirements(after.requirements, new Set(), () => false).runnable;
		expect(ready).toContain("consumer");
		expect(ready).not.toContain("dependent");
	},
);

it("keeps a retired check definition retired across a same-clock round trip", () => {
	const base = applyGoalEvent(goal(), { type: "add_requirement", id: "r", text: "ready", now });
	const change = (command: string) => ({ type: "set_requirement_check" as const, id: "r", check: { command }, now });
	const first = applyGoalEvent(base, change("A"));
	const repeated = applyGoalEvent(first, change("A"));
	expect(requirementKey(repeated.requirements[0]!)).toBe(requirementKey(first.requirements[0]!));
	const returned = applyGoalEvent(applyGoalEvent(repeated, change("B")), change("A"));
	expect(requirementKey(returned.requirements[0]!)).not.toBe(requirementKey(first.requirements[0]!));
	const legacy = applyGoalEvent(base, change("A"), "legacy");
	expect(legacy.requirements[0]?.definitionRevision).toBeUndefined();
	expect(requirementKey(legacy.requirements[0]!)).not.toBe(requirementKey(first.requirements[0]!));
});

it("a stopped generation stays revoked after resume while accounting leaves current work admitted", () => {
	const custody = new GoalExecutionCustody();
	const original = goal();
	const id = goalObjectiveId(original.goalId);
	const active = custody.signalFor(id, original, true)!;
	const accounted = applyGoalEvent(original, {
		type: "record_continuation_budget",
		turns: 0,
		wallClockMs: 9,
		tokens: 1,
		spendUsd: 0,
		now,
	});
	expect(custody.signalFor(id, accounted, true)).toBe(active);
	const paused = applyGoalEvent(accounted, { type: "pause_goal", now });
	custody.changed(paused);
	expect(active.aborted).toBe(true);
	expect(() => custody.signalFor(id, paused, true)).toThrow();
	const resumed = applyGoalEvent(paused, { type: "resume_goal", source: "owner", now });
	expect(custody.signalFor(id, resumed, true)?.aborted).toBe(false);
});

it.each([true, false])("binds an owner completion decision to the objective shown (amended=%s)", async (amend) => {
	let live = goal();
	await settleObjectiveTerminal(
		{
			getState: () => live,
			saveState: (next) => {
				live = next;
			},
			stopActiveGoal: () => false,
			emitWarning: () => {},
			scheduleGoalAutoContinueFromIdle: () => {},
			resolveCompletionRejection: async () => {
				live = applyGoalEvent(
					live,
					amend
						? { type: "edit_goal", userGoal: "Validate recovery across two replicas.", now }
						: { type: "record_continuation_budget", turns: 0, wallClockMs: 1, tokens: 1, spendUsd: 0, now },
				);
				return { decision: "accept_complete", clarification: [] };
			},
		},
		{ status: "semantic_gate_unavailable", reasonCodes: ["system_one_ambiguous"] },
		live.goalId,
	);
	expect(live.status).toBe(amend ? "active" : "completed");
});

it("parks exhausted review work and its dependents while preserving an independent assignment", () => {
	let state = applyGoalEvent(goal(), { type: "add_requirement", id: "review", text: "Independent review", now });
	state = applyGoalEvent(state, {
		type: "add_requirement",
		id: "deliver",
		text: "Deliver after review",
		dependencies: ["review"],
		now,
	});
	for (let count = 0; count < 3; count++) {
		state = applyGoalEvent(state, {
			type: "block_requirement",
			id: "review",
			blockedReason: "Verification unavailable",
			now,
		});
		state = applyGoalEvent(state, { type: "reopen_requirement", id: "review", now });
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		state = applyGoalEvent(state, {
			type: "executor_refused",
			ids: ["review"],
			definitions: [requirementKey(state.requirements[0]!)],
			reason: "No independent reviewer",
			now,
			retryAt: now,
		});
	}
	expect(evaluateGoalContinuation({ state, settings: { maxStallTurns: 20 }, now }).reasonCode).toBe(
		"executor_admission_exhausted",
	);
	state = applyGoalEvent(state, { type: "add_requirement", id: "stage", text: "Stage the manifest", now });
	expect(projectRunnableRequirements(state.requirements, new Set(), () => false, Date.parse(now)).runnable).toEqual([
		"stage",
	]);
	expect(evaluateGoalContinuation({ state, settings: { maxStallTurns: 20 }, now }).action).toBe("continue");
});

it("a watch for the previous check cannot park its replacement", () => {
	const state = applyGoalEvent(goal(), {
		type: "add_requirement",
		id: "live",
		text: "Check service readiness",
		check: { command: "read-status" },
		now,
	});
	const binding = {
		goalId: state.goalId,
		requirementId: "live",
		definitionKey: requirementKey(state.requirements[0]!),
	};
	expect(matchesRequirementBinding(state, binding)).toBe(true);
	const amended = applyGoalEvent(state, {
		type: "set_requirement_check",
		id: "live",
		check: { command: "read-new-status" },
		now,
	});
	expect(matchesRequirementBinding(amended, binding)).toBe(false);
});

it("a greeting cannot start remembered work and the owner's explicit request can", async () => {
	const owner = (text: string) => ({
		owner: { sourceId: "session/one", entryId: "one", text, chars: text.length, digest: "fixture", createdAt: now },
	});
	const proposal = { objective: "Resume the recovery investigation." };
	expect(await admitGoalWork(proposal, () => owner("hi"), undefined)).toMatch(/greeting/i);
	expect(await admitGoalWork(proposal, () => owner(proposal.objective), undefined)).toBeUndefined();
});

it("refuses a worker with an unmet dependency before invoking either dispatch adapter", async () => {
	let state = applyGoalEvent(goal(), { type: "add_requirement", id: "stage", text: "Stage the build", now });
	state = applyGoalEvent(state, {
		type: "add_requirement",
		id: "review",
		text: "Review the build",
		dependencies: ["stage"],
		now,
	});
	let launches = 0;
	const dispatch = () => {
		launches++;
		return { laneId: "unexpected" };
	};
	const tool = createGoalToolDefinition({
		getGoalState: () => state,
		saveGoalState: (next) => {
			state = next;
		},
		admitRequirementCheck: () => undefined,
		startWorkerDelegation: dispatch,
		dispatchCollaborationWorker: async () => dispatch(),
	});
	const result = await tool.execute(
		"worker",
		{
			action: "dispatch_worker",
			dispatchTarget: "collaboration",
			requirementId: "review",
			instructions: "Review the staged build",
		},
		undefined,
		undefined,
		{} as Parameters<typeof tool.execute>[4],
	);
	expect(result.isError).toBe(true);
	expect(launches).toBe(0);
});

it.each([0.99, 0.01])(
	"reviews the replacement citation before completing a cross-requirement proof (confidence %s)",
	async (confidence) => {
		let state = applyGoalEvent(goal(), {
			type: "add_requirement",
			id: "probe",
			text: "sample readiness",
			check: { command: "read-status" },
			now,
		});
		state = applyGoalEvent(state, { type: "add_requirement", id: "outcome", text: "The service is ready.", now });
		const measure = () =>
			proveRequirementChecks({
				state,
				now: () => now,
				save: (next) => {
					state = next;
				},
				requireVerifiedEvidenceForCompletion: true,
				isCheckCoverageEstablished: () => true,
				runCheck: async () => ({ passed: true, reason: "ready", output: "ready", exitCode: 0 }),
				coverageEngine: () => ({
					evaluate: async () => ({ answers: { covered_0: { type: "noul", noul: confidence } } }),
				}),
			});
		await measure();
		const first = state.evidence[0]!;
		const consumer = state.requirements[1]!;
		const accepted = applyGoalAction(
			state,
			{ action: "satisfy_requirement", requirementId: consumer.id, evidenceIds: [first.id] },
			now,
			{
				coverageProofs: new Set([requirementProofKey(consumer, [first])]),
			},
		);
		if (!accepted.ok) throw new Error(accepted.error);
		state = accepted.state;
		await measure();
		expect(state.evidence[0]!.id).not.toBe(first.id);
		expect(state.requirements[1]?.evidenceIds).toEqual(confidence > 0.9 ? [state.evidence[0]!.id] : []);
		expect(applyGoalAction(state, { action: "complete" }, now).ok).toBe(confidence > 0.9);
	},
);

it.each([true, false])(
	"rechecks the standing execution after reviewing a proposed requirement (pause and resume %s)",
	async (pause) => {
		let state = goal();
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			now: () => now,
			admitRequirementCheck: () => undefined,
			admitWork: async () => {
				if (pause) {
					state = applyGoalEvent(state, { type: "pause_goal", now });
					state = applyGoalEvent(state, { type: "resume_goal", source: "owner", now });
				} else
					state = applyGoalEvent(state, {
						type: "record_continuation_budget",
						now,
						turns: 0,
						wallClockMs: 1,
						spendUsd: 0,
						tokens: 0,
					});
				return undefined;
			},
		});
		const result = await tool.execute(
			"add",
			{ action: "add_requirement", requirementId: "live", text: "Validate recovery" },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);
		expect(result.details).toMatchObject({ applied: !pause });
		expect(state.requirements.map((item) => item.id)).toEqual(pause ? [] : ["live"]);
	},
);

it("rejects a write when two branches reach the same numeric goal revision with different evidence", () => {
	const base = goal();
	const receipt = { type: "add_evidence" as const, kind: "file" as const, id: "one", summary: "observed", now };
	const left = applyGoalEvent(base, receipt);
	const right = applyGoalEvent(base, { ...receipt, id: "two" });
	const expected = getGoalStateRevision(left);
	expect(right.revision).toBe(left.revision);
	expect(matchesGoalStateRevision(right, expected)).toBe(false);
	expect(matchesGoalStateRevision(structuredClone(left), expected)).toBe(true);
});

it("preserves an explicit requirement block when a fresh check fails", async () => {
	const checked = applyGoalEvent(goal(), {
		type: "add_requirement",
		id: "service",
		text: "Readiness",
		check: { command: "read-status" },
		now,
	});
	const blocked = applyGoalEvent(checked, {
		type: "block_requirement",
		id: "service",
		blockedReason: "Owner maintenance window",
		now,
	});
	const result = await proveRequirementChecks({
		state: blocked,
		now: () => now,
		save: () => {},
		requireVerifiedEvidenceForCompletion: true,
		runCheck: async () => ({ passed: false, exitCode: 1, reason: "Offline", output: "offline" }),
	});
	expect(result.state.requirements[0]).toMatchObject({ status: "blocked", blockedReason: "Owner maintenance window" });
	expect(result.state.evidence[0]?.outcome).toBe("failed");
});

it("requires a fresh run before an unfinished goal can use a historical check with unknown origin", () => {
	const original = applyGoalEvent(goal(), {
		type: "add_requirement",
		id: "r",
		text: "Readiness",
		check: { command: "read-status" },
		now,
	});
	const event = {
		type: "add_evidence" as const,
		kind: "check" as const,
		id: "old",
		summary: "ready",
		outcome: "succeeded" as const,
		verified: true,
		uri: "r",
		requirementKey: requirementKey(original.requirements[0]!),
		now,
	};
	const archived = applyGoalEvent(original, event, "legacy");
	const action = { action: "satisfy_requirement" as const, requirementId: "r", evidenceIds: ["old"] };
	const proof = requirementProofKey(archived.requirements[0]!, archived.evidence);
	expect(applyGoalAction(archived, action, now, { coverageProofs: new Set([proof]) }).ok).toBe(false);
	const oldAccepted = applyGoalEvent(
		archived,
		{ type: "satisfy_requirement", id: "r", evidenceIds: ["old"], now },
		"legacy",
	);
	const closed = applyGoalEvent(oldAccepted, { type: "complete_goal", now }, "legacy");
	expect(getTrustedRequirementEvidence(closed, closed.requirements[0]!).map((e) => e.id)).toEqual(["old"]);
	const fresh = applyGoalEvent(archived, { ...event, id: "new" });
	const newReceipt = fresh.evidence.find((e) => e.id === "new")!;
	expect(
		applyGoalAction(fresh, { ...action, evidenceIds: ["new"] }, now, {
			coverageProofs: new Set([requirementProofKey(fresh.requirements[0]!, [newReceipt])]),
		}).ok,
	).toBe(true);
});
