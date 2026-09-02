import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Message } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isCompletedBackgroundToolEvidence } from "../src/core/background-tool-task-controller.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createGoalState,
	type GoalState,
	isGoalState,
	parseGoalState,
	serializeGoalState,
} from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import {
	deriveOpenTaskStepRefs,
	findAnsweredToolCallOnBranchByText,
	hasAnsweredToolCallOnBranch,
} from "../src/core/runtime-builder.ts";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";
import {
	createGoalToolDefinition,
	type GoalToolDependencies,
	type GoalToolDetails,
	type GoalToolInput,
} from "../src/core/tools/goal.ts";

const ctx = undefined as unknown as ExtensionContext;

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-evidence-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Wires an in-memory goal tool over a plain in-memory state slot (no SessionManager needed). */
function createProducer(overrides: Partial<GoalToolDependencies> = {}) {
	let state: ReturnType<GoalToolDependencies["getGoalState"]>;
	let counter = 0;
	const tool = createGoalToolDefinition({
		getGoalState: () => state,
		saveGoalState: (s) => {
			state = s;
		},
		now: () => `T${counter++}`,
		...overrides,
	});
	return {
		run: async (input: GoalToolInput) => {
			const result = await tool.execute("call", input, undefined, undefined, ctx);
			return { content: result.content, details: result.details as GoalToolDetails };
		},
		getState: () => state,
	};
}

