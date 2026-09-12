import { describe, expect, it } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";
import { executeDelegateStatusAction, projectClaimFindings } from "../src/core/tools/delegate-status.ts";

const context = {} as ExtensionContext;

const tool = createDelegateToolDefinition({
	caller: { kind: "session_root" },
	runWorkerDelegation: () => Promise.resolve({ started: false, skipReason: "unused" }),
	status: {
		getLaneRecords: () => [
			{
				laneId: "worker-1",
				type: "worker",
				status: "succeeded",
				reasonCode: "worker_completed",
				label: "Inspect the router",
				profileId: "fast-reviewer",
				modelRef: "openai-codex/gpt-5.6-terra",
				thinkingLevel: "low",
			},
			{ laneId: "worker-2", type: "worker", status: "running" },
			{ laneId: "tmux-worker-1", type: "tmux-worker", status: "succeeded", reasonCode: "worker_completed" },
		],
		getWorkerClaimSnapshots: () => [
			{
				requestId: "worker-1",
				status: "completed",
				outputFormat: "plain_text",
				summary: "inspect this",
				changedFiles: [],
				usageReportId: "usage-1",
			},
		],
		getWorkerResult: () => ({
			artifacts: [
				{
					artifactId: "worker-output-1",
					kind: "report",
					uri: "file:///tmp/worker-output-1.txt",
					sizeBytes: 75_000,
					createdAt: "2026-08-20T00:00:00.000Z",
					metadata: { source: "worker_terminal_output", complete: true },
				},
			],
		}),
	},
});

