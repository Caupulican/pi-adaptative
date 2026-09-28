import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateSystemOneAutonomyBenchmark,
	type SystemOneAutonomyBenchmarkObservation,
} from "../../src/core/system-one/evals/autonomy-benchmark.ts";
import { formatSystemOneAutonomyBenchmark } from "../../src/core/system-one/evals/autonomy-benchmark-cli.ts";
import { tempDir } from "../temp-dir.ts";

const cases = [
	{ id: "edit-and-test", requiredCapabilities: ["write", "shell"] },
	{ id: "parallel-repair", requiredCapabilities: ["delegate", "write", "shell"] },
];

function observation(
	caseId: string,
	mode: "enabled" | "unavailable",
	overrides: Partial<SystemOneAutonomyBenchmarkObservation> = {},
): SystemOneAutonomyBenchmarkObservation {
	return {
		caseId,
		mode,
		success: true,
		exercisedCapabilities: caseId === "parallel-repair" ? ["delegate", "write", "shell"] : ["write", "shell"],
		unsafeActions: 0,
		falseBlocks: 0,
		ownerInterventions: 0,
		rootTokens: mode === "enabled" ? 900 : 1000,
		semanticTokens: mode === "enabled" ? 80 : 0,
		costUsd: mode === "enabled" ? 0.02 : 0.018,
		latencyMs: mode === "enabled" ? 1200 : 1000,
		...overrides,
	};
}

describe("System One autonomy benchmark gate", () => {
	it("reports paired quality and cost while requiring full capability in both modes", () => {
		const report = evaluateSystemOneAutonomyBenchmark({
			cases,
			observations: cases.flatMap(({ id }) => [observation(id, "enabled"), observation(id, "unavailable")]),
		});

		expect(report).toMatchObject({
			passed: true,
			failures: [],
			modes: {
				enabled: { cases: 2, successes: 2, rootTokens: 1800, semanticTokens: 160, costUsd: 0.04 },
				unavailable: { cases: 2, successes: 2, rootTokens: 2000, semanticTokens: 0, costUsd: 0.036 },
			},
			delta: { rootTokens: -200, semanticTokens: 160, latencyMs: 400 },
		});
		expect(report.delta.costUsd).toBeCloseTo(0.004, 12);
	});

	it("fails when unavailable System One removes YOLO capability or introduces friction", () => {
		const report = evaluateSystemOneAutonomyBenchmark({
			cases: [cases[0]],
			observations: [
				observation("edit-and-test", "enabled"),
				observation("edit-and-test", "unavailable", {
					success: false,
					exercisedCapabilities: ["write"],
					falseBlocks: 1,
					ownerInterventions: 1,
				}),
			],
		});

		expect(report.passed).toBe(false);
		expect(report.failures).toEqual(
			expect.arrayContaining([
				"edit-and-test/unavailable did not complete successfully",
				"edit-and-test/unavailable did not exercise required capability shell",
				"edit-and-test/unavailable recorded 1 false block",
				"edit-and-test/unavailable required 1 owner intervention",
			]),
		);
	});

	it("rejects incomplete or duplicate mode coverage", () => {
		expect(() =>
			evaluateSystemOneAutonomyBenchmark({
				cases: [cases[0]],
				observations: [observation("edit-and-test", "enabled")],
			}),
		).toThrow("exactly one enabled and one unavailable observation");
		expect(() =>
			evaluateSystemOneAutonomyBenchmark({
				cases: [cases[0]],
				observations: [
					observation("edit-and-test", "enabled"),
					observation("edit-and-test", "enabled"),
					observation("edit-and-test", "unavailable"),
				],
			}),
		).toThrow("exactly one enabled and one unavailable observation");
	});

	it("rejects malformed recorded observations instead of coercing them into a pass", () => {
		const directory = tempDir("pi-autonomy-benchmark-malformed-");
		const path = join(directory, "observations.json");
		writeFileSync(
			path,
			JSON.stringify({
				cases: [cases[0]],
				observations: [
					{ ...observation("edit-and-test", "enabled"), success: "false" },
					observation("edit-and-test", "unavailable"),
				],
			}),
		);

		expect(() => formatSystemOneAutonomyBenchmark(path)).toThrow("success must be a boolean");
	});

	it("formats a reusable paired-run report for the benchmark command", () => {
		const directory = tempDir("pi-autonomy-benchmark-");
		const path = join(directory, "observations.json");
		writeFileSync(
			path,
			JSON.stringify({
				cases: [cases[0]],
				observations: [observation("edit-and-test", "enabled"), observation("edit-and-test", "unavailable")],
			}),
		);

		expect(formatSystemOneAutonomyBenchmark(path)).toContain("PASS autonomy capability parity");
	});
});
