import { createAssistantMessageEventStream } from "@caupulican/pi-ai";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentMessage } from "../src/types.ts";
import {
	createVerificationDismissalDetails,
	createVerificationObligationSnapshotDetails,
	retainedVerificationDetails,
	VerificationObligationTracker,
} from "../src/verification-obligations.ts";

function toolResult(details: unknown, isError = true): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "verify-call",
		toolName: "verify",
		content: [{ type: "text", text: "verification result" }],
		details,
		isError,
		timestamp: 1,
	};
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function failedVerification(id: string): ToolResultMessage {
	return toolResult({ piVerification: { version: 1, id, status: "failed" } });
}

function passedVerification(id: string): ToolResultMessage {
	return toolResult({ piVerification: { version: 1, id, status: "passed" } }, false);
}

function backgroundPlaceholder(taskId: string): ToolResultMessage {
	return toolResult({ sessionId: "session-1", taskId, status: "running" }, false);
}

function compactionSummary(details: unknown): AgentMessage {
	return {
		role: "compactionSummary",
		summary: "Compacted history",
		tokensBefore: 100,
		details,
		timestamp: 1,
	} as AgentMessage;
}

function customMessage(details: unknown): AgentMessage {
	return {
		role: "custom",
		customType: "background-terminal",
		content: "Background verification completed",
		display: false,
		details,
		timestamp: 1,
	};
}

