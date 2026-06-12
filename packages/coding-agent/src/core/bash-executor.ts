/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import type { WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { createSafeWriteStream } from "../utils/safe-write-stream.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { classifyGitCommand, executeFilteredGit } from "./tools/git-filter.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

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
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

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
			const res = await executeFilteredGit(
				cwd,
				classification.subcommand,
				classification.globalOptions || [],
				classification.subcommandArgs || [],
				{ signal: options.signal },
			);
			if (res.exitCode !== -100) {
				const rawBytes = res.rawBytes ?? Buffer.from(res.rawOut, "utf-8");
				// The filter already spills oversized output to a temp file; reuse it
				// instead of materializing another full copy here.
				let fullOutputPath = res.fullOutputPath;
				if (fullOutputPath === undefined && rawBytes.length > DEFAULT_MAX_BYTES) {
					const id = randomBytes(8).toString("hex");
					fullOutputPath = join(tmpdir(), `pi-bash-${id}.log`);
					const tempFileStream = createSafeWriteStream(fullOutputPath);
					tempFileStream.write(rawBytes);
					tempFileStream.end();
				}
				options.onChunk?.(res.output);
				return {
					output: res.output,
					exitCode: res.exitCode,
					cancelled: options.signal?.aborted ?? false,
					truncated: res.fullOutputPath !== undefined || rawBytes.length > DEFAULT_MAX_BYTES,
					fullOutputPath,
				};
			}
		}
	}

	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		// On stream failure (e.g. disk full), drop the artifact instead of
		// crashing the process; the rolling in-memory output is still returned.
		tempFileStream = createSafeWriteStream(tempFilePath, () => {
			tempFileStream = undefined;
			tempFilePath = undefined;
		});
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		// Guard writableEnded: custom BashOperations may deliver late onData
		// callbacks after an abort path has already ended the stream.
		if (tempFileStream && !tempFileStream.writableEnded) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		if (tempFileStream) {
			tempFileStream.end();
		}
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			if (tempFileStream) {
				tempFileStream.end();
			}
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		if (tempFileStream) {
			tempFileStream.end();
		}

		throw err;
	}
}
