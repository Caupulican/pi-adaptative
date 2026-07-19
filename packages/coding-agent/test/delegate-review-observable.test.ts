import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, WorkerRequest, WorkerResult } from "../src/core/autonomy/contracts.ts";
import {
	acknowledgeWorkerResultReview,
	appendWorkerResultSnapshot,
	getLatestWorkerResultSnapshot,
	getWorkerResultSnapshots,
} from "../src/core/delegation/session-worker-result.ts";
import { isParentReviewRequired } from "../src/core/delegation/worker-result.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateStatusToolDefinition } from "../src/core/tools/delegate-status.ts";

const context = {} as ExtensionContext;

const mockEnvelope: CapabilityEnvelope = {
	id: "env-1",
	capabilities: ["read_files", "write_files"],
	allowedPaths: ["/tmp/allowed"],
	deniedPaths: ["/tmp/allowed/denied"],
};

const mockRequest: WorkerRequest = {
	id: "req-1",
	instructions: "do something",
	route: { tier: "cheap", risk: "read-only", confidence: 1, reasonCode: "r1", reasons: [] },
	envelope: mockEnvelope,
};

const baseResult: WorkerResult = {
	requestId: "req-1",
	status: "completed",
	summary: "done",
	changedFiles: [],
	usageReportId: "usage-1",
};

describe("isParentReviewRequired (worker-result.ts)", () => {
	it("true when a completed result carries blockers (worker-result.ts:110)", () => {
		expect(
			isParentReviewRequired({ request: mockRequest, result: { ...baseResult, blockers: ["needs a look"] } }),
		).toBe(true);
	});

	it("false for a clean read-only completed result (nothing to review)", () => {
		expect(isParentReviewRequired({ request: mockRequest, result: baseResult })).toBe(false);
	});

	it("false when the gate blocks instead of asking (not completed)", () => {
		expect(isParentReviewRequired({ request: mockRequest, result: { ...baseResult, status: "failed" } })).toBe(false);
	});

	describe("with real path-scoped changed files", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-marker-test-"));
		const allowedRoot = path.join(tempDir, "allowed");
		const deniedPath = path.join(allowedRoot, "denied");

		const testEnv: CapabilityEnvelope = {
			id: "env-test",
			capabilities: ["write_files"],
			allowedPaths: [allowedRoot],
			deniedPaths: [deniedPath],
		};
		const testRequest: WorkerRequest = { ...mockRequest, envelope: testEnv };

		beforeAll(() => {
			fs.mkdirSync(allowedRoot, { recursive: true });
			fs.mkdirSync(deniedPath, { recursive: true });
		});
		afterAll(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("true when changed files pass path-scope validation (worker-result.ts:178)", () => {
			const changedFile = path.join(allowedRoot, "file.txt");
			expect(
				isParentReviewRequired({ request: testRequest, result: { ...baseResult, changedFiles: [changedFile] } }),
			).toBe(true);
		});

		it("false when the changed file is denied — that's a block, not ask-user", () => {
			const changedFile = path.join(deniedPath, "file.txt");
			expect(
				isParentReviewRequired({ request: testRequest, result: { ...baseResult, changedFiles: [changedFile] } }),
			).toBe(false);
		});
	});
});

