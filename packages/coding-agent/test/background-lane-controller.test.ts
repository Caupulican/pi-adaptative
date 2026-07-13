import { describe, expect, it } from "vitest";
import { clampLaneMaxUsd, isLocalExecutionModel } from "../src/core/background-lane-controller.ts";

describe("background lane budgets", () => {
	it("clamps research lane spend to the foreground envelope cap", () => {
		expect(clampLaneMaxUsd(1.5, 0.25)).toBe(0.25);
		expect(clampLaneMaxUsd(0.1, 0.25)).toBe(0.1);
		expect(clampLaneMaxUsd(0.1, undefined)).toBe(0.1);
	});
});

describe("worker execution locality", () => {
	it("recognizes built-in and custom loopback models without classifying remote providers as local", () => {
		expect(isLocalExecutionModel({ provider: "ollama", baseUrl: "https://remote.invalid" })).toBe(true);
		expect(isLocalExecutionModel({ provider: "custom", baseUrl: "http://127.0.0.1:9000/v1" })).toBe(true);
		expect(isLocalExecutionModel({ provider: "custom", baseUrl: "http://[::1]:9000/v1" })).toBe(true);
		expect(isLocalExecutionModel({ provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" })).toBe(
			false,
		);
		expect(isLocalExecutionModel({ provider: "fugu", baseUrl: "https://api.sakana.ai/v1" })).toBe(false);
	});
});
