import { describe, expect, it } from "vitest";
import { deriveWorkerTaskLabel } from "../src/core/delegation/worker-task-label.ts";

describe("deriveWorkerTaskLabel", () => {
	it("normalizes a worker instruction into one bounded durable UI label", () => {
		expect(deriveWorkerTaskLabel("  Inspect the router\n\nand report evidence.  ", "Worker")).toBe(
			"Inspect the router and report evidence.",
		);
		const label = deriveWorkerTaskLabel("long ".repeat(80), "Worker");
		expect(label.length).toBe(120);
		expect(label.endsWith("…")).toBe(true);
	});

	it("uses the explicit fallback for empty instructions", () => {
		expect(deriveWorkerTaskLabel(" \n ", "Delegated worker work")).toBe("Delegated worker work");
	});
});
