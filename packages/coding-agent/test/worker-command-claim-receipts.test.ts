import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { commandReceiptFor } from "../src/core/delegation/worker-receipts.ts";
import { collectClaimReceipts } from "../src/core/system-one/claim-delivery.ts";
import { stampToolInvocation } from "../src/kernel/tool-invocation-receipt.ts";

function workerCheck(
	tool: string,
	args: Record<string, unknown>,
	exitCode: number,
	verification?: Record<string, unknown>,
) {
	const isError = exitCode !== 0;
	const details = stampToolInvocation(
		{ exitCode, ...verification },
		{
			version: 1,
			requestId: "request",
			execution: "completed",
			operationStatus: isError ? "error" : "success",
			postprocessingFailures: [],
		},
	);
	const receipt = commandReceiptFor({
		requestId: "request",
		toolCallId: "call",
		toolName: tool,
		args,
		isError,
		result: { details },
	})!;
	return collectClaimReceipts(
		[
			{
				role: "assistant",
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				timestamp: 1,
				usage: createEmptyUsage(),
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: tool, id: "call", arguments: args }],
			},
			{ role: "toolResult", toolCallId: "call", toolName: tool, content: [], timestamp: 2, isError, details },
		],
		[receipt],
	);
}

it("requires a genuine static check before a cited worker command can support a checks claim", () => {
	const noChecks = { checks: { passed: 0, failed: 0 }, tests: { passed: 0, failed: 0 } };
	for (const command of [
		"echo passed",
		"cat scripts/check-contract.mjs",
		"vitest run",
		"tsc --version",
		`tsc --noEmit ${"a".repeat(800)} || echo passed`,
	]) {
		expect(workerCheck("bash", { command }, 0)).toMatchObject(noChecks);
	}
	expect(workerCheck("python", { code: 'print("tsc --noEmit")' }, 0)).toMatchObject(noChecks);
	expect(workerCheck("run_process", { executable: "echo", args: ["tsc --noEmit"] }, 0)).toMatchObject(noChecks);
	expect(workerCheck("bash", { command: "npm run check:contracts" }, 0)).toMatchObject({ checks: { passed: 1 } });
	expect(workerCheck("run_process", { executable: "tsc", args: ["--noEmit"] }, 2)).toMatchObject({
		checks: { passed: 0, failed: 1 },
		tests: { failed: 0 },
	});
	expect(
		workerCheck("bash", { command: "tsc --noEmit" }, 0, {
			piVerification: { version: 1, id: "partial", status: "failed", outcome: "unconfirmed" },
		}),
	).toMatchObject(noChecks);
});
