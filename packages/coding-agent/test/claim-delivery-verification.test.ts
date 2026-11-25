import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import { BACKGROUND_TOOL_COMPLETION_TYPE } from "../src/core/background-tool-handoff-text.ts";
import { AnswerClaimChecker, collectClaimReceipts, judgeClaims } from "../src/core/system-one/claim-delivery.ts";
import { classifyShellVerificationCommand } from "../src/core/tools/shell-test-command.ts";
import { turnWorkWindow, WORKER_RECEIPTS_CUSTOM_TYPE } from "../src/core/work-units.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import type { AgentMessage } from "../src/kernel/types.ts";

it("recognizes static check chains without treating arbitrary shell status as verification", () => {
	const context = { cwd: "/repo", flavor: "posix" } as const;
	for (const command of [
		"cd /repo && node scripts/check-file-size.mjs && node scripts/check-ts-relative-imports.mjs && node scripts/architecture-map.mjs --check",
		"npm run check && git diff HEAD --check",
	]) {
		expect(classifyShellVerificationCommand(command, { ...context, staticOnly: true })?.runners).toContain("command");
	}
	for (const command of [
		"node scripts/architecture-map.mjs",
		"git diff --check",
		"git diff --check --no-index",
		"npm run check || echo 'exit: 0'",
		"npm run check; printf 'exit: 0'",
	]) {
		expect(classifyShellVerificationCommand(command, context)).toBeUndefined();
	}
});

it("counts saved background check evidence once even when a waiter also delivered it", () => {
	const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()));
	const opening = manager.appendMessage({ role: "user", content: "Check the source", timestamp: 0 });
	const verification = { version: 1, id: "static-check", status: "passed", outcome: "executed", evidence: "command" };
	const terminal = {
		taskId: "tool-task-1",
		toolCallId: "original-call",
		status: "completed",
		toolName: "bash",
		piToolInvocation: {
			version: 1,
			requestId: "original-request",
			execution: "completed",
			operationStatus: "success",
			postprocessingFailures: [],
		},
		piVerification: { ...verification, originTaskId: "tool-task-1" },
	};
	manager.appendCustomMessageEntry(BACKGROUND_TOOL_COMPLETION_TYPE, "Finished", true, {
		records: [terminal, { ...terminal, taskId: "tool-task-2" }],
	});
	const window = turnWorkWindow(manager, WORKER_RECEIPTS_CUSTOM_TYPE, opening);
	const messages: AgentMessage[] = window.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
	messages.push(
		{
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			timestamp: 1,
			usage: createEmptyUsage(),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "wait-call", name: "tool_task", arguments: { action: "wait" } }],
		},
		{
			role: "toolResult",
			toolCallId: "wait-call",
			toolName: "tool_task",
			content: [],
			timestamp: 2,
			isError: false,
			details: { taskId: terminal.taskId, status: "completed", piVerification: terminal.piVerification },
		},
	);
	const receipts = collectClaimReceipts(messages);
	expect(receipts.checks).toEqual({ passed: 1, failed: 0, lastPassed: true });
	expect(receipts.tests.passed).toBe(0);

	const handoff = messages.find((message) => message.role === "custom");
	if (handoff?.role !== "custom") throw new Error("The saved handoff is missing from the claim window");
	const failed = {
		...terminal,
		taskId: "tool-task-3",
		toolCallId: "failed-call",
		status: "failed",
		piToolInvocation: { ...terminal.piToolInvocation, operationStatus: "error" },
		piVerification: { ...verification, status: "failed", originTaskId: "tool-task-3" },
	};
	const thirdParty = {
		...terminal,
		taskId: "tool-task-4",
		piVerification: { ...verification, originTaskId: "tool-task-4" },
	};
	const replay = collectClaimReceipts([
		...messages.slice(-2),
		{ ...handoff, details: { records: [failed] } },
		handoff,
		{ ...handoff, details: { records: [thirdParty], thirdParty: true } },
	]);
	expect(replay.checks).toEqual({ passed: 1, failed: 1, lastPassed: false });
});

it("warns on missing check evidence without a paid consultation or correction turn", async () => {
	const warn = vi.fn();
	const settle = vi.fn();
	const checker = new AnswerClaimChecker({ getController: () => undefined, warn, settle });
	const answers = { states_checks_pass: { kind: "choice", choice: "current_success", confidence: 0.99 } };
	const empty = collectClaimReceipts([]);
	await expect(checker.resolve(judgeClaims(answers, empty), "The checks pass.", [])).resolves.toBeUndefined();
	expect(settle).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledOnce();
	const failed = { ...empty, checks: { passed: 0, failed: 1, lastPassed: false } };
	await expect(checker.resolve(judgeClaims(answers, failed), "The checks pass.", [])).resolves.toContain("failed");
});
