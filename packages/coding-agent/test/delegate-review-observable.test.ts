import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, WorkerClaim, WorkerRequest } from "../src/core/autonomy/contracts.ts";
import {
	acknowledgeWorkerClaimReview,
	appendWorkerClaimSnapshot,
	getLatestWorkerClaimSnapshot,
	getWorkerClaimSnapshots,
} from "../src/core/delegation/session-worker-claim.ts";
import { isParentReviewRequired } from "../src/core/delegation/worker-claim.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";
import type { DelegateStatusDependencies } from "../src/core/tools/delegate-status.ts";

const context = {} as ExtensionContext;

const mockEnvelope: CapabilityEnvelope = {
	id: "env-1",
	capabilities: ["filesystem.read", "filesystem.write"],
	allowedPaths: ["/tmp/allowed"],
	deniedPaths: ["/tmp/allowed/denied"],
};

const mockRequest: WorkerRequest = {
	id: "req-1",
	instructions: "do something",
	route: { tier: "cheap", risk: "read-only", confidence: 1, reasonCode: "r1", reasons: [] },
	envelope: mockEnvelope,
};

const baseClaim: WorkerClaim = {
	requestId: "req-1",
	status: "completed",
	summary: "done",
	changedFiles: [],
	usageReportId: "usage-1",
};

describe("isParentReviewRequired (worker-claim.ts)", () => {
	it("true when a completed claim carries blockers", () => {
		expect(
			isParentReviewRequired({ request: mockRequest, claim: { ...baseClaim, blockers: ["needs a look"] } }),
		).toBe(true);
	});

	it("false for a clean read-only completed result (nothing to review)", () => {
		expect(isParentReviewRequired({ request: mockRequest, claim: baseClaim })).toBe(false);
	});

	it("false when the gate blocks instead of asking (not completed)", () => {
		expect(isParentReviewRequired({ request: mockRequest, claim: { ...baseClaim, status: "failed" } })).toBe(false);
	});

	describe("with real path-scoped changed files", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-marker-test-"));
		const allowedRoot = path.join(tempDir, "allowed");
		const deniedPath = path.join(allowedRoot, "denied");

		const testEnv: CapabilityEnvelope = {
			id: "env-test",
			capabilities: ["filesystem.write"],
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

		it("true when changed files pass path-scope validation", () => {
			const changedFile = path.join(allowedRoot, "file.txt");
			expect(
				isParentReviewRequired({ request: testRequest, claim: { ...baseClaim, changedFiles: [changedFile] } }),
			).toBe(true);
		});

		it("false when the changed file is denied — that's a block, not ask-user", () => {
			const changedFile = path.join(deniedPath, "file.txt");
			expect(
				isParentReviewRequired({ request: testRequest, claim: { ...baseClaim, changedFiles: [changedFile] } }),
			).toBe(false);
		});
	});
});

