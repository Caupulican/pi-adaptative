import { describe, expect, it } from "vitest";
import { isRepeatedWorkerToolInvocation } from "../src/core/delegation/worker-attempt-executor.ts";

describe("worker tool progress", () => {
	it("does not call distinct successful reads a repeated strategy", () => {
		expect(
			isRepeatedWorkerToolInvocation([
				{ name: "read", args: { path: "a.ts" } },
				{ name: "read", args: { path: "b.ts" } },
				{ name: "read", args: { path: "c.ts" } },
			]),
		).toBe(false);
	});

	it("detects the same call repeated three times", () => {
		expect(
			isRepeatedWorkerToolInvocation([
				{ name: "read", args: { path: "a.ts" } },
				{ name: "read", args: { path: "a.ts" } },
				{ name: "read", args: { path: "a.ts" } },
			]),
		).toBe(true);
	});
});
