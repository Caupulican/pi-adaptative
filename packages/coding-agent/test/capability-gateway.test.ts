import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CapabilityGateway,
	CapabilityGatewayDeniedError,
	type GatewayAuditRecord,
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
});
