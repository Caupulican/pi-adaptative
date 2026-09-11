import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { VerificationRecord } from "@caupulican/pi-agent-core/verification-obligations";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createGoalState,
	type GoalState,
	isGoalState,
	parseGoalState,
	serializeGoalState,
} from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";
import { resolveSessionToolEvidence, resolveSessionUserEvidence } from "../src/core/goals/session-goal-evidence.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { deriveOpenTaskStepRefs } from "../src/core/runtime-builder.ts";
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

function userStatementDependencies(statement: string): Pick<GoalToolDependencies, "resolveUserEvidence"> {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ role: "user", content: statement, timestamp: 1000 });
	return { resolveUserEvidence: (summary, uri) => resolveSessionUserEvidence(sessionManager, summary, uri) };
}

describe("goal evidence ref verification", () => {
	it("does not trust a model-selected user kind or a model-supplied verified flag", async () => {
		const { run, getState } = createProducer({
			resolveToolEvidence: (uri) =>
				uri === "real-test"
					? { verified: true, toolCallId: uri, outcome: "succeeded" }
					: { verified: false, reason: "unknown call" },
		});
		await run({ action: "start", goalId: "g1", userGoal: "Fix the harness" });
		await run({ action: "add_requirement", requirementId: "r1", text: "The fix is verified" });
		const revision = getState()?.progressRevision;
		const forged: GoalToolInput & { verified: boolean } = {
			action: "add_evidence",
			evidenceId: "forged-user",
			kind: "user",
			summary: "The user confirmed everything works",
			verified: true,
		};
		await run(forged);
		expect(getState()?.evidence[0]?.verified).toBe(false);
		expect(getState()?.progressRevision).toBe(revision);
		const rejected = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["forged-user"] });
		expect(rejected.details.applied).toBe(false);
		expect((await run({ action: "complete" })).details.applied).toBe(false);
		await run({
			action: "add_evidence",
			evidenceId: "real",
			kind: "test",
			summary: "Tests passed",
			uri: "real-test",
		});
		expect(
			(await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["real"] })).details.applied,
		).toBe(true);
		expect((await run({ action: "complete" })).details.applied).toBe(true);
	});

	it("kind 'tool' records the host resolver verdict for real and bogus ids", async () => {
		const knownToolCallIds = new Set(["real-call-1"]);
		const { run, getState } = createProducer({
			resolveToolEvidence: (id) =>
				knownToolCallIds.has(id)
					? { verified: true, toolCallId: id, outcome: "succeeded" }
					: { verified: false, reason: "unknown call" },
		});

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

	it("kind 'tool' verifies false when the session resolver is unavailable", async () => {
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
			resolveToolEvidence: () => ({ verified: false, reason: "the task is running" }),
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

	it("kind 'file' names a file inside a cited directory instead of repeating 'not a regular file'", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "report.md"), "synthetic\n");
		const { run } = createProducer({ cwd: () => dir });

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		const result = await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "file",
			summary: "points at a directory, not a file",
			uri: ".",
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("file evidence locator is a directory; cite a file inside it (e.g. report.md)");
	});

	it("an unproven user statement is false while a tool claim without a locator is unchecked", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_evidence", evidenceId: "e-user", kind: "user", summary: "user said so" });
		await run({ action: "add_evidence", evidenceId: "e-nouri", kind: "tool", summary: "no uri given" });

		const state = getState();
		expect(state?.evidence.find((e) => e.id === "e-user")?.verified).toBe(false);
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
		const { run, getState } = createProducer(userStatementDependencies("owner confirmed"));

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
		const { run, getState } = createProducer(userStatementDependencies("owner confirmed"));

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
		const { run } = createProducer(userStatementDependencies("confirmed"));

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		const result = await run({ action: "add_evidence", evidenceId: "e-user", kind: "user", summary: "confirmed" });

		const first = result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") return;
		expect(first.text).toContain("Evidence 'e-user' recorded (verified user statement via user-message:");
	});

	it("allows 'complete' when a satisfied requirement is backed by verified 'tool' evidence", async () => {
		const { run, getState } = createProducer({
			resolveToolEvidence: (id) =>
				id === "call-1"
					? { verified: true, toolCallId: id, outcome: "succeeded" }
					: { verified: false, reason: "unknown call" },
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "tool", summary: "ran it", uri: "call-1" });
		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const result = await run({ action: "complete" });
		expect(result.details.applied).toBe(true);
		expect(getState()?.status).toBe("completed");
	});

	it("a verified user statement can back completion", async () => {
		const { run, getState } = createProducer(userStatementDependencies("user confirmed"));

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "user confirmed" });
		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });

		const state = getState();
		expect(state?.evidence.find((e) => e.id === "e1")?.verified).toBe(true);

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

