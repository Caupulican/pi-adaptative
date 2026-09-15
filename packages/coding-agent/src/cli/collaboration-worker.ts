import { watch } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getAgentDir } from "../config.ts";
import type { CollaborationBackend } from "../core/collaboration/backend.ts";
import { resolveCollaborationBackend } from "../core/collaboration/backend-resolver.ts";
import { stopCollaborationAgent } from "../core/collaboration/coordinator.ts";
import { CollaborationJobStore } from "../core/collaboration/job-store.ts";
import { executeCollaborationTurn } from "../core/collaboration/turn-runner.ts";
import { canonicalizeWatchDir } from "../utils/fs-watch.ts";
import { acquireWorkRun } from "../utils/work-directory.ts";

const answerSchema = Type.Union([
	Type.Null(),
	Type.Object({
		text: Type.Optional(Type.String({ maxLength: 4096 })),
		keys: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
	}),
]);

/**
 * Notify the parent over IPC. Best effort by contract: once `claimTurn` has durably admitted this
 * turn, the parent's ability to hear about it can never abort the work or skip cleanup.
 *
 * Three failure modes are all contained here, because each of them otherwise escapes into a place
 * with no handler: `process.send` can throw synchronously (closed channel, unserializable payload);
 * it reports an asynchronous delivery failure through its completion callback, which Node would
 * otherwise raise as a `process` 'error' event with no listener; and `onDelivered` itself can throw
 * from inside that callback, where no try/finally is left to catch it.
 */
function notifyParent(message: { type: string; turnId: string }, onDelivered?: () => void): void {
	try {
		process.send?.(message, (error: Error | null) => {
			try {
				// A failed send means the channel is gone; there is nothing left to disconnect.
				if (!error) onDelivered?.();
			} catch {
				// Best effort: a notification callback must never throw into the process emitter.
			}
		});
	} catch {
		// Best effort: an admitted turn is never abandoned because its parent could not be told.
	}
}

/** Internal CLI mode, never a model headless run. Its only model input is an already-admitted turn. */
export async function runCollaborationWorker(args: readonly string[]): Promise<void> {
	if (args.length !== 6 || args.some((arg) => arg.length > 8192 || arg.includes("\0")))
		throw new Error("Invalid collaboration controller arguments.");
	const [directory, parent, jobId, agentId, turnId, encodedAnswer] = args;
	if (!isAbsolute(directory)) throw new Error("Collaboration state directory must be absolute.");
	const answer: unknown = JSON.parse(encodedAnswer);
	if (!Value.Check(answerSchema, answer)) throw new Error("Invalid collaboration answer.");
	const lease = acquireWorkRun({
		agentDir: getAgentDir(),
		category: "background",
		tenant: "pi-collaboration",
		runId: "state",
	});
	if (resolve(directory) !== join(lease.path, "jobs")) {
		lease.release();
		throw new Error("Collaboration state directory does not match this host's managed work root.");
	}
	const cancellation = new AbortController();
	const stop = () => cancellation.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	let store: CollaborationJobStore | undefined;
	let claimed = false;
	let backend: CollaborationBackend | undefined;
	try {
		store = new CollaborationJobStore(directory, parent);
		claimed = store.claimTurn(jobId, agentId, turnId, process.pid);
		if (!claimed) throw new Error("Collaboration turn already claimed or superseded; no prompt was sent.");
		notifyParent({ type: "ready", turnId });
		const job = store.load(jobId);
		const agent = job.agents.find((item) => item.id === agentId)!;
		if (!agent.backendName || !agent.terminalId || !job.peerCommand)
			throw new Error("Collaboration agent identity is incomplete.");
		const timeoutMs = Math.max(1, Math.min(job.deadlineSeconds * 1000, (agent.deadlineAt ?? 0) - Date.now()));
		backend = await resolveCollaborationBackend(job, { ensureRunning: false });
		const subscribeReport = (listener: () => void) => {
			// Every other directory watch in this package canonicalizes first; libuv hard-aborts the
			// process on Windows when a watched directory is reached through a non-canonical alias.
			const watcher = watch(canonicalizeWatchDir(directory), { persistent: false }, (_event, file) => {
				if (file === null || file.toString().endsWith(".json")) listener();
			});
			watcher.on("error", (err) => {
				cancellation.abort(
					new Error(`Filesystem watcher failed: ${err instanceof Error ? err.message : String(err)}`),
				);
				listener();
			});
			return () => {
				try {
					watcher.close();
				} catch {}
			};
		};
		const result = await executeCollaborationTurn(
			backend,
			{
				target: agent.backendName,
				terminalId: agent.terminalId,
				turnId: agent.turnId,
				reportCommand: job.peerCommand,
				text: agent.prompt,
				timeoutMs,
			},
			cancellation.signal,
			answer ?? undefined,
			() =>
				store!.load(jobId).agents.find((member) => member.id === agentId && member.turnId === turnId)?.resultClaim,
			() =>
				store!.load(jobId).agents.find((member) => member.id === agentId && member.turnId === turnId)
					?.pendingQuestion,
			subscribeReport,
			() => {
				const current = store!.load(jobId).agents.find((member) => member.id === agentId);
				return current?.turnId === turnId && current?.status === "running" && !current?.steering;
			},
		);
		store.finishTurn(jobId, agentId, turnId, result.status, result.evidence, result.usage);
	} catch (error) {
		if (claimed && store) {
			const current = store.load(jobId).agents.find((member) => member.id === agentId);
			const isSuperseded = current?.turnId !== turnId || current?.status !== "running" || Boolean(current?.steering);
			if (!isSuperseded) {
				try {
					await stopCollaborationAgent(
						store,
						(j) =>
							backend ? Promise.resolve(backend) : resolveCollaborationBackend(j, { ensureRunning: false }),
						jobId,
						agentId,
						turnId,
						cancellation.signal.aborted ? undefined : String(error).slice(0, 2000),
					);
				} catch {
					/* The parent's exact-turn watchdog retains control; no false stopped-work claim. */
				}
			}
		}
		process.exitCode = 1;
	} finally {
		notifyParent({ type: "terminal", turnId }, () => process.disconnect?.());
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		lease.release();
	}
}
