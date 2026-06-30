import { describe, expect, it } from "vitest";
import { classifyModelRouterIntent, classifyModelRouterRoute } from "../src/core/model-router/intent-classifier.ts";

describe("model router route classifier", () => {
	it("routes read-only questions/lookups to cheap/read-only", () => {
		const prompts = [
			"What files mention modelRouter?",
			"Explain how the memory subsystem works in this repo",
			"Summarize the differences between these files",
			"Show where cost aggregation is implemented",
			"How do I add two numbers in TypeScript?",
			"Why would npm test run slowly here?",
			"Show me the architecture of this package",
			"List tools available in this repo",
			"Read settings-manager.ts and summarize it",
		];
		for (const prompt of prompts) {
			const route = classifyModelRouterRoute(prompt);
			expect(route.tier).toBe("cheap");
			expect(route.risk).toBe("read-only");
		}
	});

	it("routes normal implementation to medium/scoped-write", () => {
		const prompts = [
			"Implement a small fix and update the relevant unit test.",
			"Fix the failing lint issue and run the focused test.",
		];
		for (const prompt of prompts) {
			const route = classifyModelRouterRoute(prompt);
			expect(route.tier).toBe("medium");
			expect(route.risk).toBe("scoped-write");
		}
	});

	it("routes mechanical refactor to medium/scoped-write", () => {
		const prompts = ["Refactor this helper without changing behavior.", "Add a unit test for this edge case."];
		for (const prompt of prompts) {
			const route = classifyModelRouterRoute(prompt);
			expect(route.tier).toBe("medium");
			expect(route.risk).toBe("scoped-write");
		}
	});

	it("routes release/publish to expensive/approval-required", () => {
		const route = classifyModelRouterRoute("Publish a release and push the tag.");
		expect(route.tier).toBe("expensive");
		expect(route.risk).toBe("approval-required");
		expect(route.reasonCode).toBe("release_or_publish");
	});

	it("routes security/auth to expensive/high-impact or approval-required", () => {
		const route = classifyModelRouterRoute("Change authentication token handling.");
		expect(route.tier).toBe("expensive");
		expect(route.risk).toBe("high-impact");
		expect(route.reasonCode).toBe("security_or_auth");
	});

	it("routes destructive/git-history operations to expensive/approval-required", () => {
		const route = classifyModelRouterRoute("Delete the generated files and reset the repo.");
		expect(route.tier).toBe("expensive");
		expect(route.risk).toBe("approval-required");
		expect(route.reasonCode).toBe("destructive_or_git_history");
	});

	it("routes core architecture/rewrite to expensive/high-impact", () => {
		const route = classifyModelRouterRoute("Rewrite the autonomous runtime architecture.");
		expect(route.tier).toBe("expensive");
		expect(route.risk).toBe("high-impact");
		expect(route.reasonCode).toBe("architecture_or_ambiguous");
	});

	it("empty prompt does not throw and returns cheap/read-only with low confidence", () => {
		const route = classifyModelRouterRoute("   ");
		expect(route.tier).toBe("cheap");
		expect(route.risk).toBe("read-only");
		expect(route.confidence).toBeLessThan(0.5);
		expect(route.reasonCode).toBe("empty_prompt");
	});

	it("compatibility wrapper classifyModelRouterIntent maps tiers to legacy research/modify", () => {
		expect(classifyModelRouterIntent("What files mention modelRouter?")).toBe("research");
		expect(classifyModelRouterIntent("Fix the failing lint issue and run the focused test.")).toBe("modify");
		expect(classifyModelRouterIntent("Publish a release and push the tag.")).toBe("modify");
	});
});
