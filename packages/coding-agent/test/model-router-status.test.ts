import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import {
	formatModelRouterStatus,
	getRecentModelRouterDecisions,
	MODEL_ROUTER_DECISION_CUSTOM_TYPE,
} from "../src/core/model-router/status.ts";

describe("model router status formatting", () => {
	it("shows disabled state and configured models", () => {
		const text = formatModelRouterStatus({
			enabled: false,
			cheapModel: "cheap",
			mediumModel: "medium",
			expensiveModel: "expensive",
			learningModel: "learner",
		});

		expect(text).toContain("Status: disabled");
		expect(text).toContain("Cheap model: cheap · thinking (inherit)");
		expect(text).toContain("Medium model: medium · thinking (inherit)");
		expect(text).toContain("Expensive model: expensive · thinking (inherit)");
		expect(text).toContain("Executor model: unset · thinking (inherit)");
		expect(text).toContain("Judge model: unset · thinking (inherit)");
		expect(text).toContain("Learning model: learner");
		expect(text).toContain("Routing: inactive (disabled)");
		expect(text).toContain("Latest intent: none");
		expect(text).toContain("Last decision: none");
	});

	it("shows medium model as unset when absent", () => {
		const text = formatModelRouterStatus({
			enabled: false,
			cheapModel: "cheap",
			expensiveModel: "expensive",
		});
		expect(text).toContain("Medium model: unset");
	});

	it("shows routed activity and latest prompt intent when the latest prompt used the router", () => {
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "read_only_question",
			reasons: [],
		};
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ route, routedModel: "cheap", outcome: "routed" },
			undefined,
			[],
			undefined,
			"research",
		);

		expect(text).toContain("Routing: active");
		expect(text).toContain("Latest intent: research");
		expect(text).toContain("Last decision: cheap/read-only -> cheap (read_only_question, routed)");
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
		const route: RouteDecision = {
			tier: "expensive",
			risk: "high-impact",
			confidence: 1.0,
			reasonCode: "test_run",
			reasons: [],
		};
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ route, routedModel: "expensive", outcome: "routed" },
			undefined,
			[{ route, routedModel: "expensive", outcome: "routed" }],
			"cheap model missing auth: anthropic/claude-haiku-4-5",
			"research",
		);

		expect(text).toContain("Routing: skipped (cheap model missing auth: anthropic/claude-haiku-4-5)");
		expect(text).toContain("Latest intent: research");
		expect(text).toContain("Last decision: none");
		expect(text).toContain("Recent decisions:");
		expect(text).toContain("expensive/high-impact -> expensive (test_run, routed)");
	});

	it("shows the latest routed decision and escalation retry once", () => {
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.8,
			reasonCode: "explain",
			reasons: [],
		};
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{
				route,
				routedModel: "openrouter/cheap",
				outcome: "escalated",
				retryModel: "anthropic/expensive",
			},
		);

		expect(text).toContain("Status: enabled");
		expect(text).toContain(
			"Last decision: cheap/read-only -> openrouter/cheap (explain, escalated -> anthropic/expensive)",
		);
	});

	it("shows exhausted entries and the last failover notice", () => {
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			undefined,
			undefined,
			[],
			undefined,
			undefined,
			undefined,
			{
				exhausted: ["openai-codex/codex-spark", "openai-codex/gpt-5.5"],
				lastNotice: "codex-spark quota reached — switched to openai-codex/gpt-5.5",
			},
		);

		expect(text).toContain("Exhausted models: openai-codex/codex-spark, openai-codex/gpt-5.5");
		expect(text).toContain("Last failover: codex-spark quota reached — switched to openai-codex/gpt-5.5");
	});

	it("shows history without duplicating the latest persisted decision", () => {
		const route1: RouteDecision = {
			tier: "expensive",
			risk: "high-impact",
			confidence: 1.0,
			reasonCode: "test_run",
			reasons: [],
		};
		const route2: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ route: route1, routedModel: "expensive", outcome: "routed" },
			undefined,
			[{ route: route2, routedModel: "cheap", outcome: "routed" }],
		);

		expect(text).toContain("Recent decisions:");
		expect(text).toContain("cheap/read-only -> cheap (explain, routed)");
		expect(text.match(/expensive\/high-impact -> expensive/g)).toHaveLength(1);
	});

	it("shows failed routed decisions", () => {
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};
		const text = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", expensiveModel: "expensive" },
			{ route, routedModel: "cheap", outcome: "failed" },
		);

		expect(text).toContain("Last decision: cheap/read-only -> cheap (explain, failed)");
	});

	it("shows per-tier fitness only when the gate is enabled", () => {
		const gateOff = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", mediumModel: "medium", expensiveModel: "expensive" },
			undefined,
			undefined,
			[],
			undefined,
			undefined,
			{
				cheap: { status: "fit" },
				medium: { status: "unprobed" },
				expensive: { status: "unfit", lane: "worker", succeeded: 1, total: 3 },
			},
		);
		expect(gateOff).not.toContain("fitness");

		const gateOn = formatModelRouterStatus(
			{ enabled: true, fitnessGate: true, cheapModel: "cheap", mediumModel: "medium", expensiveModel: "expensive" },
			undefined,
			undefined,
			[],
			undefined,
			undefined,
			{
				cheap: { status: "fit" },
				medium: { status: "unprobed" },
				expensive: { status: "unfit", lane: "worker", succeeded: 1, total: 3 },
			},
		);
		expect(gateOn).toContain("Cheap model: cheap · thinking (inherit) · fitness fit");
		expect(gateOn).toContain("Medium model: medium · thinking (inherit) · fitness unprobed");
		expect(gateOn).toContain("Expensive model: expensive · thinking (inherit) · fitness UNFIT (worker 1/3)");
	});

	it("shows medium and expensive routed decisions clearly", () => {
		const mediumRoute: RouteDecision = {
			tier: "medium",
			risk: "scoped-write",
			confidence: 0.85,
			reasonCode: "normal_implementation",
			reasons: [],
		};
		const expensiveRoute: RouteDecision = {
			tier: "expensive",
			risk: "approval-required",
			confidence: 0.9,
			reasonCode: "release_or_publish",
			reasons: [],
		};

		const textMed = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", mediumModel: "medium", expensiveModel: "expensive" },
			{ route: mediumRoute, routedModel: "medium", outcome: "routed" },
		);
		expect(textMed).toContain("Last decision: medium/scoped-write -> medium (normal_implementation, routed)");

		const textExp = formatModelRouterStatus(
			{ enabled: true, cheapModel: "cheap", mediumModel: "medium", expensiveModel: "expensive" },
			{ route: expensiveRoute, routedModel: "expensive", outcome: "routed" },
		);
		expect(textExp).toContain("Last decision: expensive/approval-required -> expensive (release_or_publish, routed)");
	});

	it("extracts recent persisted decisions from session custom entries and ignores malformed safely", () => {
		const validRoute: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};
		const entries: SessionEntry[] = [
			{
				type: "custom",
				customType: MODEL_ROUTER_DECISION_CUSTOM_TYPE,
				data: { route: validRoute, routedModel: "cheap", outcome: "routed" },
				id: "1",
				parentId: null,
				timestamp: "2026-06-28T00:00:00.000Z",
			},
			{
				type: "custom",
				customType: MODEL_ROUTER_DECISION_CUSTOM_TYPE,
				data: { intent: "research" }, // malformed, missing route
				id: "2",
				parentId: null,
				timestamp: "2026-06-28T00:00:01.000Z",
			},
			{
				type: "custom",
				customType: "other",
				data: { route: validRoute, routedModel: "wrong", outcome: "routed" },
				id: "3",
				parentId: null,
				timestamp: "2026-06-28T00:00:02.000Z",
			},
		];

		const recent = getRecentModelRouterDecisions(entries);
		expect(recent).toHaveLength(1);
		expect(recent[0].route.tier).toBe("cheap");
		expect(recent[0].routedModel).toBe("cheap");
	});
});