describe("delegate status", () => {
	it("returns bounded untrusted terminal output", async () => {
		const result = await tool.execute(
			"call",
			{ action: "status", laneId: "worker-1" },
			undefined,
			undefined,
			context,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("UNTRUSTED");
		expect(text).toContain("inspect this");
		expect(text).toContain("usage-1");
		expect(text).toContain("file:///tmp/worker-output-1.txt");
		expect(text).toContain("effective model: openai-codex/gpt-5.6-terra; thinking: low");
		expect(result.details).toMatchObject({
			outputArtifactUri: "file:///tmp/worker-output-1.txt",
			outputArtifactSizeBytes: 75_000,
			lanes: [
				{
					laneId: "worker-1",
					label: "Inspect the router",
					profileId: "fast-reviewer",
					modelRef: "openai-codex/gpt-5.6-terra",
					thinkingLevel: "low",
				},
			],
		});
	});

	it("does not disclose unknown lane data", async () => {
		const result = await tool.execute(
			"call",
			{ action: "status", laneId: "worker-foreign" },
			undefined,
			undefined,
			context,
		);
		expect(
			result.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n"),
		).toBe("unknown_worker_lane");
	});

	it("lists in-process worker lanes and out-of-process tmux-worker lanes together", async () => {
		const result = await tool.execute("call", { action: "status" }, undefined, undefined, context);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("workers: 1 running, 0 queued, 2 terminal");
		expect(text).toContain("worker-1");
		expect(text).toContain("worker-2");
		expect(text).toContain("tmux-worker-1");
		expect(text).not.toContain("worker-foreign");
	});

	it("inspects a tmux-worker lane by laneId the same as an in-process worker lane", async () => {
		const result = await tool.execute(
			"call",
			{ action: "status", laneId: "tmux-worker-1" },
			undefined,
			undefined,
			context,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("tmux-worker-1: succeeded (worker_completed)");
	});

	it("identifies a durable transient retry as nonterminal instead of presenting a failure token", () => {
		const retrying: LaneRecord = {
			laneId: "worker-retrying",
			type: "worker",
			status: "running",
			reasonCode: "retry_scheduled:overloaded",
		};

		const result = executeDelegateStatusAction(
			"status",
			{},
			{
				getLaneRecords: () => [retrying],
				getWorkerClaimSnapshots: () => [],
			},
		);

		expect(result.content[0]?.text).toContain(
			"worker-retrying: retrying after transient overloaded (nonterminal; durable state preserved; terminal handoff pending)",
		);
		expect(result.content[0]?.text).not.toContain("worker-retrying: running (retry_scheduled:overloaded)");
	});

	it("classifies a queued worker as admitted safety state instead of harness failure", () => {
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-queued" },
			{
				getLaneRecords: () => [{ laneId: "worker-queued", type: "worker", status: "queued" }],
				getWorkerClaimSnapshots: () => [],
			},
		);

		expect(result.content[0]?.text).toContain(
			"CAVEMAN MODE - MANDATORY: queued is admitted durable nonterminal state",
		);
		expect(result.content[0]?.text).toContain("not stall or harness failure");
		expect(result.content[0]?.text).toContain(
			"Never poll, interrupt, or cancel a healthy running worker to force the queue",
		);
		expect(result.content[0]?.text).toContain("Independent machine-scope workers may run in parallel");
		expect(result.content[0]?.text).toContain("an explicit path preserves collision fencing");
		expect(result.content[0]?.text).toContain(
			"If you start a fresh narrower replacement, cancel this queued agent after the replacement starts",
		);
		expect(result.content[0]?.text).toContain("otherwise both tasks will run");
	});

	it("prints why a queued worker is waiting and what clears it", () => {
		const waitReason = "write_reservation: /repo held by session other (owner live, since 2026-09-08T08:14:26.000Z)";
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-queued" },
			{
				getLaneRecords: () => [{ laneId: "worker-queued", type: "worker", status: "queued", waitReason }],
				getWorkerClaimSnapshots: () => [],
			},
		);

		expect(result.content[0]?.text).toContain(`waiting: ${waitReason}`);
		expect(result.content[0]?.text).toContain("the waiting line names which one and since when");
		expect(result.content[0]?.text).toContain("A write reservation held by a dead owner is released automatically");
		expect(result.details.lanes).toEqual([expect.objectContaining({ laneId: "worker-queued", waitReason })]);
	});

	it("labels a delivered blocked claim as task evidence instead of harness failure", () => {
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-blocked" },
			{
				getLaneRecords: () => [
					{
						laneId: "worker-blocked",
						type: "worker",
						status: "blocked",
						reasonCode: "worker_blocked",
					},
				],
				getWorkerClaimSnapshots: () => [
					{
						requestId: "worker-blocked",
						status: "blocked",
						summary: "Task could not run one check.",
						changedFiles: [],
						blockers: ["missing task dependency"],
					},
				],
			},
		);

		expect(result.content[0]?.text).toContain("CAVEMAN MODE - MANDATORY");
		expect(result.content[0]?.text).toContain("worker_blocked is a delivered task claim with blockers");
		expect(result.content[0]?.text).toContain("not harness failure or lost state");
		expect(result.content[0]?.text).toContain("continue or replan the parent task");
	});

	it("does not turn one completion error into a harness failure or sibling cancellation", () => {
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-failed" },
			{
				getLaneRecords: () => [
					{
						laneId: "worker-failed",
						type: "worker",
						status: "failed",
						reasonCode: "completion_error",
					},
				],
				getWorkerClaimSnapshots: () => [
					{
						requestId: "worker-failed",
						status: "failed",
						summary: "Worker did not complete: completion_error — provider unavailable.",
						changedFiles: [],
					},
				],
			},
		);

		expect(result.content[0]?.text).toContain(
			"CAVEMAN MODE - MANDATORY: completion_error means a worker execution failed",
		);
		expect(result.content[0]?.text).toContain("Tool timeout, provider/model/API/network/WebSocket/fetch/overload");
		expect(result.content[0]?.text).toContain("NEVER call any of them harness failure");
		expect(result.content[0]?.text).toContain("NEVER stop, cancel, or interrupt healthy siblings for them");
		expect(result.content[0]?.text).toContain("A delivered terminal handoff proves persistence and delivery worked");
		expect(result.content[0]?.text).toContain("continue or replan");
	});

	it("names a retired agent on its lane instead of hiding the lane", () => {
		// delegate retire ends the session, not the lane: status, review, and worker evidence still
		// resolve it, and the reply says what the agent can no longer do.
		const retired: LaneRecord = {
			laneId: "worker-retired",
			type: "worker",
			status: "succeeded",
			reasonCode: "worker_completed",
			agentStatus: "retired",
		};
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-retired" },
			{ getLaneRecords: () => [retired], getWorkerClaimSnapshots: () => [] },
		);
		expect(result.content[0]?.text).toContain("worker-retired: succeeded (worker_completed)");
		expect(result.content[0]?.text).toContain("agent retired: no follow_up, resume, or wait");
		expect(result.details).toMatchObject({ lanes: [{ laneId: "worker-retired", agentStatus: "retired" }] });
	});

	it("projects findings into status text and structured details", () => {
		const lane: LaneRecord = {
			laneId: "worker-findings",
			type: "worker",
			status: "succeeded",
			reasonCode: "worker_completed",
		};
		const claim = {
			requestId: "worker-findings",
			status: "completed" as const,
			summary: "Analyzed the router module.",
			changedFiles: [],
			evidence: {
				query: "worker:worker-findings",
				sources: [],
				findings: [
					{
						id: "f-1",
						summary: "Router table drops non-canonical paths",
						evidenceIds: ["src-1"],
						confidence: 0.9,
					},
					{
						id: "f-2",
						summary: "Cache eviction does not invalidate route index",
						evidenceIds: [],
					},
				],
			},
		};

		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-findings" },
			{
				getLaneRecords: () => [lane],
				getWorkerClaimSnapshots: () => [claim],
			},
		);

		const text = result.content[0]?.text ?? "";
		expect(text).toContain("UNTRUSTED");
		expect(text).toContain("Analyzed the router module.");
		expect(text).toContain("findings:");
		expect(text).toContain("- finding: Router table drops non-canonical paths (confidence: 0.9)");
		expect(text).toContain("- finding: Cache eviction does not invalidate route index");
		expect(result.details.findings).toEqual([
			{
				id: "f-1",
				summary: "Router table drops non-canonical paths",
				evidenceIds: ["src-1"],
				confidence: 0.9,
			},
			{
				id: "f-2",
				summary: "Cache eviction does not invalidate route index",
				evidenceIds: [],
			},
		]);
	});

	it("handles findings-only claim when summary is empty", () => {
		const lane: LaneRecord = {
			laneId: "worker-findings-only",
			type: "worker",
			status: "succeeded",
			reasonCode: "worker_completed",
		};
		const claim = {
			requestId: "worker-findings-only",
			status: "completed" as const,
			summary: "",
			changedFiles: [],
			evidence: {
				query: "worker:worker-findings-only",
				sources: [],
				findings: [
					{
						id: "f-only",
						summary: "Found isolated root cause in worker runner",
						evidenceIds: [],
					},
				],
			},
		};

		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-findings-only" },
			{
				getLaneRecords: () => [lane],
				getWorkerClaimSnapshots: () => [claim],
			},
		);

		const text = result.content[0]?.text ?? "";
		expect(text).toContain("findings:");
		expect(text).toContain("- finding: Found isolated root cause in worker runner");
		expect(result.details.findings).toHaveLength(1);
	});

	it("handles absent findings cleanly without findings text or details", () => {
		const lane: LaneRecord = {
			laneId: "worker-clean",
			type: "worker",
			status: "succeeded",
			reasonCode: "worker_completed",
		};
		const claim = {
			requestId: "worker-clean",
			status: "completed" as const,
			summary: "Clean task without findings.",
			changedFiles: [],
		};

		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-clean" },
			{
				getLaneRecords: () => [lane],
				getWorkerClaimSnapshots: () => [claim],
			},
		);

		const text = result.content[0]?.text ?? "";
		expect(text).not.toContain("findings:");
		expect(result.details.findings).toBeUndefined();
	});

	it("bounds oversized non-ASCII findings and summaries honoring UTF-8 byte budget and preserving blockers", () => {
		const lane: LaneRecord = {
			laneId: "worker-oversized-findings",
			type: "worker",
			status: "succeeded",
			reasonCode: "worker_completed",
		};
		const nonAsciiChar = "界";
		const claim = {
			requestId: "worker-oversized-findings",
			status: "completed" as const,
			summary: nonAsciiChar.repeat(8_000),
			changedFiles: ["src/critical-change.ts"],
			blockers: ["critical_audit_blocker"],
			evidence: {
				query: "worker:worker-oversized-findings",
				sources: [],
				findings: Array.from({ length: 50 }, (_, i) => ({
					id: `f-${i}`,
					summary: `finding ${i}: ${nonAsciiChar.repeat(1_000)}`,
					evidenceIds: Array.from({ length: 10 }, (_, j) => `ev-${j}`),
					confidence: 0.8,
				})),
			},
		};

		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-oversized-findings" },
			{
				getLaneRecords: () => [lane],
				getWorkerClaimSnapshots: () => [claim],
			},
		);

		const text = result.content[0]?.text ?? "";
		const textBytes = Buffer.byteLength(text, "utf8");
		const detailsBytes = Buffer.byteLength(JSON.stringify(result.details), "utf8");

		expect(textBytes).toBeLessThanOrEqual(16 * 1024);
		expect(detailsBytes).toBeLessThanOrEqual(16 * 1024);
		// Critical blockers and changed files must remain discoverable even when findings are truncated
		expect(text).toContain("critical_audit_blocker");
		expect(text).toContain("src/critical-change.ts");
		expect(result.details.findings).toBeDefined();
		expect(result.details.blockers).toContain("critical_audit_blocker");
		expect(result.details.changedFiles).toContain("src/critical-change.ts");
	});

	it("only marks actually delivered terminal records as observed when output budget is exceeded, with end sentinels and identity equality", () => {
		// Create 10 recent terminal records with 3KB payloads (30KB candidate payload > 16KB budget).
		// Each record includes non-ASCII Unicode and an explicit per-record end sentinel in blockers.
		const nonAscii = "界";
		const records: LaneRecord[] = Array.from({ length: 10 }, (_, i) => ({
			laneId: `worker-bulk-${i + 1}`,
			type: "worker",
			status: "succeeded",
			reasonCode: "worker_completed",
		}));
		const claims = records.map((record, i) => ({
			requestId: record.laneId,
			status: "completed" as const,
			summary: `Bulk worker ${i + 1} summary: ${nonAscii.repeat(1_000)}`,
			changedFiles: [`src/file-${i + 1}.ts`],
			blockers: [`[END_SENTINEL_${record.laneId}]`],
		}));

		const observed: LaneRecord[] = [];
		const result = executeDelegateStatusAction(
			"status",
			{},
			{
				getLaneRecords: () => records,
				getWorkerClaimSnapshots: () => claims,
				observeExposedTerminalRecords: (recs) => {
					observed.push(...recs);
				},
			},
		);

		const text = result.content[0]?.text ?? "";
		const textBytes = Buffer.byteLength(text, "utf8");
		const detailsBytes = Buffer.byteLength(JSON.stringify(result.details), "utf8");

		expect(textBytes).toBeLessThanOrEqual(16 * 1024);
		expect(detailsBytes).toBeLessThanOrEqual(16 * 1024);

		// Budget truncation is proven within the recent-10 set
		expect(observed.length).toBeGreaterThan(0);
		expect(observed.length).toBeLessThan(records.length);

		// Details lane identity equality: observed records match details.lanes exactly in identity and order
		const observedLaneIds = observed.map((r) => r.laneId);
		const detailsLaneIds = (result.details.lanes ?? []).map((l) => l.laneId);
		expect(observedLaneIds).toEqual(detailsLaneIds);

		// Every observed record must have its complete final end sentinel delivered in text
		for (const rec of observed) {
			expect(text).toContain(`[END_SENTINEL_${rec.laneId}]`);
		}

		// Any unobserved record must NOT have its end sentinel delivered in text and must not be in details.lanes
		const unobserved = records.filter((r) => !observedLaneIds.includes(r.laneId));
		expect(unobserved.length).toBeGreaterThan(0);
		for (const rec of unobserved) {
			expect(text).not.toContain(`[END_SENTINEL_${rec.laneId}]`);
			expect(detailsLaneIds.includes(rec.laneId)).toBe(false);
		}
	});

	it("bounds large Unicode changed paths and prioritizes blockers in lane and overview status", () => {
		const claim = {
			requestId: "review-lane",
			status: "completed" as const,
			changedFiles: Array.from({ length: 64 }, (_, i) => `src/${i}/${"界".repeat(240)}.ts`),
			summary: "Validated large change.",
			blockers: ["FINAL_BLOCKER_SENTINEL"],
		};
		for (const overview of [false, true]) {
			const result = executeDelegateStatusAction("status", overview ? {} : { laneId: claim.requestId }, {
				getLaneRecords: () => [{ laneId: claim.requestId, type: "worker", status: "succeeded" }],
				getWorkerClaimSnapshots: () => [claim],
			});
			const text = result.content[0]?.text ?? "";
			const textBytes = Buffer.byteLength(text, "utf8");
			const detailsBytes = Buffer.byteLength(JSON.stringify(result.details), "utf8");
			expect(textBytes).toBeLessThanOrEqual(16 * 1024);
			expect(detailsBytes).toBeLessThanOrEqual(16 * 1024);
			expect(text).toContain("FINAL_BLOCKER_SENTINEL");
			if (!overview) {
				expect(result.details.omittedChangedFilesCount).toBeGreaterThan(0);
				expect(result.details.blockers).toContain("FINAL_BLOCKER_SENTINEL");
			}
		}
	});

	it("omits malformed findings candidates without valid string id instead of inventing identities", () => {
		const projected = projectClaimFindings([
			{ id: "", summary: "Empty id finding", evidenceIds: [] },
			{ id: "valid-1", summary: "Valid finding", evidenceIds: [] },
			{ id: undefined as unknown as string, summary: "Missing id finding", evidenceIds: [] },
		]);
		expect(projected).toHaveLength(1);
		expect(projected[0]?.id).toBe("valid-1");
		expect(projected[0]?.summary).toBe("Valid finding");
	});

	it("deterministically bounds oversized blockers with explicit omission disclosure and negative control", () => {
		const claim = {
			requestId: "review-lane",
			status: "blocked" as const,
			changedFiles: [],
			summary: "Blocked.",
			blockers: Array.from({ length: 16 }, (_, i) => `${"界".repeat(500)} END_BLOCKER_${i}`),
		};

		for (const overview of [false, true]) {
			const observed: LaneRecord[] = [];
			const result = executeDelegateStatusAction("status", overview ? {} : { laneId: claim.requestId }, {
				getLaneRecords: () => [{ laneId: claim.requestId, type: "worker", status: "blocked" }],
				getWorkerClaimSnapshots: () => [claim],
				observeExposedTerminalRecords: (recs) => {
					observed.push(...recs);
				},
			});

			const text = result.content[0]?.text ?? "";
			const textBytes = Buffer.byteLength(text, "utf8");
			const detailsBytes = Buffer.byteLength(JSON.stringify(result.details), "utf8");

			expect(textBytes).toBeLessThanOrEqual(16 * 1024);
			expect(detailsBytes).toBeLessThanOrEqual(16 * 1024);

			// Negative control: final blocker cannot fit in the budget ceiling
			expect(text.includes("END_BLOCKER_15")).toBe(false);

			if (!overview) {
				// Single lane mode delivers complete bounded blockers and discloses omissions
				expect(result.details.omittedBlockersCount).toBeGreaterThan(0);
				expect(result.details.blockers?.length).toBeGreaterThan(0);
				expect(text).toContain("more blockers omitted; see full output/transcript");
				expect(observed).toHaveLength(1);
			} else {
				// Overview text delivers bounded record within budget
				expect(textBytes).toBeLessThanOrEqual(2_048 + 500);
			}
		}
	});

	it("strictly bounds maximum valid shapes with Unicode and JSON escaping", () => {
		const longEscapedId = 'lane-\\"special\\"-\\u2028-'.repeat(20);
		const records: LaneRecord[] = Array.from({ length: 64 }, (_, i) => ({
			laneId: `lane-${i}-${longEscapedId}`,
			type: "worker",
			status: "succeeded",
			modelRef: `model-provider/very-long-model-ref-name-${"界".repeat(20)}-${i}`,
			waitReason: `waiting for dependency lock ${"界".repeat(30)}`,
			reasonCode: "completed_ok",
		}));
		const claims = records.map((record) => ({
			requestId: record.laneId,
			status: "completed" as const,
			changedFiles: [`src/path/${"界".repeat(50)}.ts`],
			summary: `Summary with quotes "and" slashes \\ and unicode ${"界".repeat(100)}`,
			parentReviewRequired: true,
		}));

		const result = executeDelegateStatusAction(
			"status",
			{},
			{
				getLaneRecords: () => records,
				getWorkerClaimSnapshots: () => claims,
			},
		);

		const textBytes = Buffer.byteLength(result.content[0]?.text ?? "", "utf8");
		const detailsBytes = Buffer.byteLength(JSON.stringify(result.details), "utf8");
		expect(textBytes).toBeLessThanOrEqual(16 * 1024);
		expect(detailsBytes).toBeLessThanOrEqual(16 * 1024);
		expect(result.details.unreviewedCount).toBe(64);
	});

	it("strictly bounds 1000 varying-shape fuzz cases within text and details budgets", () => {
		let seed = 1741;
		const next = (n: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return Math.floor((seed / 4294967296) * n);
		};
		let failures = 0;
		for (let iteration = 0; iteration < 500; iteration++) {
			const char = ["x", "界", '"', "\\"][next(4)];
			const shape = {
				summary: next(8001),
				blockers: next(33),
				blockerSize: next(1001),
				findings: next(65),
				findingSize: next(8000) + 1,
				paths: next(129),
				pathSize: next(2040) + 1,
			};
			const claim: WorkerClaim = {
				requestId: "review-lane",
				status: "completed",
				summary: char.repeat(shape.summary),
				changedFiles: Array.from({ length: shape.paths }, (_, i) => `${i}/${char.repeat(shape.pathSize)}`),
				blockers: Array.from({ length: shape.blockers }, () => char.repeat(shape.blockerSize)),
				evidence: {
					query: "review",
					sources: [],
					findings: Array.from({ length: shape.findings }, (_, i) => ({
						id: `f${i}`,
						evidenceIds: [],
						summary: char.repeat(shape.findingSize),
					})),
				},
			};
			for (const overview of [false, true]) {
				const result = executeDelegateStatusAction("status", overview ? {} : { laneId: claim.requestId }, {
					getLaneRecords: () => [{ laneId: claim.requestId, type: "worker", status: "succeeded" }],
					getWorkerClaimSnapshots: () => [claim],
				});
				const textBytes = Buffer.byteLength(result.content[0]?.text ?? "", "utf8");
				const detailsBytes = Buffer.byteLength(JSON.stringify(result.details), "utf8");
				if (textBytes > 16384 || detailsBytes > 16384) {
					failures++;
				}
			}
		}
		expect(failures).toBe(0);
	}, 30_000);

	it("delivers complete small records without omission notices", () => {
		const claim: WorkerClaim = {
			requestId: "review-lane",
			status: "completed",
			summary: "All good",
			changedFiles: ["src/index.ts", "src/util.ts"],
			blockers: ["Warning only"],
			evidence: {
				query: "test",
				sources: [],
				findings: [{ id: "f1", evidenceIds: [], summary: "Single finding" }],
			},
		};
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: claim.requestId },
			{
				getLaneRecords: () => [{ laneId: claim.requestId, type: "worker", status: "succeeded" }],
				getWorkerClaimSnapshots: () => [claim],
			},
		);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("changed files: src/index.ts, src/util.ts");
		expect(text).toContain("blockers: Warning only");
		expect(text).toContain("Single finding");
		expect(text).not.toContain("omitted");
		expect(result.details.omittedBlockersCount).toBeUndefined();
		expect(result.details.omittedChangedFilesCount).toBeUndefined();
		expect(result.details.omittedFindingsCount).toBeUndefined();
		expect(result.details.blockers).toEqual(["Warning only"]);
		expect(result.details.changedFiles).toEqual(["src/index.ts", "src/util.ts"]);
	});

	it("discloses omitted-findings marker when single maximum CJK finding exceeds budget with summary and blockers, with small-finding negative control", () => {
		const maxFindingClaim: WorkerClaim = {
			requestId: "lane-cjk-finding",
			status: "completed",
			summary: "Summary text for CJK finding test.",
			blockers: ["Audit blocker sentinel"],
			changedFiles: ["src/index.ts"],
			evidence: {
				query: "cjk-test",
				sources: [],
				findings: [
					{
						id: "f-cjk-max",
						summary: "界".repeat(8_000),
						evidenceIds: [],
						confidence: 0.95,
					},
				],
			},
		};

		const resultMax = executeDelegateStatusAction(
			"status",
			{ laneId: maxFindingClaim.requestId },
			{
				getLaneRecords: () => [{ laneId: maxFindingClaim.requestId, type: "worker", status: "succeeded" }],
				getWorkerClaimSnapshots: () => [maxFindingClaim],
			},
		);

		const textMax = resultMax.content[0]?.text ?? "";
		const textMaxBytes = Buffer.byteLength(textMax, "utf8");
		const detailsMaxBytes = Buffer.byteLength(JSON.stringify(resultMax.details), "utf8");

		expect(textMaxBytes).toBeLessThanOrEqual(16 * 1024);
		expect(detailsMaxBytes).toBeLessThanOrEqual(16 * 1024);
		expect(textMax).toContain("Audit blocker sentinel");
		expect(textMax).toContain("Summary text for CJK finding test.");
		expect(textMax).toContain("findings:");
		expect(textMax).toContain("1 findings omitted; see full output/transcript");
		expect(resultMax.details.findings).toHaveLength(1);
		expect(Buffer.byteLength(resultMax.details.findings?.[0]?.summary ?? "", "utf8")).toBeLessThanOrEqual(500);

		// Negative control: small finding fits completely without omission marker
		const smallFindingClaim: WorkerClaim = {
			requestId: "lane-small-finding",
			status: "completed",
			summary: "Summary text for small finding.",
			blockers: ["Audit blocker sentinel"],
			changedFiles: ["src/index.ts"],
			evidence: {
				query: "small-test",
				sources: [],
				findings: [
					{
						id: "f-small",
						summary: "Verified small clean finding",
						evidenceIds: [],
						confidence: 0.99,
					},
				],
			},
		};

		const resultSmall = executeDelegateStatusAction(
			"status",
			{ laneId: smallFindingClaim.requestId },
			{
				getLaneRecords: () => [{ laneId: smallFindingClaim.requestId, type: "worker", status: "succeeded" }],
				getWorkerClaimSnapshots: () => [smallFindingClaim],
			},
		);

		const textSmall = resultSmall.content[0]?.text ?? "";
		expect(textSmall).toContain("findings:");
		expect(textSmall).toContain("- finding: Verified small clean finding (confidence: 0.99)");
		expect(textSmall).not.toContain("omitted");
		expect(resultSmall.details.omittedFindingsCount).toBeUndefined();
		expect(resultSmall.details.findings).toHaveLength(1);
	});
});
