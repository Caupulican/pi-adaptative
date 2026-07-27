import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeWorkerActionTarget, WorkerActionJournal } from "../src/core/delegation/worker-action-journal.ts";

describe("WorkerActionJournal", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function createJournal(fence = 7): WorkerActionJournal {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-action-journal-"));
		tempDirs.push(root);
		return new WorkerActionJournal({
			agentDir: join(root, "agent"),
			parentSessionId: "parent-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			fencingToken: fence,
		});
	}

	it("persists bounded intent before a mutation and a terminal receipt without action contents", () => {
		const journal = createJournal();
		const start = journal.begin({
			index: 0,
			action: { op: "write", path: "src/a.ts", content: "TOP-SECRET-CONTENT" },
			targetPath: "/workspace/src/a.ts",
		});

		expect(start).toMatchObject({ kind: "execute", state: "not_started" });
		if (start.kind !== "execute") throw new Error("Expected a fresh action execution permit.");
		journal.recordSucceeded(start, { evidencePointer: "workspace:file:/workspace/src/a.ts" });

		const persisted = readFileSync(journal.filePath, "utf-8");
		expect(persisted).not.toContain("TOP-SECRET-CONTENT");
		expect(JSON.parse(persisted)).toMatchObject({
			schemaVersion: 1,
			scope: { parentSessionId: "parent-1", taskId: "task-1" },
			entries: [
				{
					attemptId: "attempt-1",
					fencingToken: 7,
					operation: "write",
					status: "succeeded",
					normalizedTarget: "/workspace/src/a.ts",
				},
			],
		});
		expect(journal.inspect(start.actionId)).toMatchObject({ state: "succeeded" });
	});

	it("treats a persisted intent with no receipt as unknown and blocks same-fence replay", () => {
		const journal = createJournal();
		const first = journal.begin({
			index: 0,
			action: { op: "edit", path: "src/a.ts", old: "before", new: "after" },
			targetPath: "/workspace/src/a.ts",
		});
		expect(first.kind).toBe("execute");

		const reopened = new WorkerActionJournal({
			agentDir: journal.agentDir,
			parentSessionId: "parent-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			fencingToken: 7,
		});
		const replay = reopened.begin({
			index: 0,
			action: { op: "edit", path: "src/a.ts", old: "before", new: "after" },
			targetPath: "/workspace/src/a.ts",
		});

		expect(replay).toMatchObject({
			kind: "inspection_required",
			state: "unknown",
			reasonCode: "worker_action_outcome_unknown",
		});
	});

	it("does not transfer authority to replay a mutation receipt to a fresh fencing token", () => {
		const journal = createJournal(7);
		const first = journal.begin({
			index: 0,
			action: { op: "write", path: "src/a.ts", content: "one" },
			targetPath: "/workspace/src/a.ts",
		});
		if (first.kind !== "execute") throw new Error("Expected a fresh action execution permit.");
		journal.recordSucceeded(first);

		const freshFence = new WorkerActionJournal({
			agentDir: journal.agentDir,
			parentSessionId: "parent-1",
			taskId: "task-1",
			attemptId: "attempt-2",
			fencingToken: 8,
		});
		const fresh = freshFence.begin({
			index: 0,
			action: { op: "write", path: "src/a.ts", content: "one" },
			targetPath: "/workspace/src/a.ts",
		});

		expect(fresh).toMatchObject({
			kind: "inspection_required",
			state: "succeeded",
			reasonCode: "worker_action_prior_fence_requires_inspection",
		});
		expect(freshFence.filePath).toBe(journal.filePath);
	});

	it("recognizes the same prior-fence mutation when its batch position changes", () => {
		const journal = createJournal(7);
		const first = journal.begin({
			index: 0,
			action: { op: "write", path: "src/a.ts", content: "one" },
			targetPath: "/workspace/src/a.ts",
		});
		if (first.kind !== "execute") throw new Error("Expected a fresh action execution permit.");
		journal.recordSucceeded(first);

		const freshFence = new WorkerActionJournal({
			agentDir: journal.agentDir,
			parentSessionId: "parent-1",
			taskId: "task-1",
			attemptId: "attempt-2",
			fencingToken: 8,
		});
		const reordered = freshFence.begin({
			index: 3,
			action: { op: "write", path: "src/a.ts", content: "one" },
			targetPath: "/workspace/src/a.ts",
		});

		expect(reordered).toMatchObject({
			kind: "inspection_required",
			state: "succeeded",
			reasonCode: "worker_action_prior_fence_requires_inspection",
		});
	});

	it("preserves a known failed receipt as distinct from an interrupted outcome", () => {
		const journal = createJournal();
		const first = journal.begin({
			index: 0,
			action: { op: "edit", path: "src/a.ts", old: "missing", new: "replacement" },
			targetPath: "/workspace/src/a.ts",
		});
		if (first.kind !== "execute") throw new Error("Expected a fresh action execution permit.");
		journal.recordFailed(first, "worker_action_precondition_failed");

		const replay = journal.begin({
			index: 0,
			action: { op: "edit", path: "src/a.ts", old: "missing", new: "replacement" },
			targetPath: "/workspace/src/a.ts",
		});
		expect(replay).toMatchObject({
			kind: "inspection_required",
			state: "failed",
			reasonCode: "worker_action_previously_failed",
		});
	});

	it("rejects an oversized durable journal before parsing it", () => {
		const journal = createJournal();
		const first = journal.begin({
			index: 0,
			action: { op: "write", path: "src/a.ts", content: "one" },
			targetPath: "/workspace/src/a.ts",
		});
		if (first.kind !== "execute") throw new Error("Expected a fresh action execution permit.");
		writeFileSync(journal.filePath, "x".repeat(256 * 1024 + 1));

		expect(() => journal.inspect(first.actionId)).toThrow("Worker action journal exceeds its byte limit");
	});

	it("uses portable path identities while keeping the journal in agent-owned state", () => {
		expect(normalizeWorkerActionTarget("C:\\Repo", "c:/repo/src/../src/A.ts")).toBe("c:\\repo\\src\\a.ts");
		expect(normalizeWorkerActionTarget("/repo", "src/../src/a.ts")).toBe("/repo/src/a.ts");

		const journal = createJournal();
		expect(relative(journal.agentDir, journal.filePath).startsWith("..")).toBe(false);
		expect(journal.filePath).toContain(`${join("state", "orchestration", "sessions")}`);
		expect(journal.filePath).toContain("worker-actions");
		expect(existsSync(journal.filePath)).toBe(false);
	});
});
