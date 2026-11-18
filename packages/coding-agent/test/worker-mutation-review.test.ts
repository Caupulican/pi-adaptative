import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ownerOrchestrationHome } from "../src/core/agent-paths.ts";
import type { WorkerClaim, WorkerRequest } from "../src/core/autonomy/contracts.ts";
import { hostFinding } from "../src/core/autonomy/host-findings.ts";
import {
	acknowledgeWorkerClaimReview,
	appendWorkerClaimSnapshot,
	getLatestWorkerClaimSnapshot,
} from "../src/core/delegation/session-worker-claim.ts";
import { readWorkerActionMutationProgress, WorkerActionJournal } from "../src/core/delegation/worker-action-journal.ts";
import { WorkerConversation } from "../src/core/delegation/worker-conversation-store.ts";
import {
	retainCancelledWorkerMutationClaim,
	WorkerMutationEvidence,
} from "../src/core/delegation/worker-mutation-evidence.ts";
import { commandReceiptFor, workerCommandCheckCitation } from "../src/core/delegation/worker-receipts.ts";
import {
	buildNeedsMoreRequest,
	buildReportRequest,
	createSubmitReportTool,
	judgeSubmittedReport,
	resolvedCheckReceipt,
	type WorkerReportCapture,
} from "../src/core/delegation/worker-report.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { createWorkerResultContract } from "../src/core/orchestration/worker-result-adapter.ts";
import { getActiveSessionBranchEntries } from "../src/core/session-snapshot.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

const updatedAt = "2026-11-17T20:53:54.000Z";
const request: WorkerRequest = {
	id: "task",
	instructions: "Update the report.",
	route: { tier: "medium", risk: "scoped-write", confidence: 1, reasonCode: "fixture", reasons: [] },
	envelope: { id: "grant", capabilities: ["filesystem.write"], allowedPaths: [process.cwd()] },
};

function sessionManager(): SessionManager {
	return SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
}

function workerConversation(session: SessionManager): WorkerConversation {
	return new WorkerConversation(session, {
		provider: "pi",
		sessionId: session.getSessionId(),
		cwd: process.cwd(),
		resourceProfileNames: [],
		contextPointers: [],
	});
}

