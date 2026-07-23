import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyWorkerActions, parseWorkerActions } from "../src/core/delegation/worker-actions.ts";
import { CapabilityGateway } from "../src/core/orchestration/capability-gateway.ts";
import {
	type ExecutionGrant,
	ORCHESTRATION_SCHEMA_VERSION,
	type ToolCapabilityManifest,
} from "../src/core/orchestration/contracts.ts";

describe("parseWorkerActions", () => {
	it("keeps only well-formed write/edit actions and caps the count", () => {
		const parsed = parseWorkerActions([
			{ op: "write", path: "src/a.ts", content: "x" },
			{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" },
			{ op: "write", path: "src/c.ts" }, // missing content -> dropped
			{ op: "delete", path: "src/d.ts" }, // unknown op -> dropped
			{ op: "edit", path: "src/e.ts", old: "", new: "x" }, // empty old -> dropped
		]);
		expect(parsed.map((a) => a.path)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("does not emit validation telemetry for already-valid action arrays", () => {
		const events: unknown[] = [];
		const actions = [{ op: "write", path: "src/a.ts", content: "x" }];
		const parsed = parseWorkerActions(actions, {
			provider: "worker",
			model: "local",
			telemetry: (event) => events.push(event),
		});

		expect(parsed).toEqual(actions);
		expect(events).toEqual([]);
	});

	it("repairs stringified action arrays through the shared tool validation layer", () => {
		const events: unknown[] = [];
		const parsed = parseWorkerActions(JSON.stringify([{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" }]), {
			provider: "worker",
			model: "local",
			telemetry: (event) => events.push(event),
		});

		expect(parsed).toEqual([{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" }]);
		expect(events).toMatchObject([
			{ outcome: "repaired", tool: "worker_actions", repairsApplied: ["jsonStringParse"] },
		]);
	});

	it("ignores non-arrays", () => {
		expect(parseWorkerActions(undefined)).toEqual([]);
		expect(parseWorkerActions({ op: "write" })).toEqual([]);
	});
});

describe("applyWorkerActions (execution-time grant enforcement)", () => {
	// Real temp directories, real fs: the scope check (isPathWithinEnvelope -> safeRealpathSync)
	// always resolves against node:fs, so exercising it against anything else (an in-memory
	// fake) risks the scope decision and the actual write silently disagreeing about what a
	// path resolves to. One filesystem of record for both halves keeps the two in lockstep.
	let cwd: string;
	let gateway: CapabilityGateway;
	const toolManifests: ToolCapabilityManifest[] = ["write", "edit"].map((toolName) => ({
		toolName,
		moduleSpecifier: `../tools/${toolName}.ts`,
		capabilities: ["filesystem.write"],
		roles: ["implementer"],
		enforcements: ["path-scope"],
	}));

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "worker-actions-test-"));
		mkdirSync(join(cwd, "src", "secret"), { recursive: true });
		writeFileSync(join(cwd, "src", "b.ts"), "the foo value", "utf-8");
		const grant: ExecutionGrant = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			grantId: "worker-actions-grant",
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "implementer",
			capabilities: ["filesystem.write"],
			allowedTools: ["write", "edit"],
			resources: [],
			readPaths: [],
			writePaths: [join(cwd, "src")],
			deniedPaths: [join(cwd, "src", "secret")],
			budget: { maxToolCalls: 20 },
			policyVersion: "test",
			decisionTrace: [],
			issuedAt: new Date().toISOString(),
		};
		gateway = new CapabilityGateway({ grant, cwd });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("applies in-scope writes and edits, tracking changed files", () => {
		const report = applyWorkerActions({
			actions: [
				{ op: "write", path: "src/a.ts", content: "new file" },
				{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" },
			],
			gateway,
			toolManifests,
			cwd,
		});
		expect(report.changedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(report.refused).toEqual([]);
		expect(readFileSync(join(cwd, "src", "a.ts"), "utf-8")).toBe("new file");
		expect(readFileSync(join(cwd, "src", "b.ts"), "utf-8")).toBe("the bar value");
	});

	it("inserts edit replacement text literally when it contains dollar patterns", () => {
		writeFileSync(join(cwd, "src", "b.ts"), "before TOKEN after", "utf-8");
		const replacement = "$$ $& $` $'";

		const report = applyWorkerActions({
			actions: [{ op: "edit", path: "src/b.ts", old: "TOKEN", new: replacement }],
			gateway,
			toolManifests,
			cwd,
		});

		expect(report.failed).toEqual([]);
		expect(readFileSync(join(cwd, "src", "b.ts"), "utf-8")).toBe(`before ${replacement} after`);
	});

	it("REFUSES out-of-scope and denied paths at execution time — never silently writes them", () => {
		const report = applyWorkerActions({
			actions: [
				{ op: "write", path: "docs/leak.md", content: "x" },
				{ op: "write", path: "src/secret/key.pem", content: "x" },
				{ op: "write", path: "/etc/passwd", content: "x" },
			],
			gateway,
			toolManifests,
			cwd,
		});
		expect(report.changedFiles).toEqual([]);
		expect(report.refused.map((r) => r.path).sort()).toEqual(["/etc/passwd", "docs/leak.md", "src/secret/key.pem"]);
		expect(existsSync(join(cwd, "docs", "leak.md"))).toBe(false);
		expect(existsSync(join(cwd, "src", "secret", "key.pem"))).toBe(false);
	});

	it("reports failures (missing file / old-text absent) without aborting the batch", () => {
		const report = applyWorkerActions({
			actions: [
				{ op: "edit", path: "src/missing.ts", old: "x", new: "y" },
				{ op: "write", path: "src/ok.ts", content: "ok" },
			],
			gateway,
			toolManifests,
			cwd,
		});
		expect(report.failed.map((f) => f.path)).toEqual(["src/missing.ts"]);
		expect(report.changedFiles).toEqual(["src/ok.ts"]);
		expect(readFileSync(join(cwd, "src", "ok.ts"), "utf-8")).toBe("ok");
	});

	it("a write through a real directory symlink lands exactly where the (real-fs) scope check resolved it", () => {
		mkdirSync(join(cwd, "src", "real"), { recursive: true });
		symlinkSync(join(cwd, "src", "real"), join(cwd, "src", "alias"));

		const report = applyWorkerActions({
			actions: [{ op: "write", path: "src/alias/f.txt", content: "hi" }],
			gateway,
			toolManifests,
			cwd,
		});

		expect(report.refused).toEqual([]);
		expect(readFileSync(join(cwd, "src", "real", "f.txt"), "utf-8")).toBe("hi");
	});
});
