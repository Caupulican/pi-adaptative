import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CapabilityGateway,
	CapabilityGatewayDeniedError,
	type GatewayAuditRecord,
	type GatewayInitialUsage,
} from "../src/core/orchestration/capability-gateway.ts";
import {
	type ExecutionGrant,
	ORCHESTRATION_SCHEMA_VERSION,
	type ToolCapabilityManifest,
} from "../src/core/orchestration/contracts.ts";

const tempDirs: string[] = [];

function createFixture(): { cwd: string; inside: string; outside: string } {
	const root = join(tmpdir(), `pi-capability-gateway-${process.pid}-${tempDirs.length}-${Date.now()}`);
	const cwd = join(root, "repo");
	const inside = join(cwd, "src");
	const outside = join(root, "outside");
	mkdirSync(inside, { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(inside, "file.ts"), "export {};\n", "utf-8");
	writeFileSync(join(outside, "secret.txt"), "secret\n", "utf-8");
	tempDirs.push(root);
	return { cwd, inside, outside };
}

function grant(cwd: string, budget: ExecutionGrant["budget"] = {}): ExecutionGrant {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		grantId: "grant-1",
		objectiveId: "objective-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		subjectId: "worker-1",
		role: "explorer",
		capabilities: ["filesystem.read"],
		allowedTools: ["read"],
		resources: [],
		readPaths: [join(cwd, "src")],
		writePaths: [],
		deniedPaths: [],
		budget,
		policyVersion: "policy-1",
		decisionTrace: [],
		issuedAt: "2026-07-23T12:00:00.000Z",
	};
}

const readManifest: ToolCapabilityManifest = {
	toolName: "read",
	moduleSpecifier: "./tools/read.ts",
	capabilities: ["filesystem.read"],
	roles: ["explorer"],
	enforcements: ["path-scope"],
};

