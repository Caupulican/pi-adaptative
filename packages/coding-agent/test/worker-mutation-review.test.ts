import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import {
	buildNeedsMoreRequest,
	buildReportRequest,
	judgeSubmittedReport,
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
			expect(evidence.end("first", { content: [] })).toBe(true);
			evidence.start("read-only", "bash", { command: "ls" });
			expect(evidence.finding()).toBeUndefined();
			switch (termination) {
				case "failed":
					evidence.start("second", "edit", { path: "unconfirmed.txt" });
					expect(evidence.end("second", undefined)).toBe(false);
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
			expect(evidence.end("second", { content: [] })).toBe(false);
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
			expect(tracker.end("call", { content: [] })).toBe(false);
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