describe("user evidence provenance", () => {
	it("resolves a full user statement with or without its entry id, and preserves the canonical source", async () => {
		const sessionManager = SessionManager.inMemory();
		const statement = "I tested the fix manually and confirm it works.";
		const entryId = sessionManager.appendMessage({ role: "user", content: statement, timestamp: 1000 });
		const { run, getState } = createProducer({
			resolveUserEvidence: (summary, uri) => resolveSessionUserEvidence(sessionManager, summary, uri),
		});
		await run({ action: "start", goalId: "g1", userGoal: "Fix the harness" });
		for (const [index, uri] of [undefined, entryId, `user-message:${entryId}`].entries()) {
			await run({ action: "add_evidence", evidenceId: `user-${index}`, kind: "user", summary: statement, uri });
			expect(getState()?.evidence.at(-1)).toMatchObject({ verified: true, uri: `user-message:${entryId}` });
		}
	});

	it("does not strip qualifications or resolve an explicit wrong locator by quote", () => {
		const sessionManager = SessionManager.inMemory();
		const entryId = sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "The fix works." },
				{ type: "text", text: "But the tests still fail." },
			],
			timestamp: 1000,
		});
		for (const [quote, uri] of [
			["The fix works.", entryId],
			["The fix works.\nBut the tests still fail.", "missing-entry"],
			["The fix works.\nBut the tests still fail.", "user-message:"],
			["", entryId],
		]) {
			expect(resolveSessionUserEvidence(sessionManager, quote, uri).verified).toBe(false);
		}
		expect(
			resolveSessionUserEvidence(sessionManager, "The fix works.\nBut the tests still fail.", entryId).verified,
		).toBe(true);
	});

	it("rejects assistant, tool, internal context, and sibling-branch claims", () => {
		const sessionManager = SessionManager.inMemory();
		const forkId = sessionManager.appendMessage({ role: "user", content: "Fix the bug", timestamp: 1000 });
		const confirmedId = sessionManager.appendMessage({ role: "user", content: "The fix works", timestamp: 1001 });
		expect(resolveSessionUserEvidence(sessionManager, "The fix works", confirmedId).verified).toBe(true);
		sessionManager.branch(forkId);
		const assistantId = sessionManager.appendMessage({
			...bashCall("read-proof", "cat proof.txt", 1002),
			content: [{ type: "text", text: "The fix works" }],
		});
		const toolId = sessionManager.appendMessage({
			...toolResultMessage("read-proof", 1003),
			content: [{ type: "text", text: "The fix works" }],
		});
		const contextId = sessionManager.appendMessage({
			role: "custom",
			customType: "goal_context",
			content: "The fix works",
			display: false,
			timestamp: 1004,
		});
		for (const uri of [undefined, confirmedId, assistantId, toolId, contextId]) {
			expect(resolveSessionUserEvidence(sessionManager, "The fix works", uri).verified).toBe(false);
		}
	});
});

