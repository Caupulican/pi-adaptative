/**
 * The run-scoped channel a `python` script reaches Pi's tools through (`pi_tools`), and the secret that proves a connection
 * is the run's own.
 *
 * Secret file lifecycle. `openToolBridge` writes the run's secret (32 random bytes, hex) into the run's private `mkdtemp`
 * directory, with mode `0600`, and names its path in `PI_TOOL_BRIDGE_TOKEN_FILE`. The generated client reads the file and
 * removes it the first time `pi_tools` is imported, so the secret lives only in that process after the import. What this
 * leaves, by design:
 * - A script that never imports `pi_tools` leaves the file readable for the whole run. The directory is removed when the run closes.
 * - The variable and the `PYTHONPATH` entry are inherited by the script's children. A child that imports `pi_tools` before
 *   any other process takes the secret. A child that imports it again (a `multiprocessing` worker under the spawn start
 *   method, the default on Windows and macOS) finds no file, is refused with `ToolRefused` ("could not be read and
 *   removed"), and has no tool access.
 * - On Windows `mode: 0o600` has no effect: the directory is protected by its inherited `%TEMP%` ACL, which is the basis
 *   of the file's protection there. A host crash leaves `pi-tb-*` directories behind, and nothing sweeps them. Each holds a
 *   secret that grants nothing once its channel is gone.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { formatSize, truncateHead } from "../../kernel/utils/truncate.ts";
import { type NestedCallHost, type NestedCallOutcome, startNestedCall } from "./nested-tool-call.ts";
import { renderToolBridgeClient } from "./tool-bridge-client.ts";
import {
	isToolBridgeMutation,
	MAX_TOOL_BRIDGE_CONCURRENT_CALLS,
	MAX_TOOL_BRIDGE_RESULT_BYTES,
	MAX_TOOL_BRIDGE_TRACE_LINES,
	MAX_TOOL_BRIDGE_TRACE_REASON_CHARS,
	TOOL_BRIDGE_ADDRESS_ENV,
	TOOL_BRIDGE_CALL_TIMEOUT_MS,
	TOOL_BRIDGE_CLIENT_MODULE,
	TOOL_BRIDGE_TOKEN_FILE_ENV,
	type ToolBridgeToolName,
} from "./tool-bridge-policy.ts";
import {
	openToolBridgeListener,
	type ToolBridgeFailureKind,
	type ToolBridgeListener,
	type ToolBridgeReply,
	type ToolBridgeRequest,
} from "./tool-bridge-server.ts";

/** The run's secret is written here, in the run's private directory, and the client removes it once it has read it. */
const SECRET_FILE_NAME = "secret";

/**
 * One bridged script run: the tool calls a `python` script makes through `pi_tools` while the run lasts.
 *
 * Every call is a sub-call of the admitted `python` call (nested-tool-call.ts): the session's own executor for that
 * tool, its schema, its binding, and the surface's admission (on the root, the session gate's `admitNested`: envelope,
 * path authority, credential guard, extension hooks, edge, operation, delegation, soul and System One checks; in a
 * worker lane, the lane's admission). Admission is one call at a time in arrival order; at most
 * {@link MAX_TOOL_BRIDGE_CONCURRENT_CALLS} admitted bodies run at once, and the run's mutations one at a time: they
 * write inside the run's own hold on the group lock, outside the per-file queue (file-mutation-queue.ts), so the run
 * orders them itself. The model-level failure memory is not
 * consulted (the script owns its retries); each outcome is counted in the run's report instead.
 *
 * Each call settles on its own (a mutation is one admitted, atomic call, never batched around a gate), so a run that
 * ends early leaves exactly the calls that already settled. Closing the run refuses further calls, cancels the ones
 * in flight, waits until every one has settled and removes the run's directory.
 */

export type ToolBridgeOutcome = "ok" | ToolBridgeFailureKind;

export interface ToolBridgeTraceEntry {
	readonly n: number;
	readonly tool: string;
	readonly outcome: ToolBridgeOutcome;
	readonly ms: number;
	/** Why a call did not succeed, cut short; never a tool's output. */
	readonly reason?: string;
}

export interface ToolBridgeReport {
	readonly tools: readonly ToolBridgeToolName[];
	readonly calls: number;
	readonly byTool: Readonly<Record<string, number>>;
	readonly outcomes: Readonly<Record<ToolBridgeOutcome, number>>;
	/** Connections closed because they did not prove the run's secret. */
	readonly authFailures: number;
	readonly ms: number;
	/** The first calls to settle (at most {@link MAX_TOOL_BRIDGE_TRACE_LINES}); a script's calls settle in order. */
	readonly trace: readonly ToolBridgeTraceEntry[];
}

