/**
 * G7: after a foreground prompt turn, AgentSession exposes an auto-constructed foreground
 * CapabilityEnvelope (observe-only; NOT enforced) via getForegroundEnvelope(), and the /context
 * dashboard surfaces one bounded line describing it.
 */

import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession foreground envelope (G7, observe-only)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reflects the active tools and cwd after a prompt turn", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "grep", "edit", "bash", "goal"],
		});
		harnesses.push(harness);

		// no envelope before any turn has run
		expect(harness.session.getForegroundEnvelope()).toBeUndefined();

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("do a thing");

		const envelope = harness.session.getForegroundEnvelope();
		expect(envelope).toBeDefined();
		if (!envelope) return;

		expect(envelope.id).toMatch(/^foreground-turn-\d+$/);
		// allowedTools mirrors whatever the session actually activated for the turn
		expect(envelope.allowedTools).toEqual(harness.session.getActiveToolNames());
		// path scope is the working directory
		expect(envelope.allowedPaths).toEqual([harness.tempDir]);
		// Capabilities are derived from active tools and deduplicated.
		expect(envelope.capabilities).toContain("filesystem.read");
		expect(envelope.capabilities).toContain("filesystem.write");
		expect(envelope.capabilities).toContain("process.exec");
		expect(envelope.capabilities).toContain("memory.mutate");
		// filesystem.read appears once despite both read and grep being active.
		expect(envelope.capabilities.filter((cap) => cap === "filesystem.read")).toHaveLength(1);
		// Productive foreground work has no implicit spend ceiling.
		expect(harness.settingsManager.getCostGuardSettings().maxTurnUsd).toBe(0);
		expect(envelope.maxEstimatedUsd).toBeUndefined();
	});

	it("projects an explicitly configured per-turn cost ceiling", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit"],
			settings: { costGuard: { maxTurnUsd: 1.25 } },
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("do a thing");

		expect(harness.session.getForegroundEnvelope()?.maxEstimatedUsd).toBe(1.25);
	});

	it("surfaces one bounded foreground-envelope line on the /context dashboard", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit", "bash"],
		});
		harnesses.push(harness);

		// before any turn: the dashboard still shows a live preview line
		const dashboardBefore = harness.session.formatContextCompositionDashboard();
		expect(dashboardBefore).toContain("foreground envelope:");
		expect(dashboardBefore).toContain("path scope");

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("go");

		const report = harness.session.getContextCompositionReport();
		const line = report.observations.find((observation) => observation.startsWith("foreground envelope:"));
		expect(line).toBeDefined();
		expect(line).toContain("capability(ies)");
		expect(line).toContain("tool(s)");
		expect(line).toContain(harness.tempDir);
	});
});
