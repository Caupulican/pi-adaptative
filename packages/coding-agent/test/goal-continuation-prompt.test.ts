import { describe, expect, it } from "vitest";
import { buildGoalContinuationPrompt } from "../src/core/goals/goal-continuation-prompt.ts";
import type { GoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";

describe("Phase 10C: Goal Continuation Prompt", () => {
	it("empty/missing-goal snapshot still produces a prompt with continuation action/reason", () => {
		const snapshot: GoalRuntimeSnapshot = {
			workerResults: [],
			learningDecisions: [],
			continuation: {
				action: "ask-user",
				reasonCode: "missing_goal_state",
				message: "No goal.",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot });
		expect(prompt.truncated).toBe(false);
		expect(prompt.text).toContain("Action: ask-user");
		expect(prompt.text).toContain("Reason: missing_goal_state");
		expect(prompt.text).not.toContain("Goal ID:");
	});

	it("prompt includes goal id, user goal, requirement buckets, continuation reason", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });

		const snapshot: GoalRuntimeSnapshot = {
			goalState: state,
			workerResults: [],
			learningDecisions: [],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "Active",
				openRequirementIds: ["req-1"],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot });
		expect(prompt.text).toContain("Goal ID: g1");
		expect(prompt.text).toContain("User Goal Here");
		expect(prompt.text).toContain("Req 1");
		expect(prompt.text).toContain("Action: continue");
	});

	it("prompt includes evidence findings/sources but not source metadata", () => {
		const snapshot: GoalRuntimeSnapshot = {
			goalState: createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" }),
			workerResults: [],
			learningDecisions: [],
			latestEvidenceBundle: {
				query: "test query",
				sources: [
					{ id: "src1", kind: "workspace", trusted: true, title: "Title1", metadata: { secret: "do not leak" } },
				],
				findings: [{ id: "f1", summary: "Finding 1", confidence: 90, evidenceIds: ["src1"] }],
			},
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "Active",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot });
		expect(prompt.text).toContain("test query");
		expect(prompt.text).toContain("Finding 1");
		expect(prompt.text).toContain("src1");
		expect(prompt.text).toContain("Title1");
		expect(prompt.text).toContain("TRUSTED");
		expect(prompt.text).not.toContain("do not leak");
	});

	it("prompt includes worker result and learning decision summaries", () => {
		const snapshot: GoalRuntimeSnapshot = {
			goalState: createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" }),
			workerResults: [{ requestId: "w1", status: "completed", summary: "Worker result here", changedFiles: [] }],
			learningDecisions: [
				{ kind: "proposal", reasonCode: "l1", confidence: 80, summary: "Learning here", requiresApproval: false },
			],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "Active",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot });
		expect(prompt.text).toContain("Worker result here");
		expect(prompt.text).toContain("w1");
		expect(prompt.text).toContain("Learning here");
		expect(prompt.text).toContain("l1");
	});

	it("evidence/worker/learning safety warning is present", () => {
		const snapshot: GoalRuntimeSnapshot = {
			workerResults: [{ requestId: "w1", status: "completed", summary: "w", changedFiles: [] }],
			learningDecisions: [],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "Active",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot });
		expect(prompt.text).toContain("SAFETY WARNING:");
		expect(prompt.text).toContain("untrusted data");
	});

	it("list limits omit extra items and set truncated true", () => {
		const workers = [];
		for (let i = 0; i < 5; i++) {
			workers.push({ requestId: `w${i}`, status: "completed" as const, summary: "w", changedFiles: [] });
		}

		const snapshot: GoalRuntimeSnapshot = {
			workerResults: workers,
			learningDecisions: [],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "Active",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot, limits: { maxWorkerResults: 2 } });
		expect(prompt.truncated).toBe(true);
		expect(prompt.text).toContain("... 3 more worker results omitted");
		expect(prompt.text).toContain("w0");
		expect(prompt.text).toContain("w1");
		expect(prompt.text).not.toContain("w2");
	});

	it("maxTextLength truncates and sets truncated true", () => {
		const snapshot: GoalRuntimeSnapshot = {
			workerResults: [],
			learningDecisions: [],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: `A very long message ${"x".repeat(2000)}`,
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot, limits: { maxTextLength: 100 } });
		expect(prompt.truncated).toBe(true);
		expect(prompt.text.length).toBe(100);
		expect(prompt.text.endsWith("…")).toBe(true);
	});

	it("secret-like inline values are redacted", () => {
		const snapshot: GoalRuntimeSnapshot = {
			workerResults: [],
			learningDecisions: [],
			latestEvidenceBundle: {
				query: "q",
				sources: [
					{
						id: "src1",
						kind: "web",
						trusted: false,
						uri: "https://example.test/path?token=uri-secret",
					},
				],
				findings: [],
			},
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "My token=secret123 value and api_key=xyz456 test",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const prompt = buildGoalContinuationPrompt({ snapshot });
		expect(prompt.text).toContain("token=[REDACTED]");
		expect(prompt.text).toContain("api_key=[REDACTED]");
		expect(prompt.text).not.toContain("secret123");
		expect(prompt.text).not.toContain("xyz456");
		expect(prompt.text).not.toContain("uri-secret");
	});

	it("prompt builder does not mutate snapshot objects", () => {
		const workers = [{ requestId: "w1", status: "completed" as const, summary: "w", changedFiles: [] }];
		const snapshot: GoalRuntimeSnapshot = {
			workerResults: workers,
			learningDecisions: [],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "msg",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};

		const workersOriginal = [...workers];
		buildGoalContinuationPrompt({ snapshot, limits: { maxWorkerResults: 0 } });

		expect(snapshot.workerResults).toEqual(workersOriginal);
	});
});
