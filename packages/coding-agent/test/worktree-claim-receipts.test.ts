import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { collectClaimReceipts } from "../src/core/system-one/claim-delivery.ts";

function receipt(action: string, details: Record<string, unknown>, isError = false) {
	return collectClaimReceipts([
		{
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			usage: createEmptyUsage(),
			timestamp: 1,
			stopReason: "toolUse",
			content: [{ type: "toolCall", name: "worktree_sync", id: "call", arguments: { action } }],
		},
		{
			role: "toolResult",
			toolName: "worktree_sync",
			toolCallId: "call",
			timestamp: 2,
			content: [{ type: "text", text: "landed; gate passed" }],
			details,
			isError,
		},
	]);
}

it("counts only the landed change set and the gate that actually ran", () => {
	const paths = ["sources/build.ts", "state/latest.ts"];
	const landed = { code: "ok", changedPaths: paths, changedPathsTruncated: false, gate: "passed" };
	expect(receipt("land", landed)).toMatchObject({ filesChanged: paths, checks: { passed: 1 }, tests: { passed: 0 } });
	expect(receipt("land", { ...landed, gate: "off", changedPaths: [] })).toMatchObject({
		filesChanged: [],
		checks: { passed: 0 },
	});
	expect(receipt("land", { ...landed, code: "gate_failed" })).toMatchObject({
		filesChanged: [],
		checks: { passed: 0, failed: 1 },
	});
	expect(receipt("land", landed, true).filesChanged).toEqual([]);
	expect(receipt("git_diff", landed).filesChanged).toEqual([]);
	expect(receipt("land", { ...landed, changedPaths: [7, "unproven"] }).filesChanged).toEqual([]);
	expect(receipt("land", { code: "ok", gate: "passed" }).filesChanged).toEqual([]);
});

it("recognizes typed lane commits and checks from structured results", () => {
	expect(receipt("git_commit", { code: "ok", action: "git_commit" }).commits.succeeded).toBe(1);
	expect(receipt("git_commit", { code: "git_failed", action: "git_commit" }).commits).toEqual({
		succeeded: 0,
		failed: 1,
	});
	expect(receipt("git_add", { code: "ok", action: "git_add" }).commits.succeeded).toBe(0);
	expect(receipt("check", { code: "ok", action: "check" }).checks?.passed).toBe(1);
	expect(receipt("check", { code: "gate_command_unset" }).checks?.lastPassed).toBeUndefined();
});

it("keeps typed test evidence separate from the generic landing check", () => {
	const result = receipt("land", {
		code: "ok",
		gate: "passed",
		changedPaths: ["module.ts"],
		piVerification: { version: 1, id: "test-witness", outcome: "executed", status: "failed", evidence: "tests" },
	});
	expect(result.tests).toMatchObject({ failed: 1, lastPassed: false });
	expect(result.checks?.passed).toBe(0);
});
