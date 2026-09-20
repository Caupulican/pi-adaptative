/**
 * Capability Proof Runner.
 * The trusted execution/test boundary for capability proof obligations.
 *
 * A proof is only satisfied by running its command to completion and recording the real
 * exit status, output digest, and elapsed time. No proof result is ever asserted.
 * Conforms to EXECUTION_FAIL_CLOSED.md and RCG-020..RCG-024.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { platform } from "node:process";

export type ProofKind = "deterministic_test" | "task_specific_test";

export interface ProofExecutionResult {
	readonly proofId: string;
	readonly kind: ProofKind;
	readonly command: string;
	readonly status: "passed" | "failed";
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly outputDigest: string;
	readonly outputTail: string;
	readonly elapsedMs: number;
	readonly evidenceRef: string;
	readonly startedAt: string;
}

export interface ProofRunRequest {
	readonly proofId: string;
	readonly kind: ProofKind;
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface CapabilityProofRunnerPort {
	runProof(request: ProofRunRequest): Promise<ProofExecutionResult>;
}

const DEFAULT_PROOF_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const OUTPUT_TAIL_BYTES = 2_048;

/**
 * Executes proof commands in a bounded host-owned child process.
 * The runner never interprets the command; it reports what the command actually did.
 */
export class CapabilityProofRunner implements CapabilityProofRunnerPort {
	private readonly defaultTimeoutMs: number;

	constructor(options: { defaultTimeoutMs?: number } = {}) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_PROOF_TIMEOUT_MS;
	}

	runProof(request: ProofRunRequest): Promise<ProofExecutionResult> {
		const command = request.command.trim();
		if (!command) {
			return Promise.reject(new Error(`Proof '${request.proofId}' has no executable command.`));
		}
		const startedAt = new Date().toISOString();
		const start = Date.now();
		const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;

		return new Promise<ProofExecutionResult>((resolve, reject) => {
			const isWindows = platform === "win32";
			// `cmd /s /c` strips exactly one surrounding quote pair from the command line, so the
			// command is wrapped here and reaches cmd verbatim even when it starts with a quoted path.
			const child = isWindows
				? spawn(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
						cwd: request.cwd,
						windowsVerbatimArguments: true,
						stdio: ["ignore", "pipe", "pipe"],
					})
				: spawn("/bin/sh", ["-c", command], {
						cwd: request.cwd,
						stdio: ["ignore", "pipe", "pipe"],
					});

			const chunks: Buffer[] = [];
			let captured = 0;
			const capture = (data: Buffer): void => {
				if (captured >= MAX_CAPTURED_OUTPUT_BYTES) return;
				const room = MAX_CAPTURED_OUTPUT_BYTES - captured;
				const slice = data.length > room ? data.subarray(0, room) : data;
				chunks.push(slice);
				captured += slice.length;
			};
			child.stdout?.on("data", capture);
			child.stderr?.on("data", capture);

			let settled = false;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);

			const onAbort = (): void => {
				child.kill("SIGKILL");
			};
			request.signal?.addEventListener("abort", onAbort, { once: true });

			const cleanup = (): void => {
				clearTimeout(timer);
				request.signal?.removeEventListener("abort", onAbort);
			};

			child.on("error", (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			});

			child.on("close", (exitCode, terminationSignal) => {
				if (settled) return;
				settled = true;
				cleanup();
				const output = Buffer.concat(chunks).toString("utf-8");
				const outputDigest = createHash("sha256").update(output).digest("hex");
				const elapsedMs = Date.now() - start;
				const passed = exitCode === 0 && !timedOut && !request.signal?.aborted;
				resolve({
					proofId: request.proofId,
					kind: request.kind,
					command,
					status: passed ? "passed" : "failed",
					exitCode,
					signal: terminationSignal ?? (timedOut ? "SIGKILL" : null),
					outputDigest,
					outputTail: output.slice(-OUTPUT_TAIL_BYTES),
					elapsedMs,
					evidenceRef: `proof:${request.proofId}:${outputDigest.slice(0, 16)}`,
					startedAt,
				});
			});
		});
	}
}