function toolResultMessage(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

function bashCall(id: string, command: string, timestamp: number): AssistantMessage {
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

const testWitness = { outcome: "executed", evidence: "tests" } as const;

describe("goal test evidence from session receipts", () => {
	it.each([undefined, "command", "tests", "unknown"])(
		"requires an explicit executed test witness, not command success (%s)",
		(evidence) => {
			const session = SessionManager.inMemory();
			session.appendMessage(bashCall("witness", "npm test", 1000));
			const piVerification = {
				version: 1 as const,
				id: "unit-test",
				status: "passed" as const,
				outcome: "executed" as const,
				evidence,
			};
			session.appendMessage({ ...toolResultMessage("witness", 1001), details: { piVerification } });
			expect(resolveSessionToolEvidence(session, [], "witness", "test").verified).toBe(evidence === "tests");
			expect(resolveSessionToolEvidence(session, [], "witness", "tool").verified).toBe(true);
			const task = {
				taskId: "task-1",
				toolCallId: "witness",
				status: "completed" as const,
				piVerification: { ...piVerification, originTaskId: "task-1" } as VerificationRecord & {
					originTaskId: string;
				},
			};
			expect(resolveSessionToolEvidence(session, [task], "witness", "test").verified).toBe(evidence === "tests");
		},
	);
	it.each([true, false])("selects the last matching call within one batch (last failed: %s)", (lastFailed) => {
		const sessionManager = SessionManager.inMemory();
		const first = bashCall("first", "npm test", 1000);
		const last = bashCall("last", "npm test", 1000);
		sessionManager.appendMessage({ ...first, content: [...first.content, ...last.content] });
		for (const id of ["first", "last"]) {
			const failed = id === "last" && lastFailed;
			sessionManager.appendMessage({
				...toolResultMessage(id, 1001),
				isError: failed,
				details: {
					piVerification: { ...testWitness, version: 1, id: "unit-test", status: failed ? "failed" : "passed" },
				},
			});
		}
		expect(resolveSessionToolEvidence(sessionManager, [], "first", "test").verified).toBe(true);
		const resolved = resolveSessionToolEvidence(sessionManager, [], "command:npm test", "test");
		expect(resolved.verified).toBe(!lastFailed);
		if (resolved.verified) expect(resolved.toolCallId).toBe("last");
	});
	it("does not crash or manufacture a command match from malformed persisted arguments", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("valid", "npm test", 1000));
		sessionManager.appendMessage({
			...toolResultMessage("valid", 1001),
			details: { piVerification: { ...testWitness, version: 1, id: "unit-test", status: "passed" } },
		});
		const malformed = bashCall("malformed", "npm test", 1002);
		Object.defineProperty(malformed.content[0], "arguments", { value: null });
		sessionManager.appendMessage(malformed);
		expect(resolveSessionToolEvidence(sessionManager, [], "missing command", "test").verified).toBe(false);
		expect(resolveSessionToolEvidence(sessionManager, [], "valid", "test").verified).toBe(true);
	});

	it("preserves a failed operation as tool evidence without calling it a passing test", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("failed-test", "npm test", 1000));
		sessionManager.appendMessage({
			...toolResultMessage("failed-test", 1001),
			isError: true,
			details: { piVerification: { version: 1, id: "regression-test", status: "failed" } },
		});
		const { run, getState } = createProducer({
			resolveToolEvidence: (uri, kind) => resolveSessionToolEvidence(sessionManager, [], uri, kind),
		});
		await run({ action: "start", goalId: "g1", userGoal: "Reproduce the defect" });
		const recorded = await run({
			action: "add_evidence",
			evidenceId: "repro",
			kind: "tool",
			summary: "Reproduced the failure",
			uri: "failed-test",
		});
		expect(getState()?.evidence[0]).toMatchObject({ verified: true, outcome: "failed", uri: "failed-test" });
		expect(recorded.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("operation failed") });
		await run({
			action: "add_evidence",
			evidenceId: "not-a-pass",
			kind: "test",
			summary: "Tests pass",
			uri: "failed-test",
		});
		expect(getState()?.evidence[1]?.verified).toBe(false);
	});

	it.each([
		["diff-call", "git diff --stat test/regression.test.ts", false],
		["test/regression.test.ts", "git diff --stat test/regression.test.ts", false],
		["failed-call", "npm test", true],
	] as const)("does not accept %s as a passed test", async (uri, command, isError) => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("passed-call", "npm test -- test/control.test.ts", 1000));
		sessionManager.appendMessage({
			...toolResultMessage("passed-call", 1001),
			toolName: "bash",
			details: { piVerification: { ...testWitness, version: 1, id: "control-test", status: "passed" } },
		});
		const citedCallId = isError ? "failed-call" : "diff-call";
		sessionManager.appendMessage(bashCall(citedCallId, command, 1002));
		sessionManager.appendMessage({
			...toolResultMessage(citedCallId, 1003),
			toolName: "bash",
			isError,
			...(isError ? { details: { piVerification: { version: 1, id: "failed-test", status: "failed" } } } : {}),
		});
		const { run, getState } = createProducer({
			resolveToolEvidence: (locator, kind) => resolveSessionToolEvidence(sessionManager, [], locator, kind),
		});
		await run({ action: "start", goalId: "g1", userGoal: "Fix the regression" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Regression tests pass" });
		await run({
			action: "add_evidence",
			evidenceId: "control",
			kind: "test",
			summary: "a real passing test",
			uri: "passed-call",
		});
		expect(getState()?.evidence.find((evidence) => evidence.id === "control")?.verified).toBe(true);
		await run({ action: "add_evidence", evidenceId: "bad", kind: "test", summary: "claims passing tests", uri });
		expect(getState()?.evidence.find((evidence) => evidence.id === "bad")?.verified).toBe(false);
		const rejected = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["bad"] });
		expect(rejected.details.applied).toBe(false);
		const accepted = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["control"] });
		expect(accepted.details.applied).toBe(true);
	});

	it("resolves only exact commands and never falls back from an unanswered attempt", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("run-1", "npm test", 1000));
		sessionManager.appendMessage(toolResultMessage("run-1", 1001));
		sessionManager.appendMessage(bashCall("run-2", "npm test -- --grep store", 1002));
		sessionManager.appendMessage(toolResultMessage("run-2", 1003));
		sessionManager.appendMessage(bashCall("run-3", "npm test", 1004));

		// run-3 never answered. Its identical command must not select an earlier pass.
		expect(resolveSessionToolEvidence(sessionManager, [], "command:npm test", "tool").verified).toBe(false);
		expect(resolveSessionToolEvidence(sessionManager, [], "npm test -- --grep store", "tool")).toEqual({
			verified: true,
			toolCallId: "run-2",
			outcome: "succeeded",
		});
		for (const locator of ["pytest", "np", "grep store", "NPM TEST -- --grep store"]) {
			expect(resolveSessionToolEvidence(sessionManager, [], locator, "tool").verified).toBe(false);
		}
	});

	it("matches a command citation on what ran, not on how it was typed", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("run-1", "npx vitest --run test/goal-tool.test.ts", 1000));
		sessionManager.appendMessage(toolResultMessage("run-1", 1001));

		// Layout only: leading/trailing space, a collapsed run of internal spaces, one trailing ";".
		for (const locator of [
			"  npx vitest --run test/goal-tool.test.ts  ",
			"npx  vitest   --run  test/goal-tool.test.ts",
			"npx vitest --run test/goal-tool.test.ts;",
			"command: npx vitest   --run test/goal-tool.test.ts ;",
		]) {
			expect(resolveSessionToolEvidence(sessionManager, [], locator, "tool")).toEqual({
				verified: true,
				toolCallId: "run-1",
				outcome: "succeeded",
			});
		}
		// Identity still comes from the text: a different case or a dropped flag is a different call.
		for (const locator of [
			"NPX VITEST --run test/goal-tool.test.ts",
			"npx vitest test/goal-tool.test.ts",
			"npx vitest --run test/goal-tool.test.ts --reporter=dot",
		]) {
			expect(resolveSessionToolEvidence(sessionManager, [], locator, "tool").verified).toBe(false);
		}
	});

	it("matches a python citation and names the newest calls when nothing matches", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("run-1", "npm run build", 1000));
		sessionManager.appendMessage(toolResultMessage("run-1", 1001));
		const pythonCall = bashCall("run-2", "unused", 1002);
		pythonCall.content = [{ type: "toolCall", id: "run-2", name: "python", arguments: { code: "print( 1 +  1 )" } }];
		sessionManager.appendMessage(pythonCall);
		sessionManager.appendMessage({ ...toolResultMessage("run-2", 1003), toolName: "python" });
		sessionManager.appendMessage(bashCall("run-3", "npm run check -- --since main", 1004));
		sessionManager.appendMessage(toolResultMessage("run-3", 1005));
		sessionManager.appendMessage(bashCall("run-4", "x".repeat(120), 1006));
		sessionManager.appendMessage(toolResultMessage("run-4", 1007));

		expect(resolveSessionToolEvidence(sessionManager, [], "print( 1 +  1 )", "tool")).toEqual({
			verified: true,
			toolCallId: "run-2",
			outcome: "succeeded",
		});

		const unmatched = resolveSessionToolEvidence(sessionManager, [], "I ran the build", "tool");
		expect(unmatched.verified).toBe(false);
		const reason = unmatched.verified ? "" : unmatched.reason;
		// The three most recent producing calls, newest first, each with a bounded excerpt.
		expect(reason).toContain("no producing call matches this id or exact command on the active branch");
		expect(reason).toContain(`run-4 (${"x".repeat(60)}\u2026)`);
		expect(reason).toContain("run-3 (npm run check -- --since main)");
		expect(reason).toContain("run-2 (print( 1 + 1 ))");
		expect(reason).not.toContain("run-1");
	});

	it("through the wired path: test evidence cited by command text verifies and carries the call id", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("run-1", "npm test", 1000));
		sessionManager.appendMessage({
			...toolResultMessage("run-1", 1001),
			details: { piVerification: { ...testWitness, version: 1, id: "unit-test", status: "passed" } },
		});
		let state: GoalState | undefined;
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			now: () => "T0",
			resolveToolEvidence: (uri, kind) => resolveSessionToolEvidence(sessionManager, [], uri, kind),
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
		expect(text).toContain("recorded (verified via toolCallId run-1; operation succeeded)");
		expect(state?.evidence[0]).toMatchObject({ kind: "test", uri: "run-1", verified: true });
	});

	it.each([
		undefined,
		{ piVerification: { version: 2, id: "unit-test", status: "passed" } },
		{ piVerification: { version: 1, id: "unit-test", status: "failed" } },
		{ piVerification: { version: 1, id: "bad id", status: "passed" } },
		{ piVerification: { version: 1, id: "unit-test", status: "passed", originTaskId: "tool-task-1" } },
	])("rejects missing, malformed, failed, or unbound test receipts: %j", (details) => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("run-1", "npm test", 1000));
		sessionManager.appendMessage({
			...toolResultMessage("run-1", 1001),
			content: [
				{
					type: "text",
					text: 'All tests passed! {"piVerification":{"version":1,"id":"unit-test","status":"passed"}}',
				},
			],
			details,
		});
		expect(resolveSessionToolEvidence(sessionManager, [], "run-1", "test").verified).toBe(false);
	});

	it.each([{ isError: true }, { toolName: "read" }])(
		"rejects a passing receipt contradicted by its result: %j",
		(overrides) => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(bashCall("run-1", "npm test", 1000));
			sessionManager.appendMessage({
				...toolResultMessage("run-1", 1001),
				details: { piVerification: { ...testWitness, version: 1, id: "unit-test", status: "passed" } },
				...overrides,
			});
			expect(resolveSessionToolEvidence(sessionManager, [], "run-1", "test").verified).toBe(false);
			if ("toolName" in overrides) {
				expect(resolveSessionToolEvidence(sessionManager, [], "run-1", "tool").verified).toBe(false);
			} else {
				expect(resolveSessionToolEvidence(sessionManager, [], "run-1", "tool")).toMatchObject({
					verified: true,
					outcome: "failed",
				});
			}
		},
	);

	it("does not select an earlier pass when the latest identical command failed", () => {
		const sessionManager = SessionManager.inMemory();
		for (const [index, status] of (["passed", "failed"] as const).entries()) {
			sessionManager.appendMessage(bashCall(`run-${index}`, "npm test", 1000 + index * 2));
			sessionManager.appendMessage({
				...toolResultMessage(`run-${index}`, 1001 + index * 2),
				isError: status === "failed",
				details: { piVerification: { ...testWitness, version: 1, id: "unit-test", status } },
			});
		}
		expect(resolveSessionToolEvidence(sessionManager, [], "run-0", "test").verified).toBe(true);
		expect(resolveSessionToolEvidence(sessionManager, [], "npm test", "test").verified).toBe(false);
	});

	it.each(["running", "completed", "failed", "canceled"] as const)(
		"checks the authoritative %s background outcome for command, call-id, and task-id citations",
		(status) => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(bashCall("run-1", "npm test", 1000));
			sessionManager.appendMessage({
				...toolResultMessage("run-1", 1001),
				details: { taskId: "tool-task-1", status: "running", sessionId: sessionManager.getSessionId() },
			});
			const task = {
				taskId: "tool-task-1",
				toolCallId: "run-1",
				status,
				piVerification: {
					...testWitness,
					version: 1 as const,
					id: "unit-test",
					status: "passed" as const,
					originTaskId: "tool-task-1",
				},
			};
			for (const uri of ["run-1", "tool-task-1", "command:npm test"]) {
				for (const kind of ["tool", "test"] as const) {
					expect(resolveSessionToolEvidence(sessionManager, [task], uri, kind).verified).toBe(
						kind === "test" ? status === "completed" : status !== "running",
					);
				}
				expect(resolveSessionToolEvidence(sessionManager, [], uri, "tool").verified).toBe(false);
			}
			if (status === "completed") {
				const withoutReceipt = { taskId: task.taskId, toolCallId: task.toolCallId, status };
				expect(resolveSessionToolEvidence(sessionManager, [withoutReceipt], task.taskId, "tool").verified).toBe(
					true,
				);
				expect(resolveSessionToolEvidence(sessionManager, [withoutReceipt], task.taskId, "test").verified).toBe(
					false,
				);
				const wrongOrigin = { ...task, piVerification: { ...task.piVerification, originTaskId: "tool-task-2" } };
				expect(resolveSessionToolEvidence(sessionManager, [wrongOrigin], task.taskId, "test").verified).toBe(false);
			}
			const emptyBranch = SessionManager.inMemory();
			expect(resolveSessionToolEvidence(emptyBranch, [task], task.taskId, "test").verified).toBe(false);
		},
	);
});

