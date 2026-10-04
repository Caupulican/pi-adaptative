/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { resolve as resolvePath } from "node:path";
import { getAgentDir } from "../config.ts";
import { sanitizeBinaryOutput } from "../kernel/utils/shell-output.ts";
import { DEFAULT_MAX_BYTES } from "../kernel/utils/truncate.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { getProcessWorkRun } from "../utils/work-directory.ts";
import { applyGitTailStage, classifyGitCommand, executeFilteredGit } from "./tools/git-filter.ts";
import { OutputAccumulator, type OutputSnapshot } from "./tools/output-accumulator.ts";
import type { BashOperations, BashResult } from "./tools/schemas/bash.ts";
import { createShellOutputDecoder } from "./tools/shell-output-decoder.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Enable conservative pi-native git output filtering for local default execution paths */
	enableGitFilter?: boolean;
	/** Wall-clock timeout in seconds. Direct interactive/RPC callers provide the same bounded default as the agent tool. */
	timeout?: number;
	/** Explicit process environment for both the filtered Git and shell execution paths. */
	environment?: NodeJS.ProcessEnv;
	/** Decode valid UTF-8 plus isolated Windows-1252 bytes from native Windows programs. */
	windowsCompatibleEncoding?: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

function createBashOutputAccumulator(): OutputAccumulator {
	return new OutputAccumulator({
		tempDirectory: getProcessWorkRun(getAgentDir(), "outputs", "bash").path,
		tempFilePrefix: "pi-bash",
	});
}

async function publishBashOutput(output: OutputAccumulator, persistAlways = false): Promise<OutputSnapshot> {
	output.finish();
	output.snapshot({ persistIfTruncated: true, persistAlways });
	await output.closeTempFile();
	// Re-read publication state after close: a close failure invalidates and removes the artifact.
	return output.snapshot();
}

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	if (options?.enableGitFilter) {
		const classification = classifyGitCommand(command, process.env);
		if (classification.eligible && classification.subcommand) {
			// Per-command backends have no persistent session: `cd <path> &&` only scopes this command.
			const gitCwd = classification.cwdPrefix !== undefined ? resolvePath(cwd, classification.cwdPrefix) : cwd;
			const res = await executeFilteredGit(
				gitCwd,
				classification.subcommand,
				classification.globalOptions || [],
				classification.subcommandArgs || [],
				{ signal: options.signal, timeout: options.timeout, environment: options.environment },
			);
			if (res.exitCode !== -100) {
				const rawOutputIncomplete = res.rawBytes === undefined;
				const rawBytes = res.rawBytes ?? Buffer.from(res.rawOut, "utf-8");
				// The filter already spills oversized output to a temp file; reuse that
				// authoritative artifact. A missing rawBytes value means only a retained
				// head is available and must never be relabelled as complete output.
				let fullOutputPath = res.fullOutputPath;
				if (fullOutputPath === undefined && !rawOutputIncomplete && rawBytes.length > DEFAULT_MAX_BYTES) {
					const persisted = createBashOutputAccumulator();
					persisted.append(rawBytes);
					fullOutputPath = (await publishBashOutput(persisted, true)).fullOutputPath;
				}
				const filteredOutput = applyGitTailStage(res.output, classification.tailStage);
				options.onChunk?.(filteredOutput);
				return {
					output: filteredOutput,
					exitCode: res.exitCode,
					cancelled: options.signal?.aborted ?? false,
					truncated: rawOutputIncomplete || rawBytes.length > DEFAULT_MAX_BYTES,
					fullOutputPath,
				};
			}
		}
	}

	const output = createBashOutputAccumulator();
	const decoder = createShellOutputDecoder(options?.windowsCompatibleEncoding);
	let acceptingOutput = true;

	const appendDecodedOutput = (decoded: string) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoded)).replace(/\r/g, "");
		if (text.length === 0) return;

		output.append(Buffer.from(text, "utf-8"));

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};
	const onData = (data: Buffer) => {
		if (!acceptingOutput) return;
		appendDecodedOutput(decoder.decode(data, { stream: true }));
	};
	const finishDecoding = () => {
		if (!acceptingOutput) return;
		acceptingOutput = false;
		appendDecodedOutput(decoder.decode());
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
			timeout: options?.timeout,
			env: options?.environment,
		});
		finishDecoding();

		const snapshot = await publishBashOutput(output);
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: snapshot.content,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: snapshot.truncation.truncated,
			fullOutputPath: snapshot.fullOutputPath,
		};
	} catch (err) {
		finishDecoding();
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const snapshot = await publishBashOutput(output);
			return {
				output: snapshot.content,
				exitCode: undefined,
				cancelled: true,
				truncated: snapshot.truncation.truncated,
				fullOutputPath: snapshot.fullOutputPath,
			};
		}

		output.finish();
		await output.discardTempFile();

		// The silence watchdog (see tools/bash.ts) throws a raw `silence:<secs>` sentinel.
		// Map it to the same user-facing message the interactive bash tool shows, instead of
		// leaking the sentinel to callers of this path (interactive !cmd, RPC).
		if (err instanceof Error && err.message.startsWith("silence:")) {
			const secs = err.message.split(":")[1];
			throw new Error(
				`Command killed after ${secs}s of silence (no output). If the command is legitimately quiet for long stretches, re-run it with an explicit timeout.`,
			);
		}

		throw err;
	}
}
