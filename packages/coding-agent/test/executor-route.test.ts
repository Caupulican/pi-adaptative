import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import type { FauxRequestEvent } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("root-first toolkit routing", () => {
	const setup = async (danger: boolean) => {
		const requests: FauxRequestEvent[] = [];
		const harness = await createHarness({ fauxProvider: { onRequest: (event) => requests.push(event) } });
		const marker = join(harness.tempDir, "ran.txt");
		const script = join(harness.tempDir, "status.sh");
		writeFileSync(script, `#!/usr/bin/env bash\necho ran > "${marker}"\necho "status report: all green"\n`);
		chmodSync(script, 0o755);
		harness.settingsManager.applyOverrides({
			toolkit: {
				scripts: [
					{
						name: "status-report",
						description: "Print the service status report",
						aliases: ["run the status report"],
						runner: "bash",
						path: script,
						...(danger ? { danger: true } : {}),
					},
				],
			},
		});
		return { harness, requests, marker };
	};

	it("sends an exact script request to the root before the root calls the tool", async () => {
		const { harness, requests, marker } = await setup(false);
		try {
			const model = harness.session.model?.id;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("run_toolkit_script", { script: "status-report", args: [] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("status report: all green"),
			]);
			await harness.session.prompt("run the status report");
			expect(requests.length).toBeGreaterThan(0);
			expect(existsSync(marker)).toBe(true);
			expect(harness.session.model?.id).toBe(model);
			expect(harness.session.agent.state.messages.some((message) => message.role === "toolResult")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("does not execute an exact script request when the root does not call the tool", async () => {
		const { harness, requests, marker } = await setup(false);
		try {
			harness.setResponses([fauxAssistantMessage("I need more detail first.")]);
			await harness.session.prompt("run the status report");
			expect(requests).toHaveLength(1);
			expect(existsSync(marker)).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a dangerous script behind authorization after the root requests it", async () => {
		const { harness, requests, marker } = await setup(true);
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("run_toolkit_script", { script: "status-report", args: [] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Authorization required"),
			]);
			await harness.session.prompt("run the status report");
			expect(requests.length).toBeGreaterThan(0);
			expect(existsSync(marker)).toBe(false);
			const toolResult = harness.session.agent.state.messages.find((message) => message.role === "toolResult");
			expect(JSON.stringify(toolResult)).toMatch(/confirmation/);
		} finally {
			harness.cleanup();
		}
	});

	it("sends a message that only reads as the script to the talker", async () => {
		const { harness, requests, marker } = await setup(false);
		try {
			harness.setResponses([fauxAssistantMessage("It printed that all is green.")]);
			await harness.session.prompt("is the status report green?");
			expect(requests).toHaveLength(1);
			expect(existsSync(marker)).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
