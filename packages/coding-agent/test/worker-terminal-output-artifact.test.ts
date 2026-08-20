import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureWorkerTerminalOutputArtifact,
	WORKER_TERMINAL_OUTPUT_INLINE_BYTES,
} from "../src/core/delegation/worker-terminal-output-artifact.ts";

const temporaryRoots: string[] = [];

async function temporaryAgentDir(): Promise<string> {
	const root = await mkdtemp(`${await realpath(tmpdir())}/pi-worker-output-`);
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worker terminal output artifacts", () => {
	it("uses the shared 50 KiB inline-output ceiling", async () => {
		expect(WORKER_TERMINAL_OUTPUT_INLINE_BYTES).toBe(50 * 1024);
		const artifact = captureWorkerTerminalOutputArtifact({
			agentDir: await temporaryAgentDir(),
			parentSessionId: "parent-session",
			attemptId: "attempt-boundary",
			text: "x".repeat(50 * 1024),
			createdAt: "2026-08-20T00:00:00.000Z",
		});
		expect(artifact).toBeUndefined();
	});

	it("keeps bounded output inline without creating an artifact", async () => {
		const artifact = captureWorkerTerminalOutputArtifact({
			agentDir: await temporaryAgentDir(),
			parentSessionId: "parent-session",
			attemptId: "attempt-1",
			text: "short terminal output",
			createdAt: "2026-08-20T00:00:00.000Z",
		});

		expect(artifact).toBeUndefined();
	});

	it("persists exact long UTF-8 output and returns a verified file pointer", async () => {
		const agentDir = await temporaryAgentDir();
		const text = `terminal header\n${"evidence-λ\n".repeat(WORKER_TERMINAL_OUTPUT_INLINE_BYTES)}`;
		const artifact = captureWorkerTerminalOutputArtifact({
			agentDir,
			parentSessionId: "parent/session",
			attemptId: "attempt/1",
			text,
			createdAt: "2026-08-20T00:00:00.000Z",
		});

		expect(artifact).toMatchObject({
			kind: "report",
			digest: createHash("sha256").update(text).digest("hex"),
			sizeBytes: Buffer.byteLength(text, "utf8"),
			metadata: {
				source: "worker_terminal_output",
				contentType: "text/plain; charset=utf-8",
				complete: true,
			},
		});
		if (!artifact) throw new Error("Expected a worker terminal output artifact.");
		const file = fileURLToPath(artifact.uri);
		expect(await readFile(file, "utf8")).toBe(text);
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

		const replay = captureWorkerTerminalOutputArtifact({
			agentDir,
			parentSessionId: "parent/session",
			attemptId: "attempt/1",
			text,
			createdAt: "2026-08-20T00:00:01.000Z",
		});
		expect(replay?.uri).toBe(artifact.uri);
		expect(await readFile(file, "utf8")).toBe(text);
	});

	it("does not discard terminal output after it crosses the inline ceiling", async () => {
		const text = "x".repeat(16 * 1024 * 1024 + 1);
		const artifact = captureWorkerTerminalOutputArtifact({
			agentDir: await temporaryAgentDir(),
			parentSessionId: "parent-session",
			attemptId: "attempt-unbounded-spill",
			text,
			createdAt: "2026-08-20T00:00:00.000Z",
		});

		if (!artifact) throw new Error("Expected a worker terminal output artifact.");
		const file = fileURLToPath(artifact.uri);
		expect(artifact.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
		expect((await stat(file)).size).toBe(Buffer.byteLength(text, "utf8"));
		expect(await readFile(file, "utf8")).toBe(text);
	});
});