describe("persistence of the review marker (session-worker-claim.ts)", () => {
	it("stamps parentReviewRequired at append time when request is present", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["please check"] }, mockRequest);

		const [snapshot] = getWorkerClaimSnapshots(sessionManager.getEntries());
		expect(snapshot?.parentReviewRequired).toBe(true);
		expect(snapshot?.parentReviewedAt).toBeUndefined();
	});

	it("leaves the marker unset (not falsely false) for externally managed lanes without a request", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["please check"] });

		const [snapshot] = getWorkerClaimSnapshots(sessionManager.getEntries());
		expect(snapshot?.parentReviewRequired).toBeUndefined();
	});

	it("a clean completed result (no blockers/changes) is not flagged", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, baseClaim, mockRequest);

		const [snapshot] = getWorkerClaimSnapshots(sessionManager.getEntries());
		expect(snapshot?.parentReviewRequired).toBe(false);
	});

	it("getLatestWorkerClaimSnapshot returns the most recent entry for a requestId, paired with its request", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["b1"] }, mockRequest);
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, requestId: "req-2" }, { ...mockRequest, id: "req-2" });

		const latest = getLatestWorkerClaimSnapshot(sessionManager.getEntries(), "req-1");
		expect(latest?.claim.requestId).toBe("req-1");
		expect(latest?.claim.parentReviewRequired).toBe(true);
		expect(latest?.request?.id).toBe("req-1");
	});

	it("acknowledgeWorkerClaimReview: unknown requestId reports unknown_worker_claim", () => {
		const sessionManager = SessionManager.inMemory();
		expect(acknowledgeWorkerClaimReview(sessionManager, "no-such-worker")).toEqual({
			ok: false,
			reason: "unknown_worker_claim",
		});
	});

	it("acknowledgeWorkerClaimReview cannot acknowledge a sibling-branch claim", () => {
		const sessionManager = SessionManager.inMemory();
		const branchPoint = sessionManager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["sibling"] }, mockRequest);

		sessionManager.branch(branchPoint);
		expect(acknowledgeWorkerClaimReview(sessionManager, "req-1")).toEqual({
			ok: false,
			reason: "unknown_worker_claim",
		});

		const currentRequest = { ...mockRequest, id: "req-2" };
		appendWorkerClaimSnapshot(
			sessionManager,
			{ ...baseClaim, requestId: "req-2", blockers: ["current"] },
			currentRequest,
		);
		expect(acknowledgeWorkerClaimReview(sessionManager, "req-2").ok).toBe(true);
	});

	it("acknowledgeWorkerClaimReview: a non-flagged claim reports not_flagged and writes nothing", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, baseClaim, mockRequest);
		const entriesBefore = sessionManager.getEntries().length;

		expect(acknowledgeWorkerClaimReview(sessionManager, "req-1")).toEqual({ ok: false, reason: "not_flagged" });
		expect(sessionManager.getEntries().length).toBe(entriesBefore);
	});

	it("acknowledgeWorkerClaimReview durably clears the marker across a fresh read", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["needs eyes"] }, mockRequest);

		expect(getLatestWorkerClaimSnapshot(sessionManager.getEntries(), "req-1")?.claim.parentReviewRequired).toBe(true);

		const ack = acknowledgeWorkerClaimReview(sessionManager, "req-1", () => "2026-07-18T12:00:00.000Z");
		expect(ack).toEqual({ ok: true, requestId: "req-1", reviewedAt: "2026-07-18T12:00:00.000Z" });

		// Simulate a resolution re-read (e.g. after reload) by re-scanning entries from scratch.
		const reread = getLatestWorkerClaimSnapshot(sessionManager.getEntries(), "req-1");
		expect(reread?.claim.parentReviewRequired).toBe(true);
		expect(reread?.claim.parentReviewedAt).toBe("2026-07-18T12:00:00.000Z");

		const snapshots = getWorkerClaimSnapshots(sessionManager.getEntries());
		const latestByRequestId = new Map(snapshots.map((snapshot) => [snapshot.requestId, snapshot]));
		expect(latestByRequestId.get("req-1")?.parentReviewedAt).toBe("2026-07-18T12:00:00.000Z");
	});

	it("acknowledgeWorkerClaimReview: a second ack reports already_reviewed and writes nothing further", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["needs eyes"] }, mockRequest);
		acknowledgeWorkerClaimReview(sessionManager, "req-1");
		const entriesAfterFirstAck = sessionManager.getEntries().length;

		expect(acknowledgeWorkerClaimReview(sessionManager, "req-1")).toEqual({
			ok: false,
			reason: "already_reviewed",
		});
		expect(sessionManager.getEntries().length).toBe(entriesAfterFirstAck);
	});

	it("acknowledgeWorkerClaimReview never touches the worker's own files", () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, changedFiles: ["src/a.ts"] }, mockRequest, {
			cwd: "/tmp/allowed",
		});
		const ack = acknowledgeWorkerClaimReview(sessionManager, "req-1");
		expect(ack.ok).toBe(true);
		const latest = getLatestWorkerClaimSnapshot(sessionManager.getEntries(), "req-1");
		expect(latest?.claim.changedFiles).toEqual(["src/a.ts"]);
	});
});