describe("goal evidence ref verification", () => {
	it("kind 'tool' verifies true when hasToolCallId confirms the id, false for a bogus id", async () => {
		const knownToolCallIds = new Set(["real-call-1"]);
		const { run, getState } = createProducer({ hasToolCallId: (id) => knownToolCallIds.has(id) });

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e-real",
			kind: "tool",
			summary: "ran the real tool call",
			uri: "real-call-1",
		});
		await run({
			action: "add_evidence",
			evidenceId: "e-bogus",
			kind: "tool",
			summary: "claims a tool call that never happened",
			uri: "fabricated-call",
		});

		const state = getState();
		expect(state?.evidence.find((e) => e.id === "e-real")?.verified).toBe(true);
		expect(state?.evidence.find((e) => e.id === "e-bogus")?.verified).toBe(false);
	});

	it.each([
		["running", false],
		["failed", false],
		["canceled", false],
		["completed", true],
	] as const)("only a %s background tool_task verifies as completed=%s", (status, expected) => {
		expect(
			isCompletedBackgroundToolEvidence(
				[{ taskId: "tool-task-1", toolCallId: "call-1", goalId: "g1", status }],
				"tool-task-1",
			),
		).toBe(expected);
	});

	it("kind 'tool' verifies false (not true) when hasToolCallId is not wired at all", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "tool",
			summary: "unverifiable without session access",
			uri: "some-call-id",
		});

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(false);
	});

	it("kind 'tool' stays unverified while the cited background tool_task is still running", async () => {
		const { run, getState } = createProducer({
			hasToolCallId: () => true,
			resolveToolEvidence: () => false,
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e-running",
			kind: "tool",
			summary: "background handoff is not completion",
			uri: "tool-task-1",
		});

		expect(getState()?.evidence.find((e) => e.id === "e-running")?.verified).toBe(false);
	});

	it("kind 'file' verifies true for a real file, false for a bogus path", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "real.txt"), "hello");
		const { run, getState } = createProducer({ cwd: () => dir });

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e-real",
			kind: "file",
			summary: "edited the real file",
			uri: "real.txt",
		});
		await run({
			action: "add_evidence",
			evidenceId: "e-bogus",
			kind: "file",
			summary: "claims a file that does not exist",
			uri: "does-not-exist.txt",
		});

		const state = getState();
		expect(state?.evidence.find((e) => e.id === "e-real")?.verified).toBe(true);
		expect(state?.evidence.find((e) => e.id === "e-bogus")?.verified).toBe(false);
	});

	it("kind 'file' verifies false for a directory path (not a regular file)", async () => {
		const dir = tempDir();
		const { run, getState } = createProducer({ cwd: () => dir });

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "file",
			summary: "points at a directory, not a file",
			uri: ".",
		});

		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(false);
	});

	it("kind 'user'/'finding'/'test' or a missing uri leaves verified undefined (no checkable ref)", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_evidence", evidenceId: "e-user", kind: "user", summary: "user said so" });
		await run({ action: "add_evidence", evidenceId: "e-nouri", kind: "tool", summary: "no uri given" });

		const state = getState();
		expect(state?.evidence.find((e) => e.id === "e-user")?.verified).toBeUndefined();
		expect(state?.evidence.find((e) => e.id === "e-nouri")?.verified).toBeUndefined();
	});

	it("rejects satisfy_requirement when the cited evidence is not trusted", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "finding", summary: "self-asserted" });

		const result = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });
		expect(result.details.applied).toBe(false);
		expect(result.details.error).toContain("verified or user-confirmed evidence");
		expect(getState()?.requirements[0]).toMatchObject({ status: "open", evidenceIds: [] });
	});

	it("blocks 'complete' for a legacy satisfied requirement with no verified/user evidence backing", async () => {
		let requireVerifiedEvidence = false;
		const { run, getState } = createProducer({
			requireVerifiedEvidenceForCompletion: () => requireVerifiedEvidence,
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "satisfy_requirement", requirementId: "r1" });
		requireVerifiedEvidence = true;

		const result = await run({ action: "complete" });
		expect(result.details.applied).toBe(false);
		expect(result.details.error).toContain("verified evidence");
		expect(getState()?.status).toBe("active");
	});

	it("increment leaves an open requirement open until unused trusted evidence exists", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e-unverified", kind: "finding", summary: "self-asserted" });

		const blocked = await run({ action: "increment" });
		expect(blocked.details.applied).toBe(false);
		expect(blocked.details.error).toContain("no unused evidence accepted as verified or user-confirmed");
		expect(getState()?.requirements[0]).toMatchObject({ status: "open", evidenceIds: [] });

		await run({ action: "add_evidence", evidenceId: "e-user", kind: "user", summary: "owner confirmed" });
		const satisfied = await run({ action: "increment" });
		expect(satisfied.details.applied).toBe(true);
		expect(getState()?.requirements[0]).toMatchObject({ status: "satisfied", evidenceIds: ["e-user"] });
	});

	it("increment repairs a legacy satisfied requirement that lacks trusted evidence before completing", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e-unverified", kind: "finding", summary: "self-asserted" });
		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e-unverified"] });
		await run({ action: "add_evidence", evidenceId: "e-user", kind: "user", summary: "owner confirmed" });

		const repaired = await run({ action: "increment" });
		expect(repaired.details.applied).toBe(true);
		expect(getState()?.requirements[0]).toMatchObject({ status: "satisfied", evidenceIds: ["e-user"] });
		expect(getState()?.status).toBe("active");

		const completed = await run({ action: "increment" });
		expect(completed.details.applied).toBe(true);
		expect(getState()?.status).toBe("completed");
	});

	it("reports evidence ids and trust status in the model-visible response", async () => {
		const { run } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		const result = await run({ action: "add_evidence", evidenceId: "e-user", kind: "user", summary: "confirmed" });

		const first = result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") return;
		expect(first.text).toContain("Evidence 'e-user' recorded (user-confirmed)");
	});

	it("allows 'complete' when a satisfied requirement is backed by verified 'tool' evidence", async () => {
		const { run, getState } = createProducer({ hasToolCallId: (id) => id === "call-1" });

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "tool", summary: "ran it", uri: "call-1" });
		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const result = await run({ action: "complete" });
		expect(result.details.applied).toBe(true);
		expect(getState()?.status).toBe("completed");
	});

	it("kind:'user' evidence always passes the completion gate, even though verified stays undefined", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "user confirmed" });
		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const state = getState();
		expect(state?.evidence.find((e) => e.id === "e1")?.verified).toBeUndefined();

		const result = await run({ action: "complete" });
		expect(result.details.applied).toBe(true);
	});

	it("the gate is opt-out configurable via requireVerifiedEvidenceForCompletion", async () => {
		const { run, getState } = createProducer({ requireVerifiedEvidenceForCompletion: () => false });

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "satisfy_requirement", requirementId: "r1" });

		const result = await run({ action: "complete" });
		expect(result.details.applied).toBe(true);
		expect(getState()?.status).toBe("completed");
	});

	it("applyGoalAction's complete gate defaults on when options are omitted entirely", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		const added = applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1");
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		state = added.state;
		const satisfied = applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1" }, "T2", {
			requireVerifiedEvidenceForCompletion: false,
		});
		expect(satisfied.ok).toBe(true);
		if (!satisfied.ok) return;
		state = satisfied.state;

		// no options 4th arg at all -- must behave the same as { requireVerifiedEvidenceForCompletion: true }
		const blocked = applyGoalAction(state, { action: "complete" }, "T3");
		expect(blocked.ok).toBe(false);
	});
});

