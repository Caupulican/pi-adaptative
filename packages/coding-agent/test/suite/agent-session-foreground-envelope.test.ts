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
		// capabilities are derived from the active tools (read/grep -> read_files, edit -> write_files,
		// bash -> run_shell, goal -> memory_write), deduplicated
		expect(envelope.capabilities).toContain("read_files");
		expect(envelope.capabilities).toContain("write_files");
		expect(envelope.capabilities).toContain("run_shell");
		expect(envelope.capabilities).toContain("memory_write");
		// read_files appears once despite both read and grep being active
		expect(envelope.capabilities.filter((cap) => cap === "read_files")).toHaveLength(1);
		// the per-turn cost ceiling flows through from the cost-guard setting (default 2.5)
		expect(envelope.maxEstimatedUsd).toBe(harness.settingsManager.getCostGuardSettings().maxTurnUsd);
	});

	it("omits the usd bound when the per-turn cost ceiling is disabled", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit"],
			settings: { costGuard: { maxTurnUsd: 0 } },
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("do a thing");

		expect(harness.session.getForegroundEnvelope()?.maxEstimatedUsd).toBeUndefined();
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
