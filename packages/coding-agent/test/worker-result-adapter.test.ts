import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import {
	createWorkerResultContract,
	MAX_WORKER_ARTIFACT_HASH_BYTES,
	MAX_WORKER_ARTIFACT_HASH_TOTAL_BYTES,
} from "../src/core/orchestration/worker-result-adapter.ts";

const roots: string[] = [];

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-result-adapter-"));
	roots.push(directory);
	return directory;
}

function createResult(cwd: string, claim: WorkerClaim) {
	const handle: StartedDelegationAttempt = {
		objectiveId: "objective-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		leaseId: "lease-1",
		fencingToken: 1,
		expiresAt: "2026-07-27T00:01:00.000Z",
	};
	return createWorkerResultContract({
		handle,
		claim,
		accepted: true,
		cwd,
		wallClockMs: 1,
		toolCalls: 0,
		createdAt: "2026-07-27T00:00:00.000Z",
	});
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("createWorkerResultContract", () => {
	it("records a deterministic bounded-memory SHA-256 and linked host observation without trusting worker findings", () => {
		const cwd = root();
		const content = Buffer.from("worker artifact\n".repeat(10_000));
		writeFileSync(join(cwd, "changed.txt"), content);
		const result = createResult(cwd, {
			requestId: "request-1",
			status: "completed",
			summary: "worker summary",
			changedFiles: ["changed.txt"],
			evidence: {
				query: "check changed file",
				sources: [],
				findings: [{ id: "finding-1", summary: "worker-reported finding", evidenceIds: [], confidence: 0.9 }],
			},
		});

		const artifact = result.artifacts[0];
		expect(artifact).toMatchObject({
			artifactId: "changed-file-1",
			digest: createHash("sha256").update(content).digest("hex"),
			sizeBytes: content.length,
			metadata: {
				hostObservation: "file_state_captured",
				fileState: "regular",
				digestStatus: "computed",
				digestAlgorithm: "sha256",
				digestBytes: content.length,
			},
		});
		expect(result.evidence).toContainEqual({
			evidenceId: "host-file-state-1",
			kind: "observation",
			summary: "Host captured file state.",
			artifactIds: ["changed-file-1"],
			trusted: true,
			createdAt: "2026-07-27T00:00:00.000Z",
			metadata: { observation: "file_state_captured", fileState: "regular" },
		});
		expect(result.evidence).toContainEqual(
			expect.objectContaining({ evidenceId: "worker-finding-1", trusted: false }),
		);
	});

	it("records a missing changed file as a host observation without a digest", () => {
		const result = createResult(root(), {
			requestId: "request-1",
			status: "completed",
			summary: "worker summary",
			changedFiles: ["missing.txt"],
		});

		expect(result.artifacts[0]).toMatchObject({
			artifactId: "changed-file-1",
			metadata: { fileState: "missing", digestStatus: "not_available" },
		});
		expect(result.artifacts[0]?.digest).toBeUndefined();
		expect(result.evidence.find((evidence) => evidence.evidenceId === "host-file-state-1")).toMatchObject({
			artifactIds: ["changed-file-1"],
			metadata: { fileState: "missing" },
		});
	});

	it("retains large-file size while explicitly omitting a digest above the capture ceiling", () => {
		const cwd = root();
		const filePath = join(cwd, "large.bin");
		const chunk = Buffer.alloc(64 * 1024, 0x61);
		for (let written = 0; written <= MAX_WORKER_ARTIFACT_HASH_BYTES; written += chunk.length) {
			appendFileSync(filePath, chunk);
		}
		const result = createResult(cwd, {
			requestId: "request-1",
			status: "completed",
			summary: "worker summary",
			changedFiles: ["large.bin"],
		});

		expect(result.artifacts[0]).toMatchObject({
			sizeBytes: MAX_WORKER_ARTIFACT_HASH_BYTES + chunk.length,
			metadata: {
				fileState: "regular",
				digestStatus: "omitted_size_limit",
				digestMaxBytes: MAX_WORKER_ARTIFACT_HASH_BYTES,
			},
		});
		expect(result.artifacts[0]?.digest).toBeUndefined();
	});

	it("bounds aggregate synchronous hashing across a large changed-file set", () => {
		const cwd = root();
		const fullFile = Buffer.alloc(MAX_WORKER_ARTIFACT_HASH_BYTES, 0x61);
		const paths = Array.from(
			{ length: Math.floor(MAX_WORKER_ARTIFACT_HASH_TOTAL_BYTES / MAX_WORKER_ARTIFACT_HASH_BYTES) + 1 },
			(_, index) => `bounded-${index}.bin`,
		);
		for (const filePath of paths) writeFileSync(join(cwd, filePath), fullFile);
		const result = createResult(cwd, {
			requestId: "request-1",
			status: "completed",
			summary: "worker summary",
			changedFiles: paths,
		});

		const computedBytes = result.artifacts.reduce(
			(total, artifact) =>
				total +
				(artifact.metadata?.digestStatus === "computed" && typeof artifact.sizeBytes === "number"
					? artifact.sizeBytes
					: 0),
			0,
		);
		expect(computedBytes).toBe(MAX_WORKER_ARTIFACT_HASH_TOTAL_BYTES);
		expect(result.artifacts.at(-1)).toMatchObject({
			metadata: {
				fileState: "regular",
				digestStatus: "omitted_aggregate_limit",
				digestTotalMaxBytes: MAX_WORKER_ARTIFACT_HASH_TOTAL_BYTES,
			},
		});
	});

	it("records non-regular changed paths without treating their metadata as a digestable file", () => {
		const cwd = root();
		mkdirSync(join(cwd, "directory"));
		const result = createResult(cwd, {
			requestId: "request-1",
			status: "completed",
			summary: "worker summary",
			changedFiles: ["directory"],
		});

		expect(result.artifacts[0]).toMatchObject({
			metadata: { fileState: "non_regular", digestStatus: "not_applicable" },
		});
		expect(result.artifacts[0]?.digest).toBeUndefined();
	});

	it("rejects oversized hostile claims before file iteration or hashing", () => {
		const changedFiles = Array.from({ length: 129 }, () => "would-be-hashed.txt");
		let getterRead = false;
		Object.defineProperty(changedFiles, "0", {
			get: () => {
				getterRead = true;
				throw new Error("must not inspect hostile changed-file entries");
			},
		});
		expect(() =>
			createResult(root(), {
				requestId: "request-1",
				status: "completed",
				summary: "hostile summary",
				changedFiles,
			}),
		).toThrow("claim.changedFiles exceeds 128 entries");
		expect(getterRead).toBe(false);
	});
});
