import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getAgentDir } from "../config.ts";
import type { CollaborationBackend } from "../core/collaboration/backend.ts";
import { stopCollaborationAgent } from "../core/collaboration/coordinator.ts";
import { createHerdrBackend } from "../core/collaboration/herdr-runtime.ts";
import { CollaborationJobStore } from "../core/collaboration/job-store.ts";
import { executeCollaborationTurn } from "../core/collaboration/turn-runner.ts";
import { acquireWorkRun } from "../utils/work-directory.ts";

const answerSchema = Type.Union([
	Type.Null(),
	Type.Object({
		text: Type.Optional(Type.String({ maxLength: 4096 })),
		keys: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
	}),
]);

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
		process.send?.({ type: "ready", turnId });
		const job = store.load(jobId);
		const agent = job.agents.find((item) => item.id === agentId)!;
		if (!agent.backendName || !agent.terminalId || !job.peerCommand)
			throw new Error("Collaboration agent identity is incomplete.");
		const timeoutMs = Math.max(1, Math.min(job.deadlineSeconds * 1000, (agent.deadlineAt ?? 0) - Date.now()));
		backend = await createHerdrBackend({ session: job.sessionName, ensureRunning: false });
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
		);
		store.finishTurn(jobId, agentId, turnId, result.status, result.evidence, result.usage);
	} catch (error) {
		if (claimed && store) {
			try {
				await stopCollaborationAgent(
					store,
					(session) =>
						backend ? Promise.resolve(backend) : createHerdrBackend({ session, ensureRunning: false }),
					jobId,
					agentId,
					turnId,
					cancellation.signal.aborted ? undefined : String(error).slice(0, 2000),
				);
			} catch {
				/* The parent's exact-turn watchdog retains control; no false stopped-work claim. */
			}
		}
		process.exitCode = 1;
	} finally {
		process.send?.({ type: "terminal", turnId }, () => process.disconnect?.());
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		lease.release();
	}
}