describe("branch-scoped goal tool evidence", () => {
	it("requires a producing call and its successful result on the active branch", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("real-call-1", "git status", 999));
		sessionManager.appendMessage(toolResultMessage("real-call-1", 1000));
		sessionManager.appendMessage(toolResultMessage("orphan-call", 1001));

		expect(resolveSessionToolEvidence(sessionManager, [], "real-call-1", "tool").verified).toBe(true);
		expect(resolveSessionToolEvidence(sessionManager, [], "fabricated-call", "tool").verified).toBe(false);
		expect(resolveSessionToolEvidence(sessionManager, [], "orphan-call", "tool").verified).toBe(false);
	});

	it("is branch-scoped: a toolResult recorded only on a sibling branch does not verify", () => {
		const sessionManager = SessionManager.inMemory();
		const forkPointId = sessionManager.appendMessage({ role: "user", content: "start", timestamp: 900 });
		sessionManager.appendMessage(bashCall("branch-a-call", "git status", 999));
		sessionManager.appendMessage(toolResultMessage("branch-a-call", 1000));
		// Reset to the fork point and grow a DIFFERENT branch from there.
		sessionManager.branch(forkPointId);
		sessionManager.appendMessage(bashCall("branch-b-call", "git status", 1099));
		sessionManager.appendMessage(toolResultMessage("branch-b-call", 1100));

		expect(resolveSessionToolEvidence(sessionManager, [], "branch-b-call", "tool").verified).toBe(true);
		expect(resolveSessionToolEvidence(sessionManager, [], "branch-a-call", "tool").verified).toBe(false);
	});

	it("through the wired path: the goal tool's kind:'tool' evidence verifies true for a real session tool call", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(bashCall("real-call-1", "git status", 999));
		sessionManager.appendMessage(toolResultMessage("real-call-1", 1000));

		let counter = 0;
		const tool = createGoalToolDefinition({
			getGoalState: () => getLatestGoalStateSnapshot(sessionManager),
			saveGoalState: (state) => {
				appendGoalStateSnapshot(sessionManager, state);
			},
			now: () => `T${counter++}`,
			// The exact function wired at runtime-builder.ts's createGoalToolDefinition call site.
			resolveToolEvidence: (uri, kind) => resolveSessionToolEvidence(sessionManager, [], uri, kind),
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
			...userStatementDependencies("user confirmed"),
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
		const { run } = createProducer(userStatementDependencies("user confirmed"));

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
		const { run } = createProducer({
			...userStatementDependencies("user confirmed"),
			getOpenTaskSteps: () => deriveOpenTaskStepRefs(taskSteps),
		});

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
