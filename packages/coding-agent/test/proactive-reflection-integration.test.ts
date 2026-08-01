import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("proactive reflection across session modes", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop();
			if (!harness) continue;
			await harness.session.disposeAndWait();
			harness.cleanup();
		}
	});

	it("learns explicit durable guidance from a print-mode turn without an interactive controller", async () => {
		const harness = await createHarness({
			settings: {
				autoLearn: { enabled: true, reflectionReview: true },
			},
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const reflectionUsage = {
			input: 20,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		};
		harness.setResponses([
			fauxAssistantMessage("Understood."),
			{
				...fauxAssistantMessage(
					'```json\n{"rationale":"durable preference","writes":[{"kind":"memory_add","section":"USER","text":"User prefers bounded diagnostic output."}]}\n```',
				),
				usage: reflectionUsage,
			},
		]);

		await harness.session.prompt("From now on, remember that I prefer bounded diagnostic output.");
		const userFile = join(harness.tempDir, "USER.md");
		await vi.waitFor(() => {
			expect(existsSync(userFile)).toBe(true);
			expect(readFileSync(userFile, "utf-8")).toContain("User prefers bounded diagnostic output.");
		});
		expect(harness.session.getLearningAuditRecords().at(-1)).toMatchObject({
			action: "apply",
			reasonCode: "explicit_user_memory_instruction",
		});
		expect(harness.session.getSpawnedUsage().reports).toBe(1);

		const scheduler = (
			harness.session as unknown as {
				_reflection: { scheduleFromTurn(messages: AgentMessage[], headroom: number): void };
			}
		)._reflection;
		scheduler.scheduleFromTurn(
			[
				{
					role: "user",
					content: [{ type: "text", text: "From now on, remember that I prefer bounded diagnostic output." }],
					timestamp: 1,
				},
				fauxAssistantMessage("Understood."),
			],
			90,
		);
		await Promise.resolve();
		expect(harness.session.getSpawnedUsage().reports).toBe(1);
	});
});
