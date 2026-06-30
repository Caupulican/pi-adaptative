import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, WorkerRequest, WorkerResult } from "../src/core/autonomy/contracts.ts";
import { requiresParentReview, validateWorkerResult } from "../src/core/delegation/worker-result.ts";

describe("Worker Result Validator (Phase 6)", () => {
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

	describe("validateWorkerResult", () => {
		it("request id mismatch blocks", () => {
			const outcome = validateWorkerResult({
				request: mockRequest,
				result: { ...baseResult, requestId: "req-other" },
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("request_id_mismatch");
		});

		it("missing usageReportId blocks completed result", () => {
			const outcome = validateWorkerResult({
				request: mockRequest,
				result: { ...baseResult, usageReportId: undefined },
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_usage_report");
		});

		it("blocked worker returns structured blockers in details", () => {
			const outcome = validateWorkerResult({
				request: mockRequest,
				result: {
					...baseResult,
					status: "blocked",
					blockers: ["missing permission"],
				},
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("worker_not_completed");
			expect(outcome.details?.blockers).toEqual(["missing permission"]);
		});

		it("failed/cancelled result requires parent review or blocks", () => {
			const outcomeFailed = validateWorkerResult({
				request: mockRequest,
				result: { ...baseResult, status: "failed" },
			});
			expect(outcomeFailed.outcome).toBe("block");

			const outcomeCancelled = validateWorkerResult({
				request: mockRequest,
				result: { ...baseResult, status: "cancelled" },
			});
			expect(outcomeCancelled.outcome).toBe("block");
		});

		it("successful read-only worker with evidence and no changes can be allowed", () => {
			const outcome = validateWorkerResult({
				request: mockRequest,
				result: { ...baseResult, evidence: { query: "q", sources: [], findings: [] } },
			});
			expect(outcome.outcome).toBe("allow");
			expect(outcome.reasonCode).toBe("allowed");
		});

		it("completed worker with blockers requires parent review", () => {
			const outcome = validateWorkerResult({
				request: mockRequest,
				result: { ...baseResult, blockers: ["needs manual verification"] },
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
				capabilities: ["write_files"],
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
				const outcome = validateWorkerResult({
					request: testReq,
					result: { ...baseResult, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("changed_file_outside_scope");
			});

			it("changed file under denied path invalidates result", () => {
				const changedFile = path.join(deniedPath, "file.txt");
				const outcome = validateWorkerResult({
					request: testReq,
					result: { ...baseResult, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("changed_file_denied");
			});

			it("changed files inside allowed scope require parent review", () => {
				const changedFile = path.join(allowedRoot, "file.txt");
				const outcome = validateWorkerResult({
					request: testReq,
					result: { ...baseResult, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("ask-user");
				expect(outcome.reasonCode).toBe("parent_review_required");
			});

			it("relative changed files resolve against the allowed root", () => {
				const outcome = validateWorkerResult({
					request: testReq,
					result: { ...baseResult, changedFiles: ["src/file.txt"] },
				});
				expect(outcome.outcome).toBe("ask-user");
				expect(outcome.reasonCode).toBe("parent_review_required");
			});

			it("relative changed files cannot escape the allowed root", () => {
				const outcome = validateWorkerResult({
					request: testReq,
					result: { ...baseResult, changedFiles: ["../outside/file.txt"] },
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("changed_file_outside_scope");
			});

			it("missing allowedPaths in request envelope blocks changed files", () => {
				const changedFile = path.join(allowedRoot, "file.txt");
				const outcome = validateWorkerResult({
					request: { ...testReq, envelope: { ...testEnv, allowedPaths: [] } },
					result: { ...baseResult, changedFiles: [changedFile] },
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("missing_path_scope");
			});
		});

		it("validator does not mutate request/result changedFiles/blockers arrays", () => {
			const blockers = ["b1"];
			const changedFiles = ["f1"];
			const result: WorkerResult = {
				...baseResult,
				status: "blocked",
				blockers,
				changedFiles,
			};
			validateWorkerResult({ request: mockRequest, result });

			expect(result.blockers).toBe(blockers);
			expect(result.changedFiles).toBe(changedFiles);
		});
	});

	describe("requiresParentReview", () => {
		it("true for changed files", () => {
			expect(requiresParentReview({ ...baseResult, changedFiles: ["file.txt"] })).toBe(true);
		});

		it("true for failed/blocked/cancelled status", () => {
			expect(requiresParentReview({ ...baseResult, status: "failed" })).toBe(true);
			expect(requiresParentReview({ ...baseResult, status: "blocked" })).toBe(true);
			expect(requiresParentReview({ ...baseResult, status: "cancelled" })).toBe(true);
		});

		it("true for blockers present", () => {
			expect(requiresParentReview({ ...baseResult, status: "completed", blockers: ["b"] })).toBe(true);
		});

		it("false for completed no-change/no-blocker result", () => {
			expect(requiresParentReview({ ...baseResult })).toBe(false);
		});
	});
});
