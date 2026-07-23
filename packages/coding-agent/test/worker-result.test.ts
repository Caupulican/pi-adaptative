import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, WorkerClaim, WorkerRequest } from "../src/core/autonomy/contracts.ts";
import { requiresParentReview, validateWorkerClaim } from "../src/core/delegation/worker-result.ts";

describe("Worker Result Validator (Phase 6)", () => {
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

	describe("validateWorkerClaim", () => {
		it("request id mismatch blocks", () => {
			const outcome = validateWorkerClaim({
				request: mockRequest,
				claim: { ...baseClaim, requestId: "req-other" },
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("request_id_mismatch");
		});

		it("missing usageReportId blocks completed result", () => {
			const outcome = validateWorkerClaim({
				request: mockRequest,
				claim: { ...baseClaim, usageReportId: undefined },
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_usage_report");
		});

		it("blocked worker returns structured blockers in details", () => {
			const outcome = validateWorkerClaim({
				request: mockRequest,
				claim: {
					...baseClaim,
					status: "blocked",
					blockers: ["missing permission"],
				},
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("worker_not_completed");
			expect(outcome.details?.blockers).toEqual(["missing permission"]);
		});

		it("failed/cancelled result requires parent review or blocks", () => {
			const outcomeFailed = validateWorkerClaim({
				request: mockRequest,
				claim: { ...baseClaim, status: "failed" },
			});
			expect(outcomeFailed.outcome).toBe("block");

			const outcomeCancelled = validateWorkerClaim({
				request: mockRequest,
				claim: { ...baseClaim, status: "cancelled" },
			});
			expect(outcomeCancelled.outcome).toBe("block");
		});

		it("successful read-only worker with evidence and no changes can be allowed", () => {
			const outcome = validateWorkerClaim({
				request: mockRequest,
				claim: { ...baseClaim, evidence: { query: "q", sources: [], findings: [] } },
			});
			expect(outcome.outcome).toBe("allow");
			expect(outcome.reasonCode).toBe("allowed");
		});

		it("completed worker with blockers requires parent review", () => {
			const outcome = validateWorkerClaim({
				request: mockRequest,
				claim: { ...baseClaim, blockers: ["needs manual verification"] },
			});
			expect(outcome.outcome).toBe("ask-user");
			expect(outcome.reasonCode).toBe("parent_review_required");
			expect(outcome.details?.blockers).toEqual(["needs manual verification"]);
		});

		describe("Path Scoping", () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-test-"));
			const allowedRoot = path.join(tempDir, "allowed");
			const deniedPath = path.join(allowedRoot, "denied");
			const outsidePath = path.join(tempDir, "outside");

			const testEnv: CapabilityEnvelope = {
				id: "env-test",
				capabilities: ["filesystem.write"],
				allowedPaths: [allowedRoot],
				deniedPaths: [deniedPath],
			};

			const testReq: WorkerRequest = { ...mockRequest, envelope: testEnv };

			beforeAll(() => {
				fs.mkdirSync(allowedRoot, { recursive: true });
				fs.mkdirSync(deniedPath, { recursive: true });
				fs.mkdirSync(outsidePath, { recursive: true });
			});

			afterAll(() => {
				fs.rmSync(tempDir, { recursive: true, force: true });
			});

			it("changed file outside envelope path invalidates result", () => {
				const changedFile = path.join(outsidePath, "file.txt");
				const outcome = validateWorkerClaim({
					request: testReq,
					claim: { ...baseClaim, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("changed_file_outside_scope");
			});

			it("changed file under denied path invalidates result", () => {
				const changedFile = path.join(deniedPath, "file.txt");
				const outcome = validateWorkerClaim({
					request: testReq,
					claim: { ...baseClaim, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("changed_file_denied");
			});

			it("changed files inside allowed scope require parent review", () => {
				const changedFile = path.join(allowedRoot, "file.txt");
				const outcome = validateWorkerClaim({
					request: testReq,
					claim: { ...baseClaim, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("ask-user");
				expect(outcome.reasonCode).toBe("parent_review_required");
			});

			it("relative changed files resolve against the session cwd (the runner's reporting baseline)", () => {
				// applyWorkerActions reports changed files relative to the session cwd — the
				// validator must use the SAME baseline, not the allowed root.
				const outcome = validateWorkerClaim({
					request: testReq,
					claim: { ...baseClaim, changedFiles: ["allowed/src/file.txt"] },
					cwd: tempDir,
				});
				expect(outcome.outcome).toBe("ask-user");
				expect(outcome.reasonCode).toBe("parent_review_required");
			});

			it("cwd-relative changed file under a denied path is blocked (no double-prefix dodge)", () => {
				// Under the old per-root resolution, "allowed/denied/file.txt" double-prefixed to
				// <root>/allowed/denied/file.txt, sailing past the deny rule.
				const outcome = validateWorkerClaim({
					request: testReq,
					claim: { ...baseClaim, changedFiles: ["allowed/denied/file.txt"] },
					cwd: tempDir,
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("changed_file_denied");
			});

			it("relative changed files cannot escape the allowed root", () => {
				const outcome = validateWorkerClaim({
					request: testReq,
					claim: { ...baseClaim, changedFiles: ["../outside/file.txt"] },
					cwd: allowedRoot,
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("changed_file_outside_scope");
			});

			it("missing allowedPaths in request envelope blocks changed files", () => {
				const changedFile = path.join(allowedRoot, "file.txt");
				const outcome = validateWorkerClaim({
					request: { ...testReq, envelope: { ...testEnv, allowedPaths: [] } },
					claim: { ...baseClaim, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("missing_path_scope");
			});
		});

		it("validator does not mutate request/result changedFiles/blockers arrays", () => {
			const blockers = ["b1"];
			const changedFiles = ["f1"];
			const claim: WorkerClaim = {
				...baseClaim,
				status: "blocked",
				blockers,
				changedFiles,
			};
			validateWorkerClaim({ request: mockRequest, claim });

			expect(claim.blockers).toBe(blockers);
			expect(claim.changedFiles).toBe(changedFiles);
		});
	});

	describe("requiresParentReview", () => {
		it("true for changed files", () => {
			expect(requiresParentReview({ ...baseClaim, changedFiles: ["file.txt"] })).toBe(true);
		});

		it("true for failed/blocked/cancelled status", () => {
			expect(requiresParentReview({ ...baseClaim, status: "failed" })).toBe(true);
			expect(requiresParentReview({ ...baseClaim, status: "blocked" })).toBe(true);
			expect(requiresParentReview({ ...baseClaim, status: "cancelled" })).toBe(true);
		});

		it("true for blockers present", () => {
			expect(requiresParentReview({ ...baseClaim, status: "completed", blockers: ["b"] })).toBe(true);
		});

		it("false for completed no-change/no-blocker result", () => {
			expect(requiresParentReview({ ...baseClaim })).toBe(false);
		});
	});
});
