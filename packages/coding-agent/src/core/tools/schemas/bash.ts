import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/utils/truncate.ts";
import {
	MAX_VERIFICATION_ID_LENGTH,
	VERIFICATION_ID_PATTERN,
	type VerificationRecord,
} from "../../../kernel/verification-obligations.ts";
import type { OutputReductionDetails } from "../output-reduction-types.ts";
import { BROAD_SEARCH_OUTPUT_ROUTE } from "../search-command-guard.ts";
import type { ShellOutputProjectionDetails } from "../shell-output-projection.ts";

/** Agent-facing wall-clock bound: continuously producing output must not make a command immortal. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 3600;

export const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	repairOf: Type.Optional(
		Type.String({
			maxLength: MAX_VERIFICATION_ID_LENGTH,
			pattern: VERIFICATION_ID_PATTERN.source,
			description:
				"Active verification id whose empty-test setup error this corrected invocation repairs. The host requires matching test arguments within this workspace and an executed pass; actual test failures cannot be replaced this way.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			maximum: MAX_COMMAND_TIMEOUT_SECONDS,
			description: `Wall-clock timeout in SECONDS, not milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_SECONDS} (${MAX_COMMAND_TIMEOUT_SECONDS} for a background run); positive overrides are capped at ${MAX_COMMAND_TIMEOUT_SECONDS}. Zero or negative values use the default.`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run as a session task at once and return its task id instead of waiting. It runs in its own shell started from the session's current directory (its cd and exports do not persist), waits only for file writes emitted before it in this message, and never blocks other commands. Use only when you will do other work before you need the result; a background start followed immediately by tool_task wait costs an extra request and is slower than a foreground call with a timeout. Its result arrives in the completion wake-up; tool_task wait is only for an omitted output (needs the tool_task tool; without it the command runs in the foreground). Omit to wait for the command (default, bounded by timeout).",
		}),
	),
	broadSearch: Type.Optional(
		Type.Literal(BROAD_SEARCH_OUTPUT_ROUTE, {
			description:
				"Explicit override for a broad rg/grep/find/fd scan that cannot be narrowed. The command runs, but its complete output is routed to a file and excluded from model context.",
		}),
	),
	fullOutput: Type.Optional(
		Type.Boolean({
			description:
				"Return the complete raw output for this call: no output filters (test projection, family reducers, generic cleaning). Use only when the filtered notice says lines were omitted and you need them verbatim; the persisted full output named in the notice is usually enough.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	fullOutputError?: string;
	persistedOutputTruncated?: boolean;
	persistedOutputBytes?: number;
	preview?: {
		content: string;
		skippedLines: number;
	};
	outputProjection?: ShellOutputProjectionDetails;
	/** Present when a family reducer produced the text; `rawPath` names the persisted raw output. */
	outputReduction?: OutputReductionDetails;
	piVerification?: VerificationRecord;
	/** The process's exit code when the command ran to completion; a worker's report is checked against it. */
	exitCode?: number;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed) plus, when the backend tracks it,
	 * the shell-reported working directory after the command ran. Stateful adapters must include
	 * initialCwd (explicitly undefined when unavailable); other adapters execute in the supplied cwd.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/** Host-owned directory pin; stateful backends must re-enter cwd under their execution lock. */
			forceCwd?: boolean;
			/**
			 * Run outside the agent's persistent shell session: the command starts in `cwd` with `env`,
			 * its cd and exports do not persist, and it never queues behind or blocks other commands.
			 */
			detached?: boolean;
		},
	) => Promise<{ exitCode: number | null; cwd?: string; initialCwd?: string }>;
}

/** Result of one host-side bash execution (the `!` command path and RPC). */
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
