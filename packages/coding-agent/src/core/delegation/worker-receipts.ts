/**
 * Command receipts: what the host saw a worker run, recorded from the tool result and never from the
 * worker's own words. A submitted report cites a receipt id as its proof, and the host checks what the
 * report says about a command against what the receipt holds (exit code, error state).
 */

import type { WorkerCommandReceipt } from "../autonomy/contracts.ts";
import { containsCredential } from "../system-one/projector.ts";
import { MAX_WORKER_CLAIM_COMMAND_CHARS, MAX_WORKER_CLAIM_COMMAND_RECEIPTS } from "./worker-claim.ts";

/** Tools that run a command the worker can later claim a result for. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "run_process", "python"]);

const REDACTED_COMMAND = "[command withheld: it contained a credential]";

function commandOf(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	if (toolName === "bash") return typeof record.command === "string" ? record.command : undefined;
	if (toolName === "python") return typeof record.code === "string" ? record.code : undefined;
	if (typeof record.executable !== "string") return undefined;
	const rest = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
	return [record.executable, ...rest].join(" ").trim();
}

/** The shell tool's own status line for a command that ran and exited non-zero. */
const EXIT_STATUS_LINE = /^Command exited with code (\d+)$/m;

function exitCodeOf(result: {
	content?: readonly { type: string; text?: string }[];
	details?: unknown;
}): number | undefined {
	const details = result.details;
	if (details && typeof details === "object") {
		const exitCode = (details as { exitCode?: unknown }).exitCode;
		if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
	}
	for (const block of result.content ?? []) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		const match = EXIT_STATUS_LINE.exec(block.text);
		if (match?.[1]) return Number(match[1]);
	}
	return undefined;
}

function detailString(details: unknown, key: string): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const value = (details as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detailNumber(details: unknown, key: string): number | undefined {
	if (!details || typeof details !== "object") return undefined;
	const value = (details as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * The receipt for one finished tool call, or undefined when the tool is not one that runs a command.
 * The command is bounded and withheld entirely when it carries a credential.
 */
export function commandReceiptFor(input: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	isError: boolean;
	result: { content?: readonly { type: string; text?: string }[]; details?: unknown };
}): WorkerCommandReceipt | undefined {
	if (!COMMAND_TOOLS.has(input.toolName)) return undefined;
	const command = commandOf(input.toolName, input.args);
	if (!command) return undefined;
	const exitCode = exitCodeOf(input.result);
	const durationMs = detailNumber(input.result.details, "durationMs");
	const outputRef = detailString(input.result.details, "fullOutputPath");
	const flat = command.replace(/\s+/g, " ").trim();
	return {
		id: input.toolCallId,
		tool: input.toolName,
		command: containsCredential(flat)
			? REDACTED_COMMAND
			: flat.length <= MAX_WORKER_CLAIM_COMMAND_CHARS
				? flat
				: `${flat.slice(0, MAX_WORKER_CLAIM_COMMAND_CHARS - 1)}…`,
		isError: input.isError,
		...(exitCode !== undefined ? { exitCode } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(outputRef !== undefined ? { outputRef } : {}),
	};
}

/** Append a receipt, keeping the most recent within the claim's bound. */
export function appendCommandReceipt(receipts: WorkerCommandReceipt[], receipt: WorkerCommandReceipt): void {
	receipts.push(receipt);
	if (receipts.length > MAX_WORKER_CLAIM_COMMAND_RECEIPTS)
		receipts.splice(0, receipts.length - MAX_WORKER_CLAIM_COMMAND_RECEIPTS);
}
