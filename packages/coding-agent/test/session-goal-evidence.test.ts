import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { resolvedGoalEvidenceObservation } from "../src/core/goals/requirement-coverage.ts";
import { producingCommand, resolveSessionToolEvidence } from "../src/core/goals/session-goal-evidence.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("selects the newest equivalent simple command and preserves quoted paths and Python indentation", () => {
	const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
	function record(id: string, name: "bash" | "python", operation: string, isError = false) {
		manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			stopReason: "toolUse",
			timestamp: 1,
			usage: createEmptyUsage(),
			content: [
				{ type: "toolCall", id, name, arguments: name === "bash" ? { command: operation } : { code: operation } },
			],
		});
		manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, isError, timestamp: 2, content: [] });
	}
	record("quoted", "bash", "cat 'a  b'");
	record("other-file", "bash", "cat 'a b'");
	record("python", "python", "if True:\n    pass");
	record("other-script", "python", "if True:\n  pass");
	record("old", "bash", "npm test");
	record("retry", "bash", "npm\t test ;", true);
	const resolve = (text: string) => resolveSessionToolEvidence(manager, [], text, "tool", () => true);
	expect(resolve("cat 'a  b'")).toMatchObject({ verified: true, toolCallId: "quoted" });
	expect(resolve("if True:\n    pass")).toMatchObject({ verified: true, toolCallId: "python" });
	expect(resolve("npm test")).toMatchObject({ verified: true, toolCallId: "retry", outcome: "failed" });
	expect(
		producingCommand({
			type: "toolCall",
			id: "malformed",
			name: "run_process",
			arguments: { executable: "echo", args: [1, "ok"] },
		}),
	).toBeUndefined();
});

it("re-observes the producing call pinned in the ledger even when another command spells that ID", () => {
	const evidence = {
		id: "receipt",
		uri: "old-call",
		kind: "tool" as const,
		verified: true,
		summary: "Verification",
		createdAt: "2026-11-26",
	};
	const result = { verified: true, toolCallId: "other", outcome: "succeeded", observation: "output" };
	expect(resolvedGoalEvidenceObservation(evidence, () => result)).toBeUndefined();
	expect(resolvedGoalEvidenceObservation(evidence, () => ({ ...result, toolCallId: "old-call" }))).toBe("output");
});
