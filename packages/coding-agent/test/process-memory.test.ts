import { describe, expect, it } from "vitest";
import { getProcessMemoryMb } from "../src/utils/process-memory.ts";

describe("getProcessMemoryMb", () => {
	it("reports rss/heapUsed/external as non-negative whole megabytes", () => {
		const memory = getProcessMemoryMb();

		expect(Number.isInteger(memory.rssMb)).toBe(true);
		expect(Number.isInteger(memory.heapUsedMb)).toBe(true);
		expect(Number.isInteger(memory.externalMb)).toBe(true);
		expect(memory.rssMb).toBeGreaterThan(0);
		expect(memory.heapUsedMb).toBeGreaterThanOrEqual(0);
		expect(memory.externalMb).toBeGreaterThanOrEqual(0);
	});
});
