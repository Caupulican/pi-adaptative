import { describe, expect, it } from "vitest";
import { requireBoundedTrimmedText } from "../src/core/util/bounded-value.ts";

describe("requireBoundedTrimmedText", () => {
	it("trims one valid durable text field", () => {
		expect(requireBoundedTrimmedText("  worker-1  ", 8, "Worker id")).toBe("worker-1");
	});

	it("rejects empty, oversized, and invalid-bound inputs", () => {
		expect(() => requireBoundedTrimmedText("   ", 8, "Worker id")).toThrow(
			"Worker id must be between 1 and 8 characters.",
		);
		expect(() => requireBoundedTrimmedText("worker-12", 8, "Worker id")).toThrow(
			"Worker id must be between 1 and 8 characters.",
		);
		expect(() => requireBoundedTrimmedText("worker", 0, "Worker id")).toThrow(
			"A bounded text maximum must be a positive safe integer.",
		);
	});
});
