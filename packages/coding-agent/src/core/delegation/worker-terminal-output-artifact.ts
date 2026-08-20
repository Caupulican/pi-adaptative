import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import { workerTerminalOutputArtifactFile } from "../agent-paths.ts";
import type { ArtifactContract, WorkerResultContract } from "../orchestration/contracts.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";

export const WORKER_TERMINAL_OUTPUT_INLINE_BYTES = DEFAULT_MAX_BYTES;

export interface CaptureWorkerTerminalOutputArtifactInput {
	agentDir: string;
	parentSessionId: string;
	attemptId: string;
	text: string;
	createdAt: string;
}

/** Resolve only the host-produced lossless terminal report from a durable worker result. */
export function workerTerminalOutputArtifact(
	result: Pick<WorkerResultContract, "artifacts"> | undefined,
): ArtifactContract | undefined {
	return result?.artifacts.find(
		(artifact) =>
			artifact.kind === "report" &&
			artifact.metadata?.source === "worker_terminal_output" &&
			artifact.metadata.complete === true,
	);
}

/** Persist terminal output that cannot fit in the durable inline summary and return its verified pointer. */
export function captureWorkerTerminalOutputArtifact(
	input: CaptureWorkerTerminalOutputArtifactInput,
): ArtifactContract | undefined {
	const sizeBytes = Buffer.byteLength(input.text, "utf8");
	if (sizeBytes <= WORKER_TERMINAL_OUTPUT_INLINE_BYTES) return undefined;

	const attemptDigest = createHash("sha256").update(input.attemptId).digest("hex");
	const contentDigest = createHash("sha256").update(input.text).digest("hex");
	const filePath = workerTerminalOutputArtifactFile(
		input.agentDir,
		input.parentSessionId,
		attemptDigest,
		contentDigest,
	);
	const artifactDirectory = dirname(filePath);
	mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(artifactDirectory, 0o700);
	writeFileAtomicSync(filePath, input.text, { mode: 0o600 });
	const persisted = readBoundedTextFileSync(filePath, sizeBytes, "Worker terminal output artifact");
	const persistedDigest = createHash("sha256").update(persisted).digest("hex");
	if (persistedDigest !== contentDigest || Buffer.byteLength(persisted, "utf8") !== sizeBytes) {
		throw new Error("Worker terminal output artifact failed post-write verification.");
	}

	return {
		artifactId: `worker-output-${attemptDigest.slice(0, 16)}-${contentDigest.slice(0, 16)}`,
		kind: "report",
		uri: pathToFileURL(filePath).href,
		digest: contentDigest,
		sizeBytes,
		createdAt: input.createdAt,
		metadata: {
			source: "worker_terminal_output",
			contentType: "text/plain; charset=utf-8",
			complete: true,
			digestAlgorithm: "sha256",
		},
	};
}
