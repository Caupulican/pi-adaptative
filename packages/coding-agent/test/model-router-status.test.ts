import { describe, expect, it } from "vitest";
import {
	formatModelRouterStatus,
	getRecentModelRouterDecisions,
	MODEL_ROUTER_DECISION_CUSTOM_TYPE,
} from "../src/core/model-router/status.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

describe("model router status formatting", () => {
	it("shows disabled state and configured models", () => {
		const text = formatModelRouterStatus({ enabled: false, cheapModel: "cheap", expensiveModel: "expensive" });

		expect(text).toContain("Status: disabled");
		expect(text).toContain("Cheap model: cheap");
		expect(text).toContain("Expensive model: expensive");
		expect(text).toContain("Routing: inactive (disabled)");
		expect(text).toContain("Latest intent: none");
		expect(text).toContain("Last decision: none");
	});

	it("shows routed activity and latest prompt intent when the latest prompt used the router", () => {
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ intent: "research", routedModel: "cheap", outcome: "routed" },
			undefined,
			[],
			undefined,
			"research",
		);

		expect(text).toContain("Routing: active");
		expect(text).toContain("Latest intent: research");
	});

	it("shows why the latest prompt skipped routing and preserves the classified intent", () => {
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			undefined,
			undefined,
			[],
			"cheap model missing auth: anthropic/claude-haiku-4-5",
			"research",
		);

		expect(text).toContain("Routing: skipped (cheap model missing auth: anthropic/claude-haiku-4-5)");
		expect(text).toContain("Latest intent: research");
		expect(text).toContain("Last decision: none");
	});

	it("does not present a previous routed decision as latest when the latest prompt skipped routing", () => {
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ intent: "modify", routedModel: "expensive", outcome: "routed" },
			undefined,
			[{ intent: "modify", routedModel: "expensive", outcome: "routed" }],
			"cheap model missing auth: anthropic/claude-haiku-4-5",
			"research",
		);

		expect(text).toContain("Routing: skipped (cheap model missing auth: anthropic/claude-haiku-4-5)");
		expect(text).toContain("Latest intent: research");
		expect(text).toContain("Last decision: none");
		expect(text).toContain("Recent decisions:");
		expect(text).toContain("modify -> expensive");
	});

	it("shows the latest routed decision and escalation retry once", () => {
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{
				intent: "research",
				routedModel: "openrouter/cheap",
				outcome: "escalated",
				retryModel: "anthropic/expensive",
			},
		);

		expect(text).toContain("Status: enabled");
		expect(text).toContain("Last decision: research -> openrouter/cheap (escalated -> anthropic/expensive)");
		expect(text).not.toContain("Escalated retry:");
	});

	it("shows history without duplicating the latest persisted decision", () => {
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ intent: "modify", routedModel: "expensive", outcome: "routed" },
			undefined,
			[{ intent: "research", routedModel: "cheap", outcome: "routed" }],
		);

		expect(text).toContain("Recent decisions:");
		expect(text).toContain("research -> cheap");
		expect(text.match(/modify -> expensive/g)).toHaveLength(1);
	});

	it("shows failed routed decisions", () => {
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ intent: "research", routedModel: "cheap", outcome: "failed" },
		);

		expect(text).toContain("Last decision: research -> cheap (failed)");
	});

	it("extracts recent persisted decisions from session custom entries", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom",
				customType: MODEL_ROUTER_DECISION_CUSTOM_TYPE,
				data: { intent: "research", routedModel: "cheap", outcome: "routed" },
				id: "1",
				parentId: null,
				timestamp: "2026-06-28T00:00:00.000Z",
			},
			{
				type: "custom",
				customType: "other",
				data: { intent: "modify", routedModel: "wrong", outcome: "routed" },
				id: "2",
				parentId: null,
				timestamp: "2026-06-28T00:00:01.000Z",
			},
		];

		expect(getRecentModelRouterDecisions(entries)).toEqual([
			{ intent: "research", routedModel: "cheap", outcome: "routed" },
		]);
	});
});