describe("goal-state serialization round-trips the verified field", () => {
	it("serializeGoalState/parseGoalState preserve verified:true/false/absent", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		const added = applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1");
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		state = added.state;

		const withEvidence = applyGoalAction(
			state,
			{ action: "add_evidence", evidenceId: "e-true", kind: "tool", summary: "s", uri: "call-1", verified: true },
			"T2",
		);
		expect(withEvidence.ok).toBe(true);
		if (!withEvidence.ok) return;
		state = withEvidence.state;

		const withFalse = applyGoalAction(
			state,
			{ action: "add_evidence", evidenceId: "e-false", kind: "file", summary: "s", uri: "x", verified: false },
			"T3",
		);
		expect(withFalse.ok).toBe(true);
		if (!withFalse.ok) return;
		state = withFalse.state;

		const withAbsent = applyGoalAction(
			state,
			{ action: "add_evidence", evidenceId: "e-absent", kind: "user", summary: "s" },
			"T4",
		);
		expect(withAbsent.ok).toBe(true);
		if (!withAbsent.ok) return;
		state = withAbsent.state;

		const serialized = serializeGoalState(state);
		expect(isGoalState(JSON.parse(serialized))).toBe(true);
		const parsed = parseGoalState(serialized);
		expect(parsed).toBeDefined();
		expect(parsed?.evidence.find((e) => e.id === "e-true")?.verified).toBe(true);
		expect(parsed?.evidence.find((e) => e.id === "e-false")?.verified).toBe(false);
		expect(parsed?.evidence.find((e) => e.id === "e-absent")?.verified).toBeUndefined();
	});
});

function toolResultMessage(toolCallId: string, timestamp: number): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

describe("findAnsweredToolCallOnBranchByText (a run cited by the command the model typed)", () => {
	function bashCall(id: string, command: string, timestamp: number) {
		return {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id, name: "bash", arguments: { command } }],
			api: "openai-responses",
			provider: "openai",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp,
		};
	}

	it("resolves the most recent answered call whose arguments contain the text, ignoring a locator prefix", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("run-1", "npm test", 1000) as never);
		sessionManager.appendMessage(toolResultMessage("run-1", 1001));
		sessionManager.appendMessage(bashCall("run-2", "npm test -- --grep store", 1002) as never);
		sessionManager.appendMessage(toolResultMessage("run-2", 1003));
		sessionManager.appendMessage(bashCall("run-3", "npm test", 1004) as never);

		// run-3 never answered: not evidence of anything. run-2 is the most recent answered match.
		expect(findAnsweredToolCallOnBranchByText(sessionManager, "command:npm test")).toBe("run-2");
		expect(findAnsweredToolCallOnBranchByText(sessionManager, "npm test -- --grep store")).toBe("run-2");
		expect(findAnsweredToolCallOnBranchByText(sessionManager, "pytest")).toBeUndefined();
		expect(findAnsweredToolCallOnBranchByText(sessionManager, "np")).toBeUndefined();
	});

	it("through the wired path: test evidence cited by command text verifies and carries the call id", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("run-1", "npm test", 1000) as never);
		sessionManager.appendMessage(toolResultMessage("run-1", 1001));
		let state: GoalState | undefined;
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			now: () => "T0",
			resolveToolEvidence: (uri) => {
				if (hasAnsweredToolCallOnBranch(sessionManager, uri)) return true;
				const toolCallId = findAnsweredToolCallOnBranchByText(sessionManager, uri);
				return toolCallId ? { verified: true, toolCallId } : false;
			},
		});
		await tool.execute("call-start", { action: "start", goalId: "g1", userGoal: "Ship" }, undefined, undefined, ctx);
		const result = await tool.execute(
			"call-ev",
			{ action: "add_evidence", kind: "test", uri: "command:npm test", summary: "9 passing" },
			undefined,
			undefined,
			ctx,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("recorded (verified via toolCallId run-1)");
		expect(state?.evidence[0]).toMatchObject({ kind: "test", uri: "run-1", verified: true });
	});
});