describe("worker mutation review", () => {
	it("repairs a subdirectory path from this attempt's evidence without repeating the edit", () => {
		const judge = (changedFiles: string[], files: string[]) =>
			judgeSubmittedReport({
				context: { writeCapable: true, verifier: false, requirementIds: [] },
				cwd: path.resolve("packages/app"),
				receipts: [],
				changedFiles,
				submitted: {
					status: "completed",
					summary: "Updated slugify.",
					blockers: [],
					inconclusive: [],
					findings: [],
					reasonCodes: [],
					report: {
						changes: files.map((file) => ({ file, what: "Updated slugify." })),
						checks: [],
						requirements: [],
						assumptions: [],
						regressions: [],
						remaining: [],
					},
				},
			});
		const changed = ["util.ts"];
		const firstReport = buildReportRequest({
			context: { writeCapable: true, verifier: false, requirementIds: [] },
			receipts: [],
			changedFiles: changed,
		});
		expect(firstReport).toContain("No command receipts were recorded");
		const rejected = judge(changed, ["packages/app/util.ts"]);
		expect(rejected.verdict).toBe("rejected");
		const review = buildNeedsMoreRequest(rejected, [], changed);
		expect(review).toContain("Files the host recorded as changed: 'util.ts'");
		expect(review).toContain("without repeating that edit");
		expect(judge(changed, changed).verdict).toBe("accepted");

		const priorAttemptOnly = judge([], changed);
		expect(priorAttemptOnly.verdict).toBe("rejected");
		expect(buildNeedsMoreRequest(priorAttemptOnly, [], [])).toContain("Leave changes empty");
		expect(judge([], []).verdict).toBe("accepted");
	});

	it("accepts the command-result receipt citation without copying command bytes", async () => {
		const receipt = commandReceiptFor({
			requestId: "request",
			toolCallId: "call",
			toolName: "bash",
			args: { command: "printf  'proof'" },
			isError: false,
			result: { details: { exitCode: 0 } },
		})!;
		const citation = JSON.parse(workerCommandCheckCitation(receipt)!);
		const capture: WorkerReportCapture = {};
		const receipts = [receipt];
		const tool = createSubmitReportTool(capture, { rootAnswer: false, progress: false }, receipts);
		const base = { status: "completed" as const, summary: "Checked the change." };
		const judge = () =>
			judgeSubmittedReport({
				context: { writeCapable: false, verifier: false, requirementIds: [] },
				cwd: process.cwd(),
				receipts,
				changedFiles: [],
				submitted: capture.submitted!,
			});
		expect(Value.Check(tool.parameters, { ...base, checks: [citation] })).toBe(true);
		await tool.execute("report", { ...base, checks: [citation] });
		const check = capture.submitted!.report.checks[0]!;
		expect(check.commandDigest).toBe(receipt.commandDigest);
		expect(resolvedCheckReceipt(check, receipts)?.receipt).toBe(receipt);
		expect(judge().verdict).toBe("accepted");

		await tool.execute("report", { ...base, checks: [{ ...citation, command: "printf 'proof'" }] });
		expect(judge().reasonCodes).toContain("check_command_mismatch");
		await tool.execute("report", { ...base, checks: [{ ...citation, receiptId: "c-unknown" }] });
		expect(judge().reasonCodes).toContain("check_unknown_receipt");
		await tool.execute("report", { ...base, checks: [{ ...citation, result: "failed" }] });
		expect(judge().reasonCodes).toContain("check_contradicted_by_receipt");
		receipts.push({ ...receipt });
		await tool.execute("report", { ...base, checks: [citation] });
		expect(judge().reasonCodes).toContain("check_ambiguous_receipt");
		receipts.pop();
		receipts[0] = { ...receipt, exitCode: undefined };
		expect(workerCommandCheckCitation(receipts[0])).toBeUndefined();
		await tool.execute("report", { ...base, checks: [citation] });
		expect(judge().reasonCodes).toContain("check_incomplete_receipt");
		await expect(tool.execute("report", { ...base, checks: [{ result: "passed" }] })).rejects.toThrow(
			"needs a host receiptId or exact command",
		);
	});

	it.each(["cancelled", "failed", "completed"] as const)(
		"retains and acknowledges %s uncertainty without asserting any changed path",
		(status) => {
			const claim: WorkerClaim = {
				requestId: request.id,
				terminalAttemptId: "attempt",
				status,
				summary: "Worker execution ended.",
				changedFiles: [],
				hostFindings: [hostFinding("mutation_uncertain", "An operation did not provide a final file state.")],
				usageReportId: "usage",
				createdAt: updatedAt,
			};
			const result = createWorkerResultContract({
				handle: {
					objectiveId: "objective",
					taskId: request.id,
					attemptId: "attempt",
					leaseId: "lease",
					fencingToken: 1,
					expiresAt: updatedAt,
				},
				claim,
				accepted: false,
				cwd: process.cwd(),
				wallClockMs: 1,
				toolCalls: 1,
				createdAt: updatedAt,
			});
			expect(result.artifacts).toEqual([]);
			expect(result.evidence).toContainEqual(
				expect.objectContaining({ trusted: true, metadata: { observation: "worker_mutation_uncertain" } }),
			);
			expect(result.nextAction).toBe("parent_review");

			const session = sessionManager();
			appendWorkerClaimSnapshot(session, claim, request);
			const latest = () => getLatestWorkerClaimSnapshot(getActiveSessionBranchEntries(session), request.id)?.claim;
			expect(latest()?.parentReviewRequired).toBe(true);
			expect(acknowledgeWorkerClaimReview(session, request.id, () => updatedAt)).toEqual({
				ok: true,
				requestId: request.id,
				reviewedAt: updatedAt,
			});
			expect(latest()?.parentReviewedAt).toBe(updatedAt);
		},
	);
	it.each(["failed", "in_flight", "bash", "python", "run_process"] as const)(
		"rehydrates %s uncertainty separately from successful paths",
		(termination) => {
			const conversation = workerConversation(sessionManager());
			const ownedWrites: string[] = [];
			const open = () =>
				new WorkerMutationEvidence({
					attemptId: "attempt",
					cwd: process.cwd(),
					shellReadOnly: false,
					store: conversation,
					onOwnedWrite: (filePath) => ownedWrites.push(filePath),
					onPersistenceFailure: (message) => {
						throw new Error(message);
					},
				});
			const evidence = open();
			evidence.start("first", "write", { path: "confirmed.txt" });
			expect(evidence.end("first", { content: [] })).toEqual({ recordedPath: "confirmed.txt" });
			evidence.start("read-only", "bash", { command: "ls" });
			expect(evidence.finding()).toBeUndefined();
			switch (termination) {
				case "failed":
					evidence.start("second", "edit", { path: "unconfirmed.txt" });
					expect(evidence.end("second", undefined)).toBeUndefined();
					break;
				case "in_flight":
					evidence.start("second", "write", { path: "unconfirmed.txt" });
					break;
				case "bash":
					evidence.start("second", "bash", { command: "touch unconfirmed.txt" });
					break;
				case "python":
				case "run_process":
					evidence.start("second", termination, {});
					break;
			}
			evidence.seal();
			expect(evidence.end("second", { content: [] })).toBeUndefined();
			expect(ownedWrites).toEqual(["confirmed.txt"]);
			const resumed = open();
			expect([...resumed.changedFiles]).toEqual(["confirmed.txt"]);
			expect(resumed.finding()?.code).toBe("mutation_uncertain");
		},
	);
	it("reconstructs a reviewable cancellation claim from durable write starts without inventing a result", () => {
		const session = sessionManager();
		const conversation = workerConversation(session);
		const writeId = "a6db8338-8672-4b20-95e8-747ed946277d";
		const unfinishedId = "0a15ce61-7b30-42c6-815b-302005855672";
		conversation.recordNativeWriteProgress("attempt", writeId);
		conversation.recordNativeWriteProgress("attempt", writeId, "confirmed.txt");
		conversation.recordNativeWriteProgress("attempt", unfinishedId);

		const reopened = workerConversation(session);
		expect(reopened.getMutationProgress("another-attempt")).toEqual({
			changedFiles: [],
			uncertain: false,
			matched: false,
		});
		const parent = sessionManager();
		const latest = () => getLatestWorkerClaimSnapshot(getActiveSessionBranchEntries(parent), request.id)?.claim;
		const attempt = {
			attemptId: "attempt",
			taskId: request.id,
			agentId: "worker",
			status: "cancelled" as const,
			dispatch: {
				taskId: request.id,
				profileId: "implementer",
				instructions: request.instructions,
				resourcePointerIds: [],
			},
			checkpointIds: [],
			executionStartedAt: updatedAt,
			createdAt: updatedAt,
			updatedAt,
		};
		const recover = () =>
			retainCancelledWorkerMutationClaim({
				attempt,
				hasClaim: () => latest() !== undefined,
				openConversation: () => reopened,
				saveClaim: (claim) => {
					appendWorkerClaimSnapshot(parent, claim);
				},
				warn: (message) => {
					throw new Error(message);
				},
			});
		expect(recover()).toBe(true);
		expect(latest()).toMatchObject({
			terminalAttemptId: "attempt",
			status: "cancelled",
			changedFiles: ["confirmed.txt"],
			hostFindings: [{ code: "mutation_uncertain" }],
			parentReviewRequired: true,
		});
		expect(acknowledgeWorkerClaimReview(parent, request.id, () => updatedAt).ok).toBe(true);
		expect(recover()).toBe(true);
		expect(latest()?.parentReviewedAt).toBe(updatedAt);
	});
	it("exposes the exact recorded path only when that call's completion was persisted", () => {
		const cwd = process.cwd();
		const conversation = workerConversation(sessionManager());
		const warnings: string[] = [];
		const tracker = new WorkerMutationEvidence({
			attemptId: "current",
			cwd,
			shellReadOnly: true,
			store: {
				getMutationProgress: (id) => conversation.getMutationProgress(id),
				recordChangedFile: (id, file) => conversation.recordChangedFile(id, file),
				recordUncertainMutation: (id) => conversation.recordUncertainMutation(id),
				recordNativeWriteProgress: (id, writeId, file) => {
					if (file === "in-doubt.ts") throw new Error("unavailable");
					return conversation.recordNativeWriteProgress(id, writeId, file);
				},
			},
			onPersistenceFailure: (message) => warnings.push(message),
		});
		tracker.start("success", "edit", { path: path.join(cwd, "util.ts") });
		expect(tracker.end("success", { content: [] })).toEqual({ recordedPath: "util.ts" });
		expect(tracker.end("success", { content: [] })).toBeUndefined();
		tracker.start("spaced", "write", { path: path.join(cwd, "nested", "file with spaces.ts") });
		expect(tracker.end("spaced", { content: [] })).toEqual({ recordedPath: "nested/file with spaces.ts" });

		tracker.start("in-doubt", "write", { path: "in-doubt.ts" });
		expect(tracker.end("in-doubt", { content: [] })).toEqual({ recordedPath: undefined });
		expect(conversation.getMutationProgress("current").changedFiles).toEqual([
			"util.ts",
			"nested/file with spaces.ts",
		]);
		expect(warnings).toHaveLength(1);
	});

	it.each(["edit", "bash", "python", "run_process"])(
		"refuses %s before running when evidence cannot persist",
		(tool) => {
			const fail = () => {
				throw new Error("mutation journal unavailable");
			};
			const tracker = new WorkerMutationEvidence({
				attemptId: "attempt",
				cwd: process.cwd(),
				shellReadOnly: false,
				store: {
					getMutationProgress: () => ({ changedFiles: [], uncertain: false, matched: false }),
					recordChangedFile: fail,
					recordNativeWriteProgress: fail,
					recordUncertainMutation: fail,
				},
				onPersistenceFailure: fail,
			});
			expect(() => tracker.start("call", tool, { path: "file.txt", command: "touch file.txt" })).toThrow(
				"mutation journal unavailable",
			);
			expect(tracker.end("call", { content: [] })).toBeUndefined();
			expect(tracker.finding()).toBeUndefined();
		},
	);
	it("recovers structured-action effects from the journal at the exact attempt", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "pi-worker-action-evidence-"));
		try {
			const scope = {
				agentDir,
				orchestrationHome: ownerOrchestrationHome(agentDir),
				parentSessionId: "owner-session",
				taskId: request.id,
				attemptId: "attempt",
				fencingToken: 1,
			};
			const journal = new WorkerActionJournal(scope);
			const record = (index: number, file: string) =>
				journal.begin({
					index,
					action: { op: "write", path: file, content: "fixture" },
					targetPath: path.join(agentDir, file),
				});
			const confirmed = record(0, "confirmed.txt");
			if (confirmed.kind !== "execute") throw new Error("Expected fresh structured action intent.");
			journal.recordSucceeded(confirmed);
			expect(record(1, "unknown.txt").kind).toBe("execute");
			expect(readWorkerActionMutationProgress({ ...scope, cwd: agentDir })).toEqual({
				changedFiles: ["confirmed.txt"],
				uncertain: true,
			});
			expect(readWorkerActionMutationProgress({ ...scope, cwd: agentDir, attemptId: "different-attempt" })).toEqual({
				changedFiles: [],
				uncertain: false,
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
