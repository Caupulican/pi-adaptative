import type { AgentTool } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ResourceLoader } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const dummyTool: AgentTool<any> = {
	name: "dummy_tool",
	label: "Dummy Tool",
	description: "This is a dummy tool for testing token estimations and warning logic.",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [], details: {} }),
};

describe("AgentSession context window warnings and compaction adaptation", () => {
	it("should emit a warning when base configuration exceeds 70% of context window", async () => {
		const baseLoader = createTestResourceLoader();
		const customLoader: ResourceLoader = {
			...baseLoader,
			getSystemPrompt: () => "a".repeat(6000), // ~1500 tokens
		};

		const harness = await createHarness({
			models: [{ id: "small-model", contextWindow: 2000 }],
			tools: [dummyTool],
			resourceLoader: customLoader,
			settings: {
				defaultProvider: "faux",
				defaultModel: "small-model",
				compaction: {
					enabled: true,
					reserveTokens: 1000,
					keepRecentTokens: 500,
				},
			},
		});

		try {
			// Trigger setActiveToolsByName to run warning check after subscription is active
			harness.session.setActiveToolsByName(["dummy_tool"]);

			const warningEvents = harness.eventsOfType("warning");
			expect(warningEvents.length).toBeGreaterThanOrEqual(1);
			expect(warningEvents[0].message).toContain("Base configuration");
			expect(warningEvents[0].message).toContain("leaves very little room");
		} finally {
			harness.cleanup();
		}
	});

	it("should adapt reserveTokens and keepRecentTokens for small context windows", async () => {
		const harness = await createHarness({
			// Small model context window of 2000
			models: [{ id: "small-model", contextWindow: 2000 }],
			settings: {
				defaultProvider: "faux",
				defaultModel: "small-model",
				compaction: {
					enabled: true,
					reserveTokens: 16384, // default, too large
					keepRecentTokens: 20000, // default, too large
				},
			},
		});

		try {
			// Access internal adapted compaction settings via prototype invocation or state
			const sessionPrototype = harness.session as any;
			const adapted = sessionPrototype._getAdaptedCompactionSettings();

			// reserveTokens should be capped at 25% of 2000 = 500
			expect(adapted.reserveTokens).toBeLessThanOrEqual(500);

			// keepRecentTokens should be capped at 50% of 2000 = 1000
			expect(adapted.keepRecentTokens).toBeLessThanOrEqual(1000);
		} finally {
			harness.cleanup();
		}
	});
});