describe("persistence of the review marker (session-worker-result.ts)", () => {
	it("stamps parentReviewRequired at append time when request is present", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["please check"] }, mockRequest);

		const [snapshot] = getWorkerResultSnapshots(sessionManager.getEntries());
		expect(snapshot?.parentReviewRequired).toBe(true);
		expect(snapshot?.parentReviewedAt).toBeUndefined();
	});

	it("leaves the marker unset (not falsely false) without a request — legacy compatibility", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["please check"] });

		const [snapshot] = getWorkerResultSnapshots(sessionManager.getEntries());
		expect(snapshot?.parentReviewRequired).toBeUndefined();
	});

	it("a clean completed result (no blockers/changes) is not flagged", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, baseResult, mockRequest);

		const [snapshot] = getWorkerResultSnapshots(sessionManager.getEntries());
		expect(snapshot?.parentReviewRequired).toBe(false);
	});

	it("getLatestWorkerResultSnapshot returns the most recent entry for a requestId, paired with its request", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["b1"] }, mockRequest);
		appendWorkerResultSnapshot(
			sessionManager,
			{ ...baseResult, requestId: "req-2" },
			{ ...mockRequest, id: "req-2" },
		);

		const latest = getLatestWorkerResultSnapshot(sessionManager.getEntries(), "req-1");
		expect(latest?.result.requestId).toBe("req-1");
		expect(latest?.result.parentReviewRequired).toBe(true);
		expect(latest?.request?.id).toBe("req-1");
	});

	it("acknowledgeWorkerResultReview: unknown requestId reports unknown_worker_result", () => {
		const sessionManager = SessionManager.inMemory();
		expect(acknowledgeWorkerResultReview(sessionManager, "no-such-worker")).toEqual({
			ok: false,
			reason: "unknown_worker_result",
		});
	});

	it("acknowledgeWorkerResultReview: a non-flagged result reports not_flagged and writes nothing", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, baseResult, mockRequest);
		const entriesBefore = sessionManager.getEntries().length;

		expect(acknowledgeWorkerResultReview(sessionManager, "req-1")).toEqual({ ok: false, reason: "not_flagged" });
		expect(sessionManager.getEntries().length).toBe(entriesBefore);
	});

	it("acknowledgeWorkerResultReview durably clears the marker — survives a fresh re-read of the entries", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["needs eyes"] }, mockRequest);

		expect(getLatestWorkerResultSnapshot(sessionManager.getEntries(), "req-1")?.result.parentReviewRequired).toBe(
			true,
		);

		const ack = acknowledgeWorkerResultReview(sessionManager, "req-1", () => "2026-07-18T12:00:00.000Z");
		expect(ack).toEqual({ ok: true, requestId: "req-1", reviewedAt: "2026-07-18T12:00:00.000Z" });

		// Simulate a resolution re-read (e.g. after reload) by re-scanning entries from scratch.
		const reread = getLatestWorkerResultSnapshot(sessionManager.getEntries(), "req-1");
		expect(reread?.result.parentReviewRequired).toBe(true);
		expect(reread?.result.parentReviewedAt).toBe("2026-07-18T12:00:00.000Z");

		const snapshots = getWorkerResultSnapshots(sessionManager.getEntries());
		const latestByRequestId = new Map(snapshots.map((snapshot) => [snapshot.requestId, snapshot]));
		expect(latestByRequestId.get("req-1")?.parentReviewedAt).toBe("2026-07-18T12:00:00.000Z");
	});

	it("acknowledgeWorkerResultReview: a second ack reports already_reviewed and writes nothing further", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["needs eyes"] }, mockRequest);
		acknowledgeWorkerResultReview(sessionManager, "req-1");
		const entriesAfterFirstAck = sessionManager.getEntries().length;

		expect(acknowledgeWorkerResultReview(sessionManager, "req-1")).toEqual({
			ok: false,
			reason: "already_reviewed",
		});
		expect(sessionManager.getEntries().length).toBe(entriesAfterFirstAck);
	});

	it("acknowledgeWorkerResultReview never touches the worker's own files — no write-blocking, marker-only", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, changedFiles: ["src/a.ts"] }, mockRequest, {
			cwd: "/tmp/allowed",
		});
		const ack = acknowledgeWorkerResultReview(sessionManager, "req-1");
		expect(ack.ok).toBe(true);
		const latest = getLatestWorkerResultSnapshot(sessionManager.getEntries(), "req-1");
		expect(latest?.result.changedFiles).toEqual(["src/a.ts"]);
	});
});

