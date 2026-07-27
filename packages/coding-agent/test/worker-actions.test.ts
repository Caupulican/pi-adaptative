import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerActionJournal } from "../src/core/delegation/worker-action-journal.ts";
import {
	applyWorkerActions,
	MAX_WORKER_ACTION_EDIT_TARGET_BYTES,
	MAX_WORKER_ACTION_PATH_CHARS,
	MAX_WORKER_ACTION_PAYLOAD_CHARS,
	MAX_WORKER_ACTION_TEXT_CHARS,
	parseWorkerActions,
} from "../src/core/delegation/worker-actions.ts";
import { CapabilityGateway } from "../src/core/orchestration/capability-gateway.ts";
import {
	type ExecutionGrant,
	ORCHESTRATION_SCHEMA_VERSION,
	type ToolCapabilityManifest,
} from "../src/core/orchestration/contracts.ts";

describe("parseWorkerActions", () => {
	it("rejects an entire action batch when any action is malformed", () => {
		const parsed = parseWorkerActions([
			{ op: "write", path: "src/a.ts", content: "x" },
			{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" },
			{ op: "write", path: "src/c.ts" },
			{ op: "delete", path: "src/d.ts" },
			{ op: "edit", path: "src/e.ts", old: "", new: "x" },
		]);
		expect(parsed).toMatchObject({ kind: "rejected", reasonCode: "worker_actions_invalid_shape" });
	});

	it("does not emit validation telemetry for already-valid action arrays", () => {
		const events: unknown[] = [];
		const actions = [{ op: "write", path: "src/a.ts", content: "x" }];
		const parsed = parseWorkerActions(actions, {
			provider: "worker",
			model: "local",
			telemetry: (event) => events.push(event),
		});

		expect(parsed).toEqual({ kind: "accepted", actions });
		expect(events).toEqual([]);
	});

	it("repairs stringified action arrays through the shared tool validation layer", () => {
		const events: unknown[] = [];
		const parsed = parseWorkerActions(JSON.stringify([{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" }]), {
			provider: "worker",
			model: "local",
			telemetry: (event) => events.push(event),
		});

		expect(parsed).toEqual({
			kind: "accepted",
			actions: [{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" }],
		});
		expect(events).toMatchObject([
			{ outcome: "repaired", tool: "worker_actions", repairsApplied: ["jsonStringParse"] },
		]);
	});

	it("ignores non-arrays", () => {
		expect(parseWorkerActions(undefined)).toEqual({ kind: "accepted", actions: [] });
		expect(parseWorkerActions({ op: "write" })).toMatchObject({ kind: "rejected" });
	});

	it("rejects a batch that exceeds the schema action limit instead of applying a prefix", () => {
		const actions = Array.from({ length: 21 }, (_, index) => ({
			op: "write" as const,
			path: `src/${index}.ts`,
			content: "x",
		}));

		expect(parseWorkerActions(actions)).toMatchObject({ kind: "rejected", reasonCode: "worker_actions_too_many" });
	});

	it("rejects overlong paths and every oversized action text field", () => {
		const longPath = `src/${"p".repeat(MAX_WORKER_ACTION_PATH_CHARS)}.ts`;
		const oversized = "x".repeat(MAX_WORKER_ACTION_TEXT_CHARS + 1);

		for (const [actions, reasonCode] of [
			[[{ op: "write", path: longPath, content: "x" }], "worker_actions_path_too_long"],
			[[{ op: "write", path: "src/write.ts", content: oversized }], "worker_actions_field_too_large"],
			[[{ op: "edit", path: "src/old.ts", old: oversized, new: "x" }], "worker_actions_field_too_large"],
			[[{ op: "edit", path: "src/new.ts", old: "x", new: oversized }], "worker_actions_field_too_large"],
		] as const) {
			expect(parseWorkerActions(actions)).toMatchObject({ kind: "rejected", reasonCode });
		}
	});

	it("rejects aggregate payloads that would exceed one bounded action batch", () => {
		const halfPlusOne = "x".repeat(Math.floor(MAX_WORKER_ACTION_PAYLOAD_CHARS / 2) + 1);

		expect(
			parseWorkerActions([
				{ op: "write", path: "src/first.ts", content: halfPlusOne },
				{ op: "write", path: "src/second.ts", content: halfPlusOne },
			]),
		).toMatchObject({ kind: "rejected", reasonCode: "worker_actions_payload_too_large" });
	});

	it("rejects non-JSON direct caller accessors without invoking them", () => {
		const accessorAction = { op: "write", path: "src/accessor.ts" } as Record<string, unknown>;
		Object.defineProperty(accessorAction, "content", {
			enumerable: true,
			get: () => {
				throw new Error("must not read direct caller accessor");
			},
		});

		expect(parseWorkerActions([accessorAction])).toMatchObject({
			kind: "rejected",
			reasonCode: "worker_actions_invalid_shape",
		});
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

	it("normalizes malformed direct callers before they can mutate the filesystem", () => {
		const report = applyWorkerActions({
			actions: [
				{ op: "write", path: "src/otherwise-valid.ts", content: "must not write" },
				{
					op: "write",
					path: "src/oversized.ts",
					content: "x".repeat(MAX_WORKER_ACTION_TEXT_CHARS + 1),
				},
			] as unknown as { op: "write"; path: string; content: string }[],
			gateway,
			toolManifests,
			cwd,
		});

		expect(report).toEqual({
			changedFiles: [],
			refused: [],
			failed: [
				{
					path: "<worker_actions>",
					reason: "worker_actions_field_too_large: worker actions contain a field larger than the allowed limit",
				},
			],
			inspectionRequired: [],
		});
		expect(existsSync(join(cwd, "src", "otherwise-valid.ts"))).toBe(false);
		expect(existsSync(join(cwd, "src", "oversized.ts"))).toBe(false);
	});

	it("refuses to load an unbounded edit target before applying a replacement", () => {
		const target = join(cwd, "src", "large.ts");
		writeFileSync(target, `needle${"x".repeat(MAX_WORKER_ACTION_EDIT_TARGET_BYTES)}`, "utf-8");

		const report = applyWorkerActions({
			actions: [{ op: "edit", path: "src/large.ts", old: "needle", new: "replaced" }],
			gateway,
			toolManifests,
			cwd,
		});

		expect(report.changedFiles).toEqual([]);
		expect(report.failed).toEqual([
			{ path: "src/large.ts", reason: "action precondition or filesystem operation failed" },
		]);
		expect(readFileSync(target, "utf-8").startsWith("needle")).toBe(true);
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

	it("does not repeat a same-fence action after a durable success receipt", () => {
		const agentDir = join(cwd, "agent");
		const journal = new WorkerActionJournal({
			agentDir,
			parentSessionId: "parent-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			fencingToken: 1,
		});
		const action = { op: "write" as const, path: "src/a.ts", content: "worker content" };

		expect(
			applyWorkerActions({ actions: [action], gateway, toolManifests, cwd, actionJournal: journal })
				.inspectionRequired,
		).toEqual([]);
		writeFileSync(join(cwd, "src", "a.ts"), "external evidence", "utf-8");

		const replay = applyWorkerActions({ actions: [action], gateway, toolManifests, cwd, actionJournal: journal });
		expect(readFileSync(join(cwd, "src", "a.ts"), "utf-8")).toBe("external evidence");
		expect(replay.changedFiles).toEqual([]);
		expect(replay.inspectionRequired).toMatchObject([
			{ state: "succeeded", reasonCode: "worker_action_already_succeeded" },
		]);
	});

	it("blocks an interrupted intent and requires evidence inspection rather than applying it", () => {
		const journal = new WorkerActionJournal({
			agentDir: join(cwd, "agent"),
			parentSessionId: "parent-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			fencingToken: 1,
		});
		const action = { op: "write" as const, path: "src/interrupted.ts", content: "must not appear" };
		const intent = journal.begin({ index: 0, action, targetPath: join(cwd, "src", "interrupted.ts") });
		expect(intent.kind).toBe("execute");

		const replay = applyWorkerActions({ actions: [action], gateway, toolManifests, cwd, actionJournal: journal });
		expect(existsSync(join(cwd, "src", "interrupted.ts"))).toBe(false);
		expect(replay.inspectionRequired).toMatchObject([
			{ state: "unknown", reasonCode: "worker_action_outcome_unknown" },
		]);
	});

	it("marks a journal intent unknown when parent-directory creation may have started", () => {
		const journal = new WorkerActionJournal({
			agentDir: join(cwd, "agent"),
			parentSessionId: "parent-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			fencingToken: 1,
		});
		writeFileSync(join(cwd, "src", "not-a-directory"), "file", "utf-8");
		const action = { op: "write" as const, path: "src/not-a-directory/child.ts", content: "must not appear" };

		const report = applyWorkerActions({ actions: [action], gateway, toolManifests, cwd, actionJournal: journal });

		expect(report.failed).toEqual([]);
		expect(report.inspectionRequired).toMatchObject([
			{ state: "unknown", reasonCode: "worker_action_outcome_unknown" },
		]);
		expect(existsSync(join(cwd, "src", "not-a-directory", "child.ts"))).toBe(false);
	});
});