describe("VerificationObligationTracker", () => {
	it("answers normally when the only failures were inherited from an earlier run, keeping them active", async () => {
		const failure = failedVerification("alpha");
		const handoff = assistantText("The fix needs a fixture correction before verification can pass.");
		let requests = 0;
		const loop = agentLoop(
			[{ role: "user", content: "Report the remaining work.", timestamp: 2 }],
			{ messages: [failure], systemPrompt: "Test harness", tools: [] },
			{
				model: {
					id: "mock",
					name: "mock",
					api: "openai-responses",
					provider: "test",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 2048,
				},
				convertToLlm: (messages) =>
					messages.filter(
						(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
				maxProviderTurns: 4,
			},
			undefined,
			() => {
				requests++;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: handoff });
				stream.end();
				return stream;
			},
		);
		const messages = await loop.result();
		expect(requests).toBe(1);
		// The answer is an answer: the failure belongs to an earlier run, so it stays listed and keeps
		// blocking goal completion, but this run is not marked unsuccessful for it.
		expect(messages.at(-1)).toMatchObject({ content: handoff.content, stopReason: "stop" });
		expect(new VerificationObligationTracker([failure, ...messages]).getActiveIds()).toEqual(["alpha"]);
	});
	it("preserves a useful handoff while marking the run that produced the failure as unsuccessful", () => {
		const tracker = new VerificationObligationTracker([]);
		tracker.record([failedVerification("alpha")]);
		const message = assistantText(
			"The parser fix is implemented. The regression still fails because the fixture is missing.",
		);
		const terminal = tracker.enforceTerminalMessage(message);
		expect(terminal.content).toEqual(message.content);
		expect(terminal.stopReason).toBe("error");
		expect(terminal.errorMessage).toContain("verification_handoff_required");
		expect(tracker.getActiveIds()).toEqual(["alpha"]);
		expect(tracker.getIdsOpenedThisRun()).toEqual(["alpha"]);
		tracker.record([passedVerification("alpha")]);
		expect(tracker.enforceTerminalMessage(message)).toBe(message);
	});
	it("leaves a later run's answer alone when its failures were inherited, until the run fails one itself", () => {
		const inherited = new VerificationObligationTracker([failedVerification("alpha")]);
		const message = assistantText("Here is the review you asked for.");
		expect(inherited.getIdsOpenedThisRun()).toEqual([]);
		expect(inherited.enforceTerminalMessage(message)).toBe(message);
		expect(inherited.getActiveIds()).toEqual(["alpha"]);
		// Re-failing the inherited check inside this run makes it this run's own.
		inherited.record([failedVerification("alpha")]);
		expect(inherited.getIdsOpenedThisRun()).toEqual(["alpha"]);
		expect(inherited.enforceTerminalMessage(message).stopReason).toBe("error");
	});
	it("keeps this run's own failures across a mid-run context restore, and drops them once resolved", () => {
		const tracker = new VerificationObligationTracker([]);
		const failure = failedVerification("alpha");
		tracker.record([failure]);
		tracker.restore([failure]);
		expect(tracker.getIdsOpenedThisRun()).toEqual(["alpha"]);
		expect(tracker.enforceTerminalMessage(assistantText("still red")).stopReason).toBe("error");
		tracker.restore([failure, passedVerification("alpha")]);
		expect(tracker.getIdsOpenedThisRun()).toEqual([]);
		expect(tracker.getActiveIds()).toEqual([]);
	});
	it("resolves obligations from the operator's dismissal record and never from prose", () => {
		const tracker = new VerificationObligationTracker([]);
		tracker.record([failedVerification("alpha"), failedVerification("beta")]);
		const details = createVerificationDismissalDetails(["alpha", "missing"], "environment fault");
		expect(details).toEqual({
			piVerificationDismissal: { version: 1, ids: ["alpha", "missing"], note: "environment fault" },
		});
		tracker.record([
			{
				role: "custom",
				customType: "pi_verification_dismissal",
				content: "dismissed",
				display: true,
				details,
				timestamp: 3,
			},
		]);
		expect(tracker.getActiveIds()).toEqual(["beta"]);
		expect(tracker.getIdsOpenedThisRun()).toEqual(["beta"]);
		// A malformed dismissal is ignored, never widened; a message with the type but no details clears nothing.
		tracker.record([
			{
				role: "custom",
				customType: "pi_verification_dismissal",
				content: "x",
				display: true,
				details: { piVerificationDismissal: { version: 1, ids: "beta" } },
				timestamp: 4,
			},
		]);
		expect(tracker.getActiveIds()).toEqual(["beta"]);
		expect(createVerificationDismissalDetails([])).toBeUndefined();
		expect(createVerificationDismissalDetails(["_verification_overflow"])).toBeUndefined();
	});
	it("carries the command and directory in the open, in the instruction, the view and the snapshot", () => {
		const tracker = new VerificationObligationTracker([]);
		tracker.record([
			toolResult({
				piVerification: {
					version: 1,
					id: "alpha",
					status: "failed",
					command: "vitest run test/x.test.ts",
					cwd: "/repo/packages/coding-agent",
				},
			}),
		]);
		expect(tracker.getActiveObligations()).toEqual([
			{ id: "alpha", command: "vitest run test/x.test.ts", cwd: "/repo/packages/coding-agent" },
		]);
		const instruction = tracker.requestInstruction() ?? "";
		expect(instruction).toContain("- alpha — vitest run test/x.test.ts (in /repo/packages/coding-agent)");
		expect(instruction).toContain("/verify");
		const snapshot = tracker.createSnapshotDetails();
		expect(snapshot?.piVerificationObligations.descriptions).toEqual([
			{ id: "alpha", command: "vitest run test/x.test.ts", cwd: "/repo/packages/coding-agent" },
		]);
		const restored = new VerificationObligationTracker([compactionSummary(snapshot)]);
		expect(restored.getActiveObligations()).toEqual(tracker.getActiveObligations());
		// Oversized or control-character text is bounded, never rejected as a whole record.
		const noisy = new VerificationObligationTracker([]);
		noisy.record([
			toolResult({
				piVerification: { version: 1, id: "beta", status: "failed", command: `x\u0007${"y".repeat(400)}` },
			}),
		]);
		expect(noisy.getActiveObligations()[0]?.command?.length).toBe(200);
		expect(noisy.getActiveObligations()[0]?.command?.includes("\u0007")).toBe(false);
	});
	it("does not turn opaque-id prose into successful verification", () => {
		const tracker = new VerificationObligationTracker([]);
		tracker.record([failedVerification("alpha")]);
		const message = assistantText("VERIFICATION_UNRESOLVED alpha: environment unavailable");
		expect(tracker.enforceTerminalMessage(message).stopReason).toBe("error");
		expect(tracker.getActiveIds()).toEqual(["alpha"]);
	});
	it("projects unresolved identities without requiring a special handoff grammar", () => {
		const tracker = new VerificationObligationTracker([]);
		tracker.record([failedVerification("alpha"), failedVerification("beta")]);
		const prompt = tracker.appendSystemPrompt("base");
		expect(prompt).toContain("no special answer format is required");
		expect(prompt).toContain("Analyze the red output and relevant changes");
		expect(prompt).toContain("inspect and repair the authoritative owner");
		expect(prompt).toContain("rerun the same verification");
		expect(prompt).toContain("Unrelated successful tools do not clear an obligation");
		expect(prompt).toContain("The goal cannot be completed while any verification obligation remains active");

		for (const text of [
			"The fix is incomplete; alpha and beta still fail.",
			"Everything passed.",
			"VERIFICATION_UNRESOLVED alpha: first blocker\nVERIFICATION_UNRESOLVED beta: second blocker",
			"VERIFICATION_UNRESOLVED alpha: first blocker",
			"VERIFICATION_UNRESOLVED alpha: first blocker\nVERIFICATION_UNRESOLVED alpha: duplicate blocker",
			"VERIFICATION_UNRESOLVED alpha: first blocker\nVERIFICATION_UNRESOLVED beta: second blocker\nextra text",
			"VERIFICATION_UNRESOLVED alpha: first blocker\nVERIFICATION_UNRESOLVED other: extra blocker",
		]) {
			const message = assistantText(text);
			const terminal = tracker.enforceTerminalMessage(message);
			expect(terminal.content).toEqual(message.content);
			expect(terminal.stopReason).toBe("error");
			expect(tracker.getActiveIds()).toEqual(["alpha", "beta"]);
		}
	});

	it("ignores malformed metadata and exposes sorted active ids", () => {
		const tracker = new VerificationObligationTracker([
			toolResult({ piVerification: { version: 2, id: "wrong-version", status: "failed" } }),
			toolResult({ piVerification: { version: 1, id: "contains space", status: "failed" } }),
			toolResult({ piVerification: { version: 1, id: "wrong-status", status: "unknown" } }),
			// A malformed originTaskId poisons the whole record, not just the origin field - an
			// otherwise-valid failure with untrustworthy provenance is not retained at all.
			toolResult({
				piVerification: { version: 1, id: "bad-origin", status: "failed", originTaskId: "contains space" },
			}),
			failedVerification("zeta"),
			failedVerification("alpha"),
		]);

		expect(tracker.getActiveIds()).toEqual(["alpha", "zeta"]);
	});

	it("ignores tool results whose details are not a plain object, without throwing", () => {
		for (const details of [null, "not an object", 42, ["not", "an", "object"]]) {
			const tracker = new VerificationObligationTracker([failedVerification("alpha"), toolResult(details, false)]);
			// The malformed result carries neither a verification record nor background-task
			// provenance - it is inert, not an error, and alpha (from the real failure before it)
			// stays exactly as it was.
			expect(tracker.getActiveIds()).toEqual(["alpha"]);
		}
	});

	it("keeps a repeated failed verification active without consuming another bounded slot", () => {
		const tracker = new VerificationObligationTracker([
			failedVerification("alpha"),
			failedVerification("beta"),
			failedVerification("alpha"),
		]);

		expect(tracker.getActiveIds()).toEqual(["alpha", "beta"]);
	});

	it("does not clear an obligation from an errored result that claims verification passed", () => {
		const tracker = new VerificationObligationTracker([
			failedVerification("alpha"),
			toolResult({ piVerification: { version: 1, id: "alpha", status: "passed" } }, true),
		]);

		expect(tracker.getActiveIds()).toEqual(["alpha"]);
	});

	it("retains bounded active verification evidence with an overflow witness", () => {
		const tracker = new VerificationObligationTracker(
			Array.from({ length: 18 }, (_, index) => failedVerification(`check-${String(index).padStart(2, "0")}`)),
		);

		expect(tracker.getActiveIds()).toEqual([
			"_verification_overflow",
			...Array.from({ length: 14 }, (_, index) => `check-${String(index + 2).padStart(2, "0")}`),
			"check-17",
		]);
	});

	it("retains a persisted overflow obligation when more than sixteen failures are active", () => {
		const tracker = new VerificationObligationTracker(
			Array.from({ length: 17 }, (_, index) => failedVerification(`check-${String(index).padStart(2, "0")}`)),
		);

		expect(tracker.getActiveIds()).toHaveLength(16);
		expect(tracker.getActiveIds()).toContain("_verification_overflow");
		tracker.record([passedVerification("check-00"), passedVerification("check-16")]);
		expect(tracker.getActiveIds()).toContain("_verification_overflow");

		const snapshot = createVerificationObligationSnapshotDetails(tracker.getActiveIds());
		const restored = new VerificationObligationTracker([compactionSummary(snapshot)]);
		expect(restored.getActiveIds()).toContain("_verification_overflow");
		// Inherited through the snapshot: listed, not this run's own failure.
		const answer = assistantText("VERIFICATION_UNRESOLVED check-01: a remaining failure");
		expect(restored.enforceTerminalMessage(answer)).toBe(answer);
		restored.record([failedVerification("check-01")]);
		expect(restored.enforceTerminalMessage(answer).stopReason).toBe("error");
	});

	it("never evicts the overflow witness itself, even once it is the oldest tracked entry", () => {
		// rememberFailedVerification's eviction loop deletes the OLDEST entry to make room for a new
		// one, but must skip over the overflow witness specifically if it is the oldest - evicting it
		// would silently lose the "more failures existed than could be tracked" signal. That skip
		// (`if (activeId === VERIFICATION_OVERFLOW_ID) continue`) is unreachable until the overflow
		// witness itself has become the oldest surviving entry, which takes exactly:
		//   - 16 ids to fill the bounded map (check-00..check-15);
		//   - 1 more (check-16) to trigger the FIRST overflow event, which evicts check-00 (the then-
		//     oldest) and inserts the witness at the newest position;
		//   - 15 more (check-17..check-31) to evict every one of the 15 remaining original ids
		//     (check-01..check-15) one at a time, each insertion landing newer than the witness;
		//   - 1 more (check-32) - now the witness IS the oldest entry, so this is the first insertion
		//     where the skip fires, protecting it, before evicting check-17 (the next-oldest) instead.
		// 33 distinct ids total.
		const tracker = new VerificationObligationTracker(
			Array.from({ length: 33 }, (_, index) => failedVerification(`check-${String(index).padStart(2, "0")}`)),
		);

		expect(tracker.getActiveIds()).toEqual([
			"_verification_overflow",
			...Array.from({ length: 15 }, (_, index) => `check-${String(index + 18).padStart(2, "0")}`),
		]);
	});

	it("replaces earlier obligations from a compaction snapshot before applying its later tail", () => {
		const snapshot = createVerificationObligationSnapshotDetails(["beta", "alpha"]);
		expect(snapshot).toEqual({
			piVerificationObligations: { version: 1, activeIds: ["alpha", "beta"] },
		});

		const tracker = new VerificationObligationTracker([failedVerification("state-before-restore")]);
		tracker.restore([
			failedVerification("discarded-before-compaction"),
			compactionSummary(snapshot),
			passedVerification("alpha"),
			failedVerification("tail-failure"),
		]);

		expect(tracker.getActiveIds()).toEqual(["beta", "tail-failure"]);
	});

	it("fails closed on malformed or oversized compaction snapshots", () => {
		const oversizedIds = Array.from({ length: 17 }, (_, index) => `check-${index}`);
		for (const details of [
			// Malformed at progressively earlier validation stages: the whole details value, then
			// just the piVerificationObligations candidate, then just its activeIds field, before the
			// later stages (version, canonical form, size) that the remaining cases below exercise.
			null,
			"not an object",
			{},
			{ piVerificationObligations: null },
			{ piVerificationObligations: { version: 1, activeIds: "not-an-array" } },
			{ piVerificationObligations: { version: 1, activeIds: [42, "alpha"] } },
			{ piVerificationObligations: { version: 2, activeIds: ["replacement"] } },
			{ piVerificationObligations: { version: 1, activeIds: ["contains space"] } },
			{ piVerificationObligations: { version: 1, activeIds: ["a".repeat(129)] } },
			{ piVerificationObligations: { version: 1, activeIds: ["zeta", "alpha"] } },
			{ piVerificationObligations: { version: 1, activeIds: oversizedIds } },
		]) {
			const tracker = new VerificationObligationTracker([
				failedVerification("retained-before-malformed-snapshot"),
				compactionSummary(details),
			]);
			expect(tracker.getActiveIds()).toEqual(["retained-before-malformed-snapshot"]);
		}
	});

	it("applies trusted custom verification events in array order", () => {
		const tracker = new VerificationObligationTracker([
			failedVerification("alpha"),
			backgroundPlaceholder("task-alpha"),
			backgroundPlaceholder("task-beta"),
			customMessage({
				piVerificationEvents: [
					{ version: 1, id: "alpha", status: "passed", originTaskId: "task-alpha" },
					{ version: 1, id: "beta", status: "failed", originTaskId: "task-alpha" },
					{ version: 1, id: "gamma", status: "failed", originTaskId: "task-beta" },
					{ version: 1, id: "beta", status: "passed", originTaskId: "task-alpha" },
				],
			}),
		]);

		expect(tracker.getActiveIds()).toEqual(["gamma"]);
	});

	it("fails closed with the canonical overflow obligation for oversized custom verification events", () => {
		const maxEvents = 16;
		const withinLimit = new VerificationObligationTracker([
			customMessage({
				piVerificationEvents: Array.from({ length: maxEvents }, () => ({
					version: 1,
					id: "within-limit",
					status: "failed",
				})),
			}),
		]);
		expect(withinLimit.getActiveIds()).toEqual(["within-limit"]);

		const oversized = new VerificationObligationTracker([
			failedVerification("retained-failure"),
			customMessage({
				piVerificationEvents: Array.from({ length: maxEvents + 1 }, () => undefined),
			}),
		]);
		expect(oversized.getActiveIds()).toEqual(["_verification_overflow", "retained-failure"]);
	});

	it("bounds background placeholder provenance without letting an evicted task clear a failure", () => {
		const tracker = new VerificationObligationTracker([
			failedVerification("alpha"),
			...Array.from({ length: 17 }, (_, index) => backgroundPlaceholder(`task-${String(index).padStart(2, "0")}`)),
			customMessage({
				piVerificationEvents: [{ version: 1, id: "alpha", status: "passed", originTaskId: "task-00" }],
			}),
		]);

		expect(tracker.getActiveIds()).toEqual(["alpha"]);
		tracker.record([
			customMessage({
				piVerificationEvents: [{ version: 1, id: "alpha", status: "passed", originTaskId: "task-16" }],
			}),
		]);
		expect(tracker.getActiveIds()).toEqual([]);
	});

	it("ignores a stale background pass after a newer foreground failure and after compaction", () => {
		const stalePass = customMessage({
			piVerificationEvents: [{ version: 1, id: "alpha", status: "passed", originTaskId: "task-alpha" }],
		});
		const tracker = new VerificationObligationTracker([
			backgroundPlaceholder("task-alpha"),
			failedVerification("alpha"),
			stalePass,
		]);
		expect(tracker.getActiveIds()).toEqual(["alpha"]);

		const snapshot = createVerificationObligationSnapshotDetails(tracker.getActiveIds());
		const oldWaitPass = toolResult(
			{
				taskId: "task-alpha",
				piVerification: { version: 1, id: "alpha", status: "passed", originTaskId: "task-alpha" },
			},
			false,
		);
		const restored = new VerificationObligationTracker([compactionSummary(snapshot), stalePass, oldWaitPass]);
		expect(restored.getActiveIds()).toEqual(["alpha"]);

		const fresh = new VerificationObligationTracker([
			compactionSummary(snapshot),
			backgroundPlaceholder("task-fresh"),
			customMessage({
				piVerificationEvents: [{ version: 1, id: "alpha", status: "passed", originTaskId: "task-fresh" }],
			}),
		]);
		expect(fresh.getActiveIds()).toEqual([]);
	});

	it("does not clear from legacy background passes without an origin task", () => {
		const tracker = new VerificationObligationTracker([
			failedVerification("alpha"),
			customMessage({ piVerificationEvents: [{ version: 1, id: "alpha", status: "passed" }] }),
		]);

		expect(tracker.getActiveIds()).toEqual(["alpha"]);
	});

	it("requires a background wait pass to match its top-level task id", () => {
		const tracker = new VerificationObligationTracker([
			failedVerification("alpha"),
			backgroundPlaceholder("task-alpha"),
			backgroundPlaceholder("task-beta"),
			toolResult(
				{
					taskId: "task-alpha",
					piVerification: { version: 1, id: "alpha", status: "passed", originTaskId: "task-beta" },
				},
				false,
			),
		]);

		expect(tracker.getActiveIds()).toEqual(["alpha"]);
	});

	it("ignores malformed custom verification event arrays", () => {
		for (const details of [
			{ piVerificationEvents: { version: 1, id: "replacement", status: "failed" } },
			{
				piVerificationEvents: [
					{ version: 1, id: "replacement", status: "failed" },
					{ version: 1, id: "contains space", status: "failed" },
				],
			},
		]) {
			const tracker = new VerificationObligationTracker([
				failedVerification("retained-before-malformed-events"),
				customMessage(details),
			]);
			expect(tracker.getActiveIds()).toEqual(["retained-before-malformed-events"]);
		}
	});

	it("leaves the system prompt untouched when nothing is active", () => {
		const tracker = new VerificationObligationTracker();
		expect(tracker.appendSystemPrompt("base prompt")).toBe("base prompt");
		expect(tracker.appendSystemPrompt("")).toBe("");
	});
});

describe("retainedVerificationDetails", () => {
	it("preserves a validated verification record", () => {
		const details = { piVerification: { version: 1, id: "alpha", status: "passed" } };
		expect(retainedVerificationDetails(details)).toEqual({
			piVerification: { version: 1, id: "alpha", status: "passed" },
		});
	});

	it("returns undefined for details that are not a plain object, without throwing", () => {
		for (const details of [null, "not an object", 42, ["not", "an", "object"]]) {
			expect(retainedVerificationDetails(details)).toBeUndefined();
		}
	});

	it("returns undefined when the details object carries no valid verification record", () => {
		expect(retainedVerificationDetails({})).toBeUndefined();
		expect(
			retainedVerificationDetails({ piVerification: { version: 2, id: "alpha", status: "passed" } }),
		).toBeUndefined();
	});
});