describe("delegate_status surfaces unreviewed mutations and acks them (delegate-status.ts)", () => {
	function buildSessionBackedTool() {
		const sessionManager = SessionManager.inMemory();
		const laneRecords = [
			{ laneId: "req-1", type: "worker" as const, status: "succeeded" as const, reasonCode: "worker_completed" },
		];
		const tool = createDelegateStatusToolDefinition({
			getLaneRecords: () => laneRecords,
			getWorkerResultSnapshots: () => getWorkerResultSnapshots(sessionManager.getEntries()),
			acknowledgeWorkerReview: (requestId) => acknowledgeWorkerResultReview(sessionManager, requestId),
		});
		return { sessionManager, tool };
	}

	function textOf(result: Awaited<ReturnType<ReturnType<typeof createDelegateStatusToolDefinition>["execute"]>>) {
		return result.content
			.filter((entry) => entry.type === "text")
			.map((entry) => entry.text)
			.join("\n");
	}

	it("a mutating worker with parent_review_required shows as unreviewed in the overview and per-lane detail", async () => {
		const { sessionManager, tool } = buildSessionBackedTool();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["verify this"] }, mockRequest);

		const overview = await tool.execute("call", {}, undefined, undefined, context);
		expect(textOf(overview)).toContain("1 unreviewed worker mutation");
		expect(textOf(overview)).toContain("req-1");
		expect((overview.details as { unreviewedCount: number }).unreviewedCount).toBe(1);

		const single = await tool.execute("call", { laneId: "req-1" }, undefined, undefined, context);
		expect(textOf(single)).toContain("UNREVIEWED MUTATION");
		expect((single.details as { unreviewed: boolean }).unreviewed).toBe(true);
	});

	it("a non-mutating (clean) worker is unaffected — no notice, nothing write-blocked", async () => {
		const { sessionManager, tool } = buildSessionBackedTool();
		appendWorkerResultSnapshot(sessionManager, baseResult, mockRequest);

		const overview = await tool.execute("call", {}, undefined, undefined, context);
		expect(textOf(overview)).not.toContain("unreviewed");
		expect((overview.details as { unreviewedCount: number }).unreviewedCount).toBe(0);
	});

	it("an explicit review ack clears the sticky notice durably — a later status call no longer flags it", async () => {
		const { sessionManager, tool } = buildSessionBackedTool();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["verify this"] }, mockRequest);

		const before = await tool.execute("call", {}, undefined, undefined, context);
		expect((before.details as { unreviewedCount: number }).unreviewedCount).toBe(1);

		const ackResult = await tool.execute(
			"call",
			{ laneId: "req-1", action: "review" },
			undefined,
			undefined,
			context,
		);
		expect(textOf(ackResult)).toContain("reviewed");
		expect((ackResult.details as { reviewed: boolean }).reviewed).toBe(true);

		// Fresh tool instance over the SAME session-backed store, simulating a later turn re-reading
		// persisted state from scratch — the ack must be durable, not in-memory to one tool instance.
		const rewiredTool = createDelegateStatusToolDefinition({
			getLaneRecords: () => [
				{ laneId: "req-1", type: "worker" as const, status: "succeeded" as const, reasonCode: "worker_completed" },
			],
			getWorkerResultSnapshots: () => getWorkerResultSnapshots(sessionManager.getEntries()),
			acknowledgeWorkerReview: (requestId) => acknowledgeWorkerResultReview(sessionManager, requestId),
		});
		const after = await rewiredTool.execute("call", {}, undefined, undefined, context);
		expect((after.details as { unreviewedCount: number }).unreviewedCount).toBe(0);
		expect(textOf(after)).not.toContain("unreviewed");
	});

	it("review action without laneId fails clearly instead of guessing a target", async () => {
		const { tool } = buildSessionBackedTool();
		const result = await tool.execute("call", { action: "review" }, undefined, undefined, context);
		expect(textOf(result)).toContain("requires laneId");
	});

	it("review action with an unknown laneId reports unknown_worker_result, not a crash", async () => {
		const { tool } = buildSessionBackedTool();
		const result = await tool.execute(
			"call",
			{ laneId: "no-such-worker", action: "review" },
			undefined,
			undefined,
			context,
		);
		expect(textOf(result)).toContain("unknown_worker_result");
	});

	it("review action degrades gracefully when the ack dependency isn't wired (never throws)", async () => {
		const tool = createDelegateStatusToolDefinition({
			getLaneRecords: () => [{ laneId: "req-1", type: "worker", status: "succeeded" }],
			getWorkerResultSnapshots: () => [{ ...baseResult, blockers: ["x"], parentReviewRequired: true }],
		});
		const result = await tool.execute("call", { laneId: "req-1", action: "review" }, undefined, undefined, context);
		expect(textOf(result)).toContain("not available");
	});

	it("unreviewed mutations stay visible even when pushed out of the recent-10 window by newer lanes", async () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerResultSnapshot(sessionManager, { ...baseResult, blockers: ["old but unreviewed"] }, mockRequest);
		const laneRecords = [
			{ laneId: "req-1", type: "worker" as const, status: "succeeded" as const, reasonCode: "worker_completed" },
		];
		for (let index = 2; index <= 12; index++) {
			const laneId = `req-${index}`;
			laneRecords.push({
				laneId,
				type: "worker" as const,
				status: "succeeded" as const,
				reasonCode: "worker_completed",
			});
			appendWorkerResultSnapshot(
				sessionManager,
				{ ...baseResult, requestId: laneId },
				{ ...mockRequest, id: laneId },
			);
		}
		const tool = createDelegateStatusToolDefinition({
			getLaneRecords: () => laneRecords,
			getWorkerResultSnapshots: () => getWorkerResultSnapshots(sessionManager.getEntries()),
			acknowledgeWorkerReview: (requestId) => acknowledgeWorkerResultReview(sessionManager, requestId),
		});

		const overview = await tool.execute("call", {}, undefined, undefined, context);
		const text = textOf(overview);
		expect((overview.details as { unreviewedCount: number }).unreviewedCount).toBe(1);
		expect((overview.details as { unreviewedLaneIds: string[] }).unreviewedLaneIds).toEqual(["req-1"]);
		expect(text).toContain("Older unreviewed workers");
		expect(text).toContain("req-1");
	});
});