describe("hasAnsweredToolCallOnBranch (production wiring, closes the runtime-builder handoff)", () => {
	it("resolves true for a real toolResult on the active branch, false for an unknown id", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(toolResultMessage("real-call-1", 1000));

		expect(hasAnsweredToolCallOnBranch(sessionManager, "real-call-1")).toBe(true);
		expect(hasAnsweredToolCallOnBranch(sessionManager, "fabricated-call")).toBe(false);
	});

	it("is branch-scoped: a toolResult recorded only on a sibling branch does not verify", () => {
		const sessionManager = SessionManager.inMemory();
		const forkPointId = sessionManager.appendMessage({ role: "user", content: "start", timestamp: 900 });
		sessionManager.appendMessage(toolResultMessage("branch-a-call", 1000));
		// Reset to the fork point and grow a DIFFERENT branch from there.
		sessionManager.branch(forkPointId);
		sessionManager.appendMessage(toolResultMessage("branch-b-call", 1100));

		expect(hasAnsweredToolCallOnBranch(sessionManager, "branch-b-call")).toBe(true);
		expect(hasAnsweredToolCallOnBranch(sessionManager, "branch-a-call")).toBe(false);
	});

	it("through the wired path: the goal tool's kind:'tool' evidence verifies true for a real session tool call", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(toolResultMessage("real-call-1", 1000));

		let counter = 0;
		const tool = createGoalToolDefinition({
			getGoalState: () => getLatestGoalStateSnapshot(sessionManager),
			saveGoalState: (state) => {
				appendGoalStateSnapshot(sessionManager, state);
			},
			now: () => `T${counter++}`,
			// The exact function wired at runtime-builder.ts's createGoalToolDefinition call site.
			hasToolCallId: (toolCallId) => hasAnsweredToolCallOnBranch(sessionManager, toolCallId),
		});
		const run = async (input: GoalToolInput) => {
			const result = await tool.execute("call", input, undefined, undefined, ctx);
			return { content: result.content, details: result.details as GoalToolDetails };
		};

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({
			action: "add_evidence",
			evidenceId: "e-real",
			kind: "tool",
			summary: "ran the real tool call",
			uri: "real-call-1",
		});
		await run({
			action: "add_evidence",
			evidenceId: "e-bogus",
			kind: "tool",
			summary: "claims a tool call that never happened",
			uri: "fabricated-call",
		});

		const state = getLatestGoalStateSnapshot(sessionManager);
		expect(state?.evidence.find((e) => e.id === "e-real")?.verified).toBe(true);
		expect(state?.evidence.find((e) => e.id === "e-bogus")?.verified).toBe(false);
	});
});

describe("goal⇄task cross-visibility nudge reaches the tool response text", () => {
	it("names the referencing open task step in the response text after satisfy_requirement", async () => {
		const { run } = createProducer({
			getOpenTaskSteps: () => [{ id: "step-1", content: "Implement r1 in the UI" }],
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "user confirmed" });
		const result = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const first = result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") return;
		expect(first.text).toContain("open task step(s) step-1 appear to reference satisfied requirement 'r1'");
	});

	it("emits no nudge when getOpenTaskSteps is not wired (backward compatible, no behavior change)", async () => {
		const { run } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "user confirmed" });
		const result = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const first = result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") return;
		expect(first.text).not.toContain("reference satisfied requirement");
	});
});

describe("deriveOpenTaskStepRefs (production wiring, closes the runtime-builder handoff)", () => {
	it("keeps only OPEN (non-terminal) steps, preferring activeForm over content", () => {
		let taskSteps = createTaskStepsState("T0");
		taskSteps = addTaskStep(taskSteps, { content: "Cover r1", activeForm: "Covering r1" }, "T1");
		taskSteps = addTaskStep(taskSteps, { content: "Already done", status: "completed" }, "T2");
		taskSteps = addTaskStep(taskSteps, { content: "Abandoned", status: "cancelled" }, "T3");

		const refs = deriveOpenTaskStepRefs(taskSteps);
		expect(refs).toEqual([{ id: "step-1", content: "Covering r1" }]);
	});

	it("returns an empty array for an undefined snapshot", () => {
		expect(deriveOpenTaskStepRefs(undefined)).toEqual([]);
	});

	it("through the wired path: the goal tool nudges using the real production mapping function", async () => {
		let taskSteps = createTaskStepsState("T0");
		taskSteps = addTaskStep(taskSteps, { content: "Cover r1" }, "T1");

		// The exact function wired at runtime-builder.ts's createGoalToolDefinition call site.
		const { run } = createProducer({ getOpenTaskSteps: () => deriveOpenTaskStepRefs(taskSteps) });

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "user confirmed" });
		const result = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const first = result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") return;
		expect(first.text).toContain("step-1");
		expect(first.text).toContain("satisfied requirement 'r1'");
	});
});