export interface ToolBridgeRunOptions {
	readonly host: NestedCallHost;
	/** The admitted `python` call the script runs under. */
	readonly parentToolCallId: string;
	/** The tools this run named; a call to any other is refused. */
	readonly tools: readonly ToolBridgeToolName[];
	readonly maxCalls: number;
	readonly signal?: AbortSignal;
	/**
	 * Lets one mutation sub-call write inside the run's own place in the group lock (file-mutation-queue.ts); returns
	 * the release. Without it a script's edit would wait for the very run that is waiting for it.
	 */
	readonly carryMutation?: (childCallId: string) => () => void;
}

export interface ToolBridgeRun {
	/** The channel address and the path of the run's secret file, for the script's process only. */
	readonly environment: Readonly<Record<string, string>>;
	/** Holds the generated client module; goes on the script's import path. */
	readonly clientDirectory: string;
	close(): Promise<ToolBridgeReport>;
}

function emptyOutcomes(): Record<ToolBridgeOutcome, number> {
	return { ok: 0, refused: 0, error: 0, limit: 0, cancelled: 0 };
}

function boundedRunner(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (fn) => {
		if (active >= limit) await new Promise<void>((resolveSlot) => waiting.push(resolveSlot));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function oneLine(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

/** A tool's text handed to the script is bounded; the script decides what the model sees. */
function boundedText(text: string): string {
	const cut = truncateHead(text, { maxBytes: MAX_TOOL_BRIDGE_RESULT_BYTES, maxLines: Number.MAX_SAFE_INTEGER });
	if (!cut.truncated) return text;
	return `${cut.content}\n[cut: ${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)} shown; ask for a narrower range]`;
}

function replyFor(outcome: NestedCallOutcome): ToolBridgeReply {
	if (outcome.status === "ok") return { ok: true, text: boundedText(outcome.text) };
	return { ok: false, kind: outcome.status, message: boundedText(outcome.reason ?? outcome.text) };
}

/** The run's directory is scratch: a removal that fails is reported, and the script's result stands. */
async function removeRunDirectory(directory: string): Promise<void> {
	try {
		await rm(directory, { recursive: true, force: true });
	} catch (error) {
		harnessLog.warn("tools", "a script's tool-channel directory could not be removed", () => ({
			reason: error instanceof Error ? error.message : String(error),
		}));
	}
}

/**
 * The directory the run's socket directory is made in: the temp directory, unless a long one would push the socket path
 * past the Unix limit (about 104 bytes), in which case the short system temp directory.
 */
function bridgeBaseDirectory(): string {
	const base = tmpdir();
	if (process.platform === "win32") return base;
	const longest = Buffer.byteLength(join(base, "pi-tb-XXXXXX", "bridge.sock"));
	return longest <= 100 ? base : "/tmp";
}

export async function openToolBridge(options: ToolBridgeRunOptions): Promise<ToolBridgeRun> {
	const startedAt = Date.now();
	const directory = await mkdtemp(join(bridgeBaseDirectory(), "pi-tb-"));
	const requested: ReadonlySet<string> = new Set(options.tools);
	const runAbort = new AbortController();
	const stopWithParent = (): void => runAbort.abort(options.signal?.reason);
	if (options.signal?.aborted) stopWithParent();
	else options.signal?.addEventListener("abort", stopWithParent, { once: true });
	let calls = 0;
	const byTool: Record<string, number> = {};
	const outcomes = emptyOutcomes();
	const trace: ToolBridgeTraceEntry[] = [];
	const inflight = new Set<Promise<ToolBridgeReply>>();
	let admissionTail: Promise<unknown> = Promise.resolve();
	const runBody = boundedRunner(MAX_TOOL_BRIDGE_CONCURRENT_CALLS);
	const runMutation = boundedRunner(1);
	const cancelled = (message: string): ToolBridgeReply => ({ ok: false, kind: "cancelled", message });

	const answer = async (request: ToolBridgeRequest, n: number): Promise<ToolBridgeReply> => {
		if (runAbort.signal.aborted) return cancelled("the script run is ending");
		if (n > options.maxCalls) {
			return { ok: false, kind: "limit", message: `this run allows ${options.maxCalls} tool calls (maxToolCalls)` };
		}
		if (!requested.has(request.tool)) {
			return { ok: false, kind: "refused", message: `${request.tool} is not in this run's tools list` };
		}
		const id = `${options.parentToolCallId}#${n}`;
		const signal = AbortSignal.any([runAbort.signal, AbortSignal.timeout(TOOL_BRIDGE_CALL_TIMEOUT_MS)]);
		const mutation = isToolBridgeMutation(request.tool);
		const releaseCarry = mutation ? options.carryMutation?.(id) : undefined;
		try {
			// One admission at a time, in arrival order: an operator question is never asked twice at once.
			const admission = admissionTail.then(() =>
				startNestedCall(options.host, options.parentToolCallId, id, request.tool, request.args, signal),
			);
			admissionTail = admission.catch(() => undefined);
			const started = await admission;
			if (!("run" in started)) return replyFor(started.settled);
			const { run } = started;
			return replyFor(await runBody(mutation ? () => runMutation(run) : run));
		} catch {
			// Admission throws only when the call's signal ended it (the run ending, or the call's time running out).
			return cancelled(
				runAbort.signal.aborted
					? "the script run is ending"
					: `not settled within ${TOOL_BRIDGE_CALL_TIMEOUT_MS / 1000} seconds`,
			);
		} finally {
			releaseCarry?.();
		}
	};

	const handle = (request: ToolBridgeRequest): Promise<ToolBridgeReply> => {
		const n = ++calls;
		const startedCall = Date.now();
		const toolKey = requested.has(request.tool) ? request.tool : "other";
		byTool[toolKey] = (byTool[toolKey] ?? 0) + 1;
		const settled = answer(request, n).then((reply) => {
			const outcome: ToolBridgeOutcome = reply.ok ? "ok" : reply.kind;
			outcomes[outcome]++;
			if (trace.length < MAX_TOOL_BRIDGE_TRACE_LINES) {
				trace.push({
					n,
					tool: toolKey,
					outcome,
					ms: Date.now() - startedCall,
					...(reply.ok ? {} : { reason: oneLine(reply.message, MAX_TOOL_BRIDGE_TRACE_REASON_CHARS) }),
				});
			}
			return reply;
		});
		inflight.add(settled);
		void settled.finally(() => inflight.delete(settled));
		return settled;
	};

	let listener: ToolBridgeListener | undefined;
	try {
		const clientTools = options.tools.map((name) => {
			const parameters = options.host.resolveTool(name)?.parameters;
			return parameters ? { name, parameters } : { name };
		});
		await writeFile(join(directory, `${TOOL_BRIDGE_CLIENT_MODULE}.py`), renderToolBridgeClient(clientTools), {
			encoding: "utf8",
			mode: 0o600,
		});
		const opened = await openToolBridgeListener({ directory, handle });
		listener = opened;
		const secretFile = join(directory, SECRET_FILE_NAME);
		await writeFile(secretFile, opened.token, { encoding: "utf8", mode: 0o600 });
		return {
			environment: { [TOOL_BRIDGE_ADDRESS_ENV]: opened.address, [TOOL_BRIDGE_TOKEN_FILE_ENV]: secretFile },
			clientDirectory: directory,
			close: async () => {
				runAbort.abort(new Error("the script run ended"));
				options.signal?.removeEventListener("abort", stopWithParent);
				await opened.close();
				await Promise.allSettled([...inflight]);
				await removeRunDirectory(directory);
				const report: ToolBridgeReport = {
					tools: [...options.tools],
					calls,
					byTool,
					outcomes,
					authFailures: opened.authFailures,
					ms: Date.now() - startedAt,
					trace,
				};
				harnessLog.debug("tools", "a script's tool calls settled", () => ({
					calls,
					byTool,
					...outcomes,
					authFailures: opened.authFailures,
					ms: report.ms,
				}));
				if (opened.authFailures > 0) {
					harnessLog.warn("tools", "a connection to a script's tool channel did not prove the run's secret", {
						connections: opened.authFailures,
					});
				}
				return report;
			},
		};
	} catch (error) {
		options.signal?.removeEventListener("abort", stopWithParent);
		await listener?.close();
		await removeRunDirectory(directory);
		throw error;
	}
}

function countList(counts: Readonly<Record<string, number>>): string {
	return Object.entries(counts)
		.filter(([, count]) => count > 0)
		.map(([name, count]) => `${count} ${name}`)
		.join(", ");
}

/** Plain words for the result row: `14 tool calls, 1 refused`. */
export function summarizeToolBridgeReport(report: ToolBridgeReport): string {
	const { ok: _ok, ...failures } = report.outcomes;
	const failed = countList(failures);
	return `${report.calls} tool call${report.calls === 1 ? "" : "s"}${failed ? `, ${failed}` : ""}`;
}

/**
 * The run's trace for the model: counts per tool and per outcome, then one line per call (tool, outcome, ms and a
 * short reason when it did not succeed). A tool's own output is never repeated here; the script prints what it needs.
 */
export function formatToolBridgeReport(report: ToolBridgeReport): string {
	if (report.calls === 0) return `[${TOOL_BRIDGE_CLIENT_MODULE}: no tool calls; ${report.ms} ms]`;
	const auth = report.authFailures > 0 ? `; ${report.authFailures} connection(s) refused for a wrong secret` : "";
	const lines = [
		`[${TOOL_BRIDGE_CLIENT_MODULE}: ${report.calls} call${report.calls === 1 ? "" : "s"} (${countList(report.byTool)}): ${countList(report.outcomes)}; ${report.ms} ms${auth}]`,
		...report.trace.map(
			(entry) =>
				`#${entry.n} ${entry.tool} ${entry.outcome} ${entry.ms} ms${entry.reason ? `: ${entry.reason}` : ""}`,
		),
	];
	if (report.calls > report.trace.length) lines.push(`[${report.calls - report.trace.length} more calls not listed]`);
	return lines.join("\n");
}
