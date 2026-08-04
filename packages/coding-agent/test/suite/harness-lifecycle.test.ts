import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("suite harness lifecycle", () => {
	it("keeps the owned directory until asynchronous session disposal finishes", async () => {
		const harness = await createHarness();
		const cleanup = harness.cleanup();

		expect(existsSync(harness.tempDir)).toBe(true);
		await cleanup;
		expect(existsSync(harness.tempDir)).toBe(false);
	});
});
