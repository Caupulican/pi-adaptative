import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../suite/harness.ts";
import { completedWorkerOutput } from "../worker-output-fixture.ts";
import { createHostResponseScript } from "./host-response-script.ts";

describe("host profiling response ownership", () => {
	it("keeps an undefined foreground affinity distinct from the first worker affinity", async () => {
		const affinities: Array<string | undefined> = [];
		const harness = await createHarness({
			fauxProvider: { onRequest: (event) => affinities.push(event.sessionId) },
			settings: { autoLearn: { enabled: false }, workerDelegation: { enabled: true, maxConcurrent: 1 } },
		});
		const script = createHostResponseScript(harness.faux);
		script.setResponses([fauxAssistantMessage("Foreground ready.")]);
		await harness.session.prompt("Profile one worker.", { autoContinueGoal: false });
		expect(affinities).toEqual([undefined]);
		const target = join(harness.tempDir, "worker-target.txt");
		writeFileSync(target, "worker-only evidence");
		let workerReads = 0;
		script.setResponses(
			[
				fauxAssistantMessage([fauxToolCall("read", { path: target })], { stopReason: "toolUse" }),
				(context) => {
					const result = context.messages.at(-1);
					expect(result).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
					expect(getMessageText(result)).toContain("worker-only evidence");
					workerReads++;
					return fauxAssistantMessage(completedWorkerOutput("Worker inspected its target."));
				},
			],
			true,
		);
		const run = await harness.session.runWorkerDelegationOnce({ instructions: "Inspect the worker target." });
		expect(run.started).toBe(true);
		expect(run.outcome?.claim.status, JSON.stringify(run.outcome)).toBe("completed");
		expect(workerReads).toBe(1);
		expect(affinities.slice(1).some((affinity) => affinity !== undefined)).toBe(true);
	});

	for (const compact of [false, true]) {
		it(`preserves the foreground task-step script with compaction=${compact}`, async () => {
			const harness = await createHarness({ settings: { autoLearn: { enabled: false } } });
			const script = createHostResponseScript(harness.faux);
			script.setResponses([fauxAssistantMessage("Ready for the profiling task.")]);
			await harness.session.prompt("Profile the host task-step lifecycle.", { autoContinueGoal: false });
			script.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task_steps", { action: "add", content: "profile step", status: "in_progress" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("task_steps", { action: "update", id: "current", status: "completed" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Profile step completed."),
			]);
			if (compact) await harness.session.compact();
			expect(script.getSummaryCount() > 0).toBe(compact);
			await harness.session.prompt("Continue the script.", { autoContinueGoal: false });
			const results = harness
				.eventsOfType("message_end")
				.flatMap((event) => (event.message.role === "toolResult" ? [event.message] : []));
			expect(results).toHaveLength(2);
			expect(results.every((result) => !result.isError)).toBe(true);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Profile step completed." }],
			});
		});
	}
});
