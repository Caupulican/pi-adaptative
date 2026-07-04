import { describe, expect, it } from "vitest";
import {
	type AutonomyDiagnosticSnapshot,
	formatAutonomyDiagnostics,
	formatAutonomyStatus,
} from "../src/core/autonomy/status.ts";

describe("Autonomy Status Formatters (Phase 8A)", () => {
	describe("formatAutonomyStatus", () => {
		it("empty status is readable", () => {
			const status = formatAutonomyStatus({});
			expect(status).toBe("Autonomy: idle");
		});

		it("latest route reason appears", () => {
			const status = formatAutonomyStatus({
				latestRoute: { tier: "cheap", reasonCode: "simple_task", risk: "read-only" },
			});
			expect(status).toContain("Route: cheap (read-only) - simple_task");
		});

		it("latest gate reason appears", () => {
			const status = formatAutonomyStatus({
				latestGate: { outcome: "allow", gate: "research_gate", reasonCode: "allowed" },
			});
			expect(status).toContain("Gate: research_gate = allow (allowed)");
		});

		it("current/daily/spawned costs appear when present", () => {
			const status = formatAutonomyStatus({
				currentCostUsd: 0.12345,
				dailyCostUsd: 1.5,
				spawnedCostUsd: 0.05,
			});
			expect(status).toContain("Costs: current: $0.1235, daily: $1.5000, spawned: $0.0500");
		});

		it("active goal appears when present", () => {
			const status = formatAutonomyStatus({
				activeGoal: { goalId: "g1", status: "active", openRequirements: 2, stallTurns: 1 },
			});
			expect(status).toContain("Goal [g1]: active, open reqs: 2, stalls: 1");
		});

		it("active lane count appears when present", () => {
			const status = formatAutonomyStatus({
				activeLaneCount: 3,
			});
			expect(status).toContain("Lanes: 3");
		});
	});

	describe("formatAutonomyDiagnostics", () => {
		it("diagnostics omit empty sections", () => {
			const emptyDiag: AutonomyDiagnosticSnapshot = {
				routes: [],
				gates: undefined,
			};
			const result = formatAutonomyDiagnostics(emptyDiag);
			expect(result).toBe("No diagnostics available.");
		});

		it("diagnostics include route/gate/cost/research/delegation/learning/goal/processMemory sections when data exists", () => {
			const diag: AutonomyDiagnosticSnapshot = {
				routes: [{ title: "R1", reasonCode: "rc1" }],
				gates: [{ title: "G1", summary: "sum1" }],
				costs: [{ title: "C1" }],
				research: [{ title: "Res1" }],
				delegation: [{ title: "D1" }],
				learning: [{ title: "L1" }],
				goals: [{ title: "Go1" }],
				processMemory: [{ title: "process", metadata: { rssMb: 128, heapUsedMb: 64, externalMb: 8 } }],
			};
			const result = formatAutonomyDiagnostics(diag);
			expect(result).toContain("--- Routes ---");
			expect(result).toContain("- R1 [rc1]");
			expect(result).toContain("--- Gates ---");
			expect(result).toContain("Summary: sum1");
			expect(result).toContain("--- Costs ---");
			expect(result).toContain("--- Research ---");
			expect(result).toContain("--- Delegation ---");
			expect(result).toContain("--- Learning ---");
			expect(result).toContain("--- Goals ---");
			expect(result).toContain("--- Process Memory ---");
			expect(result).toContain('"rssMb":128');
		});

		it("secrets are redacted by metadata key", () => {
			const diag: AutonomyDiagnosticSnapshot = {
				gates: [
					{
						title: "SecretKeyTest",
						metadata: {
							apiKey: "my-super-secret",
							password123: "qwerty",
							safeField: "safe",
						},
					},
				],
			};
			const result = formatAutonomyDiagnostics(diag);
			expect(result).toContain('apiKey":"[REDACTED]"');
			expect(result).toContain('password123":"[REDACTED]"');
			expect(result).toContain('safeField":"safe"');
		});

		it("secrets are redacted by suspicious metadata value", () => {
			const diag: AutonomyDiagnosticSnapshot = {
				gates: [
					{
						title: "SecretValueTest",
						metadata: {
							headerAuth: "Bearer eYJ-some-jwt-token",
							openai: "sk-1234abcd",
							other: "api-key-9999",
							safeValue: "just a string",
						},
					},
				],
			};
			const result = formatAutonomyDiagnostics(diag);
			expect(result).toContain('headerAuth":"[REDACTED]"');
			expect(result).toContain('openai":"[REDACTED]"');
			expect(result).toContain('other":"[REDACTED]"');
			expect(result).toContain('safeValue":"just a string"');
		});

		it("long strings are truncated", () => {
			const longStr = "A".repeat(300);
			const diag: AutonomyDiagnosticSnapshot = {
				gates: [
					{
						title: "LongStrTest",
						summary: longStr,
						metadata: { val: longStr },
					},
				],
			};
			const result = formatAutonomyDiagnostics(diag);

			const expectedTruncated = `${"A".repeat(199)}…`;
			expect(result).toContain(expectedTruncated);
			expect(result).not.toContain(longStr);
		});

		it("nested and array metadata values are redacted and bounded", () => {
			const longStr = "B".repeat(300);
			const diag: AutonomyDiagnosticSnapshot = {
				gates: [
					{
						title: "NestedSecretTest",
						metadata: {
							nested: { token: "abc123", safe: longStr },
							values: ["Bearer nested-token", longStr],
						},
					},
				],
			};
			const result = formatAutonomyDiagnostics(diag);
			expect(result).toContain('"token":"[REDACTED]"');
			expect(result).toContain('["[REDACTED]"');
			expect(result).toContain(`${"B".repeat(199)}…`);
			expect(result).not.toContain("Bearer nested-token");
			expect(result).not.toContain(longStr);
		});

		it("status fields are redacted and bounded", () => {
			const longReason = "C".repeat(300);
			const status = formatAutonomyStatus({
				latestRoute: { tier: "cheap", reasonCode: longReason, risk: "Bearer route-token" },
			});
			expect(status).toContain("[REDACTED]");
			expect(status).toContain(`${"C".repeat(199)}…`);
			expect(status).not.toContain(longReason);
			expect(status).not.toContain("Bearer route-token");
		});

		it("formatter does not mutate input metadata", () => {
			const metadata = {
				apiKey: "super-secret",
				longText: "A".repeat(300),
			};
			const diag: AutonomyDiagnosticSnapshot = {
				gates: [
					{
						title: "MutateTest",
						metadata,
					},
				],
			};

			formatAutonomyDiagnostics(diag);

			expect(metadata.apiKey).toBe("super-secret");
			expect(metadata.longText).toHaveLength(300);
		});
	});
});