function initialUsage(overrides: Partial<GatewayInitialUsage> = {}): GatewayInitialUsage {
	const usage = {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		activeWallClockMs: 0,
		...overrides,
	};
	if (overrides.totalTokens === undefined) {
		usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	}
	return usage;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("CapabilityGateway", () => {
	it("executes an allowed path-scoped tool and audits the decision", async () => {
		const fixture = createFixture();
		const audit: GatewayAuditRecord[] = [];
		const invoke = vi.fn(() => "contents");
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd),
			cwd: fixture.cwd,
			onAudit: (event) => audit.push(event),
		});

		await expect(gateway.execute(readManifest, "read", { path: "src/file.ts" }, invoke)).resolves.toBe("contents");
		expect(invoke).toHaveBeenCalledOnce();
		expect(audit).toMatchObject([{ outcome: "allow", reasonCode: "allowed", toolName: "read" }]);
	});

	it("denies an out-of-scope path before invoking the tool", async () => {
		const fixture = createFixture();
		const invoke = vi.fn();
		const gateway = new CapabilityGateway({ grant: grant(fixture.cwd), cwd: fixture.cwd });

		await expect(gateway.execute(readManifest, "read", { path: fixture.outside }, invoke)).rejects.toMatchObject({
			reasonCode: "path_outside_scope",
		});
		expect(invoke).not.toHaveBeenCalled();
	});

	it("denies a sibling path with the granted root as only a string prefix", async () => {
		const fixture = createFixture();
		const sibling = join(fixture.cwd, "src-evil", "file.ts");
		mkdirSync(join(fixture.cwd, "src-evil"));
		writeFileSync(sibling, "export const unsafe = true;\n", "utf-8");
		const gateway = new CapabilityGateway({ grant: grant(fixture.cwd), cwd: fixture.cwd });

		await expect(gateway.execute(readManifest, "read", { path: sibling }, () => "no")).rejects.toMatchObject({
			reasonCode: "path_outside_scope",
		});
	});

	it("denies a renamed or ungranted tool independently of compiler filtering", async () => {
		const fixture = createFixture();
		const gateway = new CapabilityGateway({ grant: grant(fixture.cwd), cwd: fixture.cwd });

		await expect(
			gateway.execute(readManifest, "renamed_read", { path: "src/file.ts" }, () => "no"),
		).rejects.toBeInstanceOf(CapabilityGatewayDeniedError);
	});

	it("enforces cumulative tool, token, cost, and wall-clock budgets", async () => {
		const fixture = createFixture();
		const clock = { ms: 1_000 };
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxToolCalls: 1, maxTokens: 10, maxCostUsd: 1, maxWallClockMs: 1_000 }),
			cwd: fixture.cwd,
			now: () => clock.ms,
		});
		await gateway.execute(readManifest, "read", { path: "src/file.ts" }, () => "ok");
		gateway.recordUsage({ inputTokens: 6, outputTokens: 4, costUsd: 1 });
		clock.ms += 1_000;

		await expect(gateway.execute(readManifest, "read", { path: "src/file.ts" }, () => "no")).rejects.toMatchObject({
			reasonCode: "tool_call_budget_exhausted",
		});
		expect(gateway.getUsage()).toMatchObject({ toolCalls: 1, totalTokens: 10, costUsd: 1, wallClockMs: 1_000 });
	});

	it("enforces an exhausted resumed tool-call budget", async () => {
		const fixture = createFixture();
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxToolCalls: 2 }),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ toolCalls: 2 }),
		});

		await expect(gateway.execute(readManifest, "read", { path: "src/file.ts" }, () => "no")).rejects.toMatchObject({
			reasonCode: "tool_call_budget_exhausted",
		});
	});

	it("enforces an exhausted resumed token budget", async () => {
		const fixture = createFixture();
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxTokens: 10 }),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ inputTokens: 6, outputTokens: 4 }),
		});

		await expect(gateway.execute(readManifest, "read", { path: "src/file.ts" }, () => "no")).rejects.toMatchObject({
			reasonCode: "token_budget_exhausted",
		});
	});

	it("enforces an exhausted resumed cost budget", async () => {
		const fixture = createFixture();
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxCostUsd: 1 }),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ costUsd: 1 }),
		});

		await expect(gateway.execute(readManifest, "read", { path: "src/file.ts" }, () => "no")).rejects.toMatchObject({
			reasonCode: "cost_budget_exhausted",
		});
	});

	it("enforces an exhausted resumed active wall-clock budget", async () => {
		const fixture = createFixture();
		const clock = { ms: 1_000 };
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxWallClockMs: 1_000 }),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ activeWallClockMs: 1_000 }),
			now: () => clock.ms,
		});

		await expect(gateway.execute(readManifest, "read", { path: "src/file.ts" }, () => "no")).rejects.toMatchObject({
			reasonCode: "wall_clock_budget_exhausted",
		});
	});

	it("fails closed before a resumed provider completion when cumulative budget is exhausted", () => {
		const fixture = createFixture();
		const tokenGateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxTokens: 10 }),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ inputTokens: 6, outputTokens: 4 }),
		});
		try {
			tokenGateway.assertBudgetAvailable();
			expect.unreachable("Expected exhausted token budget to deny provider completion.");
		} catch (error) {
			expect(error).toMatchObject({ reasonCode: "token_budget_exhausted" });
		}

		const clock = { ms: 1_000 };
		const activeGateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxWallClockMs: 500 }),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ activeWallClockMs: 500 }),
			now: () => clock.ms,
		});
		try {
			activeGateway.assertBudgetAvailable();
			expect.unreachable("Expected exhausted active-time budget to deny provider completion.");
		} catch (error) {
			expect(error).toMatchObject({ reasonCode: "wall_clock_budget_exhausted" });
		}
	});

	it("counts provider cache tokens in resumed cumulative token budgets", () => {
		const fixture = createFixture();
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd, { maxTokens: 10 }),
			cwd: fixture.cwd,
			initialUsage: initialUsage({
				inputTokens: 2,
				outputTokens: 1,
				cacheReadTokens: 7,
				cacheWriteTokens: 0,
				totalTokens: 10,
			}),
		});

		expect(() => gateway.assertBudgetAvailable()).toThrow(
			expect.objectContaining({ reasonCode: "token_budget_exhausted" }),
		);
	});

	it("reports the seed plus current active elapsed time", () => {
		const fixture = createFixture();
		const clock = { ms: 1_000 };
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd),
			cwd: fixture.cwd,
			initialUsage: initialUsage({
				toolCalls: 2,
				inputTokens: 3,
				outputTokens: 4,
				costUsd: 0.25,
				activeWallClockMs: 500,
			}),
			now: () => clock.ms,
		});
		clock.ms += 125;

		expect(gateway.getUsage()).toEqual({
			toolCalls: 2,
			inputTokens: 3,
			outputTokens: 4,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 7,
			costUsd: 0.25,
			wallClockMs: 625,
		});
	});

	it("rejects invalid resumed usage state before it can weaken budgets", () => {
		const fixture = createFixture();
		const invalidSnapshots: GatewayInitialUsage[] = [
			initialUsage({ toolCalls: -1 }),
			initialUsage({ inputTokens: 1.5 }),
			initialUsage({ outputTokens: Number.POSITIVE_INFINITY }),
			initialUsage({ costUsd: -0.01 }),
			initialUsage({ activeWallClockMs: Number.NaN }),
		];

		for (const initialUsage of invalidSnapshots) {
			expect(() => new CapabilityGateway({ grant: grant(fixture.cwd), cwd: fixture.cwd, initialUsage })).toThrow(
				"initial usage must contain finite non-negative values and safe-integer counts",
			);
		}
	});

	it("rejects malformed usage deltas without partially mutating cumulative usage", () => {
		const fixture = createFixture();
		const gateway = new CapabilityGateway({ grant: grant(fixture.cwd), cwd: fixture.cwd });
		gateway.recordUsage({ inputTokens: 2, outputTokens: 3, costUsd: 0.25 });
		const expectedUsage = {
			inputTokens: 2,
			outputTokens: 3,
			totalTokens: 5,
			costUsd: 0.25,
		};

		for (const delta of [
			{ inputTokens: -1 },
			{ inputTokens: 1.5 },
			{ inputTokens: null as unknown as number },
			{ outputTokens: Number.NaN },
			{ outputTokens: Number.POSITIVE_INFINITY },
			{ costUsd: -0.01 },
			{ costUsd: Number.NaN },
		]) {
			expect(() => gateway.recordUsage(delta)).toThrow(
				"usage delta must contain finite non-negative values and safe-integer token counts",
			);
			expect(gateway.getUsage()).toMatchObject(expectedUsage);
		}
	});

	it("rejects initial and incremental token totals that exceed safe integer bounds", () => {
		const fixture = createFixture();
		expect(
			() =>
				new CapabilityGateway({
					grant: grant(fixture.cwd),
					cwd: fixture.cwd,
					initialUsage: initialUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }),
				}),
		).toThrow("initial usage must contain finite non-negative values and safe-integer counts");

		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ inputTokens: Number.MAX_SAFE_INTEGER }),
		});
		expect(() => gateway.recordUsage({ outputTokens: 1 })).toThrow(
			"usage delta would exceed safe cumulative usage bounds",
		);
		expect(gateway.getUsage()).toMatchObject({
			inputTokens: Number.MAX_SAFE_INTEGER,
			outputTokens: 0,
			totalTokens: Number.MAX_SAFE_INTEGER,
		});
	});

	it("refuses a tool-call counter overflow before auditing or invoking", async () => {
		const fixture = createFixture();
		const audit = vi.fn();
		const invoke = vi.fn(() => "no");
		const gateway = new CapabilityGateway({
			grant: grant(fixture.cwd),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ toolCalls: Number.MAX_SAFE_INTEGER }),
			onAudit: audit,
		});

		await expect(gateway.execute(readManifest, "read", { path: "src/file.ts" }, invoke)).rejects.toThrow(
			"tool-call count would exceed safe cumulative usage bounds",
		);
		expect(gateway.getUsage().toolCalls).toBe(Number.MAX_SAFE_INTEGER);
		expect(audit).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
	});

	it("fails closed for invalid clock readings, elapsed overflow, and accumulated wall-clock overflow", () => {
		const fixture = createFixture();
		const invalidClock = { ms: 1_000 };
		const invalidClockGateway = new CapabilityGateway({
			grant: grant(fixture.cwd),
			cwd: fixture.cwd,
			now: () => invalidClock.ms,
		});
		invalidClock.ms = Number.NaN;
		expect(() => invalidClockGateway.getUsage()).toThrow("clock source must return a finite time");

		const elapsedOverflowClock = { ms: -Number.MAX_VALUE };
		const elapsedOverflowGateway = new CapabilityGateway({
			grant: grant(fixture.cwd),
			cwd: fixture.cwd,
			now: () => elapsedOverflowClock.ms,
		});
		elapsedOverflowClock.ms = Number.MAX_VALUE;
		expect(() => elapsedOverflowGateway.getUsage()).toThrow("active wall-clock elapsed time must be finite");

		const accumulatedClock = { ms: 0 };
		const accumulatedGateway = new CapabilityGateway({
			grant: grant(fixture.cwd),
			cwd: fixture.cwd,
			initialUsage: initialUsage({ activeWallClockMs: Number.MAX_VALUE }),
			now: () => accumulatedClock.ms,
		});
		accumulatedClock.ms = Number.MAX_VALUE;
		expect(() => accumulatedGateway.getUsage()).toThrow(
			"accumulated wall-clock usage must be finite and non-negative",
		);
	});
});
