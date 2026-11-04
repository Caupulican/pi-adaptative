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
	command: Type.String(),
	repairOf: Type.Optional(
		Type.String({
			maxLength: MAX_VERIFICATION_ID_LENGTH,
			pattern: VERIFICATION_ID_PATTERN.source,
			description:
				"Active verification id whose empty-test setup error this corrected invocation repairs; test arguments must match and the run must pass.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			maximum: MAX_COMMAND_TIMEOUT_SECONDS,
			description: `Wall-clock timeout in seconds, not milliseconds. Default ${DEFAULT_COMMAND_TIMEOUT_SECONDS} (${MAX_COMMAND_TIMEOUT_SECONDS} for a background run); also bounds commands that keep producing output.`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Start as a session task and return its task id without waiting; the result arrives in the completion wake-up. Runs in its own shell from the current directory (cd and exports do not persist) and waits only for file writes emitted earlier in this message. Use only when other work can proceed meanwhile, never followed by an immediate tool_task wait; without the tool_task tool it runs in the foreground.",
		}),
	),
	broadSearch: Type.Optional(
		Type.Literal(BROAD_SEARCH_OUTPUT_ROUTE, {
			description:
				"Route a broad rg/grep/find/fd scan's complete output to a file, excluded from model context; detected broad scans are routed automatically.",
		}),
	),
	fullOutput: Type.Optional(
		Type.Boolean({
			description:
				"Return complete raw output with no filters; use only when the notice says lines were omitted and the persisted file is not enough.",
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