describe("delegate status/review surfaces unreviewed mutations", () => {
	function statusTool(status: DelegateStatusDependencies) {
		return createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			status,
		});
	}

	function buildSessionBackedTool() {
		const sessionManager = SessionManager.inMemory();
		const laneRecords = [
			{ laneId: "req-1", type: "worker" as const, status: "succeeded" as const, reasonCode: "worker_completed" },
		];
		const tool = statusTool({
			getLaneRecords: () => laneRecords,
			getWorkerClaimSnapshots: () => getWorkerClaimSnapshots(sessionManager.getEntries()),
			acknowledgeWorkerReview: (requestId) => acknowledgeWorkerClaimReview(sessionManager, requestId),
		});
		return { sessionManager, tool };
	}

	function textOf(result: Awaited<ReturnType<ReturnType<typeof createDelegateToolDefinition>["execute"]>>) {
		return result.content
			.filter((entry) => entry.type === "text")
			.map((entry) => entry.text)
			.join("\n");
	}

	it("a mutating worker with parent_review_required shows as unreviewed in the overview and per-lane detail", async () => {
		const { sessionManager, tool } = buildSessionBackedTool();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["verify this"] }, mockRequest);

		const overview = await tool.execute("call", { action: "status" }, undefined, undefined, context);
		expect(textOf(overview)).toContain("1 unreviewed worker mutation");
		expect(textOf(overview)).toContain("req-1");
		expect((overview.details as { unreviewedCount: number }).unreviewedCount).toBe(1);

		const single = await tool.execute("call", { action: "status", laneId: "req-1" }, undefined, undefined, context);
		expect(textOf(single)).toContain("UNREVIEWED MUTATION");
		expect((single.details as { unreviewed: boolean }).unreviewed).toBe(true);
	});

	it("a non-mutating (clean) worker is unaffected — no notice, nothing write-blocked", async () => {
		const { sessionManager, tool } = buildSessionBackedTool();
		appendWorkerClaimSnapshot(sessionManager, baseClaim, mockRequest);

		const overview = await tool.execute("call", { action: "status" }, undefined, undefined, context);
		expect(textOf(overview)).not.toContain("unreviewed");
		expect((overview.details as { unreviewedCount: number }).unreviewedCount).toBe(0);
	});

	it("an explicit review ack clears the sticky notice durably — a later status call no longer flags it", async () => {
		const { sessionManager, tool } = buildSessionBackedTool();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["verify this"] }, mockRequest);

		const before = await tool.execute("call", { action: "status" }, undefined, undefined, context);
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
		const rewiredTool = statusTool({
			getLaneRecords: () => [
				{ laneId: "req-1", type: "worker" as const, status: "succeeded" as const, reasonCode: "worker_completed" },
			],
			getWorkerClaimSnapshots: () => getWorkerClaimSnapshots(sessionManager.getEntries()),
			acknowledgeWorkerReview: (requestId) => acknowledgeWorkerClaimReview(sessionManager, requestId),
		});
		const after = await rewiredTool.execute("call", { action: "status" }, undefined, undefined, context);
		expect((after.details as { unreviewedCount: number }).unreviewedCount).toBe(0);
		expect(textOf(after)).not.toContain("unreviewed");
	});

	it("review action without laneId fails clearly instead of guessing a target", async () => {
		const { tool } = buildSessionBackedTool();
		const result = await tool.execute("call", { action: "review" }, undefined, undefined, context);
		expect(textOf(result)).toContain("requires laneId");
	});

	it("review action with an unknown laneId reports unknown_worker_claim, not a crash", async () => {
		const { tool } = buildSessionBackedTool();
		const result = await tool.execute(
			"call",
			{ laneId: "no-such-worker", action: "review" },
			undefined,
			undefined,
			context,
		);
		expect(textOf(result)).toContain("unknown_worker_claim");
	});

	it("review action degrades gracefully when the ack dependency isn't wired (never throws)", async () => {
		const tool = statusTool({
			getLaneRecords: () => [{ laneId: "req-1", type: "worker", status: "succeeded" }],
			getWorkerClaimSnapshots: () => [{ ...baseClaim, blockers: ["x"], parentReviewRequired: true }],
		});
		const result = await tool.execute("call", { laneId: "req-1", action: "review" }, undefined, undefined, context);
		expect(textOf(result)).toContain("delegate action is unavailable to this caller: review");
	});

	it("unreviewed mutations stay visible even when pushed out of the recent-10 window by newer lanes", async () => {
		const sessionManager = SessionManager.inMemory();
		appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, blockers: ["old but unreviewed"] }, mockRequest);
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
			appendWorkerClaimSnapshot(sessionManager, { ...baseClaim, requestId: laneId }, { ...mockRequest, id: laneId });
		}
		const tool = statusTool({
			getLaneRecords: () => laneRecords,
			getWorkerClaimSnapshots: () => getWorkerClaimSnapshots(sessionManager.getEntries()),
			acknowledgeWorkerReview: (requestId) => acknowledgeWorkerClaimReview(sessionManager, requestId),
		});

		const overview = await tool.execute("call", { action: "status" }, undefined, undefined, context);
		const text = textOf(overview);
		expect((overview.details as { unreviewedCount: number }).unreviewedCount).toBe(1);
		expect((overview.details as { unreviewedLaneIds: string[] }).unreviewedLaneIds).toEqual(["req-1"]);
		expect(text).toContain("Older unreviewed workers");
		expect(text).toContain("req-1");
	});
});
