import type { ChildProcess } from "node:child_process";
import { killTree } from "../../kernel/reliability/process-tree.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import { getSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import { resolveCollaborationBackend } from "./backend-resolver.ts";
import { type CollaborationAnswer, stopCollaborationAgent } from "./coordinator.ts";
import type { CollaborationAgent, CollaborationJob, CollaborationKnowledgeHandoff } from "./job-record.ts";
import type { CollaborationJobStore } from "./job-store.ts";
import { answerTurnKnowledge, type KnowledgeChannelPort, turnExpectsKnowledge } from "./knowledge-delivery.ts";

function childKnowledgeChannel(child: ChildProcess): KnowledgeChannelPort {
	return {
		send: (message, onSent) => {
			child.send(message, onSent);
		},
		onMessage: (listener) => {
			child.on("message", listener);
			return () => child.off("message", listener);
		},
		onClose: (listener) => {
			child.once("disconnect", listener);
			child.once("exit", listener);
			return () => {
				child.off("disconnect", listener);
				child.off("exit", listener);
			};
		},
	};
}

/** Ends a helper the launch gave up on through the bounded process-tree owner and names whether that is proven. */
async function abandonedHelperError(child: ChildProcess, summary: string): Promise<Error> {
	try {
		const outcome = await killTree(child);
		return new Error(outcome === "failed" ? `${summary} Helper process-tree termination is unproven.` : summary);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`${summary} Helper process-tree termination failed (${message}); termination is unproven.`);
	}
}

/**
 * Detached finite control helper; native model CLIs remain interactive in the backend's PTYs. `knowledge` is the
 * grant of the call that reserved this turn; its block reaches the helper over IPC only, never as an argument.
 * `signal` is that call's cancellation: before the helper is admitted, or while a granted turn's helper has not yet
 * been answered, it ends the helper and rejects, so the caller releases the turn as for any failed launch.
 */
export async function launchCollaborationTurnProcess(
	store: CollaborationJobStore,
	job: CollaborationJob,
	agent: CollaborationAgent,
	answer?: CollaborationAnswer,
	knowledge?: CollaborationKnowledgeHandoff,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const target = getSelfLaunchTarget();
	if (!target) throw new Error("This host cannot launch a persistent collaboration turn controller.");
	const child = spawnProcess(
		target.executable,
		[
			...target.argsPrefix,
			"--collaboration-worker",
			store.directory,
			store.parentSessionId,
			job.id,
			agent.id,
			agent.turnId,
			JSON.stringify(answer ?? null),
		],
		{
			cwd: job.cwd,
			env: process.env,
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		},
	);
	await new Promise<void>((resolve, reject) => {
		let admitted = false;
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onStartupAbort);
			child.off("message", onMessage);
			reject(error);
		};
		const abandonStartup = async (summary: string): Promise<void> => {
			if (settled) return;
			// Timeout or cancellation wins admission synchronously. A late ready message must stay fenced while the
			// bounded process-tree owner reaches its own terminal.
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onStartupAbort);
			child.off("message", onMessage);
			reject(await abandonedHelperError(child, summary));
		};
		const timer = setTimeout(() => {
			void abandonStartup("Collaboration controller startup timed out.");
		}, 30000);
		const onStartupAbort = () => {
			void abandonStartup("Collaboration controller startup was cancelled.");
		};
		signal?.addEventListener("abort", onStartupAbort, { once: true });
		child.once("error", fail);
		const onMessage = (value: unknown) => {
			if (settled) return;
			if (
				!value ||
				typeof value !== "object" ||
				!("turnId" in value) ||
				value.turnId !== agent.turnId ||
				!("type" in value)
			)
				return;
			if (value.type !== "ready") return;
			settled = true;
			admitted = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onStartupAbort);
			child.off("message", onMessage);
			void (async () => {
				// A granted task's helper asks for its block right before it prompts; the launch (and so the tool call
				// that reports withdrawals) waits for that answer, the helper's end, the turn deadline or the call's
				// cancellation.
				if (turnExpectsKnowledge(agent, answer !== undefined)) {
					const deadline = AbortSignal.timeout(Math.max(1, (agent.deadlineAt ?? Date.now()) - Date.now()));
					const outcome = await answerTurnKnowledge(
						childKnowledgeChannel(child),
						agent.turnId,
						() => knowledge?.deliver(agent.id),
						signal ? AbortSignal.any([deadline, signal]) : deadline,
					);
					// Cancelled before the helper's request was answered, so before it could prompt with the block: end it
					// and fail the launch.
					if (outcome === "ended" && signal?.aborted) {
						reject(
							await abandonedHelperError(child, "Collaboration turn launch was cancelled before its prompt."),
						);
						return;
					}
					// Unanswered: close the channel so a still-waiting helper starts without knowledge.
					if (outcome === "ended" && child.connected) child.disconnect();
				}
				child.unref();
				const channel = child.channel;
				if (channel && typeof channel.unref === "function") channel.unref();
				resolve();
			})();
		};
		child.on("message", onMessage);
		child.once("exit", () => {
			clearTimeout(timer);
			// Exit is the terminal signal, not a stdout peek. Exact turn fencing makes late exits inert.
			void (async () => {
				const current = store.load(job.id).agents.find((item) => item.id === agent.id);
				if (!current || current.turnId !== agent.turnId || !["reserved", "running"].includes(current.status))
					return;
				await stopCollaborationAgent(
					store,
					(j) => resolveCollaborationBackend(j, { ensureRunning: false }),
					job.id,
					agent.id,
					agent.turnId,
					{
						kind: "failure",
						detail: "Turn helper exited before settling its turn; delivery will not be replayed.",
					},
				);
			})().catch(() => {
				/* An exact-turn watchdog still owns uncertain live work. */
			});
			if (!admitted) fail(new Error("Collaboration controller exited before admission."));
		});
	});
}
