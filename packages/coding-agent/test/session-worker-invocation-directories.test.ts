import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionContextScope, retainedToolInvocation } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { setConcurrentResponses } from "./suite/concurrent-responses.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

it.each([
	{ tool: "read", replace: false },
	{ tool: "read", replace: true },
	{ tool: "write", replace: false },
	{ tool: "write", replace: true },
])("validates worker directory before each $tool invocation (replace=$replace)", async ({ tool, replace }) => {
	const harness = await createHarness();
	const cwd = join(harness.tempDir, "worker project");
	mkdirSync(cwd);
	const file = join(cwd, "marker.txt");
	writeFileSync(file, "ORIGINAL_FIXTURE");
	let toolError: boolean | undefined;
	let output = "";
	let executionScope: string | undefined;
	const remaining = setConcurrentResponses(harness, [
		() => {
			if (replace) {
				renameSync(cwd, `${cwd}-original`);
				mkdirSync(cwd);
				writeFileSync(file, "REPLACEMENT_FIXTURE");
			}
			return fauxAssistantMessage(
				[
					fauxToolCall(tool, {
						path: tool === "write" ? "created.txt" : "marker.txt",
						...(tool === "write" ? { content: "AUTHORIZED_WRITE" } : {}),
					}),
				],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
			toolError = result ? result.isError === true : undefined;
			output = result ? getMessageText(result) : JSON.stringify(context.messages);
			executionScope = result ? retainedToolInvocation(result.details)?.executionScope : undefined;
			return fauxAssistantMessage('{"summary":"Synthetic directory probe complete","status":"completed"}');
		},
	]);
	try {
		const run = await harness.session.runWorkerDelegationOnce({
			instructions: "Run the synthetic directory probe.",
			authority: { path: cwd },
		});
		expect(remaining()).toBe(0);
		expect(toolError, output).toBe(replace);
		if (!replace) {
			if (!run.record) throw new Error("Expected synthetic worker record");
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const taskId = run.record.laneId;
			const attempt = snapshot.attempts[snapshot.tasks[taskId]!.attemptIds.at(-1)!]!;
			const context = attempt.dispatch.executionContract!.worker.executionContext!;
			const agent = snapshot.agents[attempt.agentId!]!;
			expect(executionScope).toBe(
				executionContextScope({ ...context, sessionId: agent.resumeContext.sessionId, taskId }),
			);
		}
		if (replace) {
			expect(output).not.toContain("REPLACEMENT_FIXTURE");
			expect(readFileSync(file, "utf8")).toBe("REPLACEMENT_FIXTURE");
			expect(existsSync(join(cwd, "created.txt"))).toBe(false);
		} else if (tool === "read") expect(output).toContain("ORIGINAL_FIXTURE");
		else expect(readFileSync(join(cwd, "created.txt"), "utf8")).toBe("AUTHORIZED_WRITE");
	} finally {
		await harness.cleanup();
	}
});
