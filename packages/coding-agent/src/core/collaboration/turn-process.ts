import { killTree } from "@caupulican/pi-agent-core/process-tree";
import { spawnProcess } from "../../utils/child-process.ts";
import { getSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import { resolveCollaborationBackend } from "./backend-resolver.ts";
import { type CollaborationAnswer, stopCollaborationAgent } from "./coordinator.ts";
import type { CollaborationAgent, CollaborationJob, CollaborationJobStore } from "./job-store.ts";

/** Detached finite control helper; native model CLIs remain interactive in the backend's PTYs. */
export async function launchCollaborationTurnProcess(
	store: CollaborationJobStore,
	job: CollaborationJob,
	agent: CollaborationAgent,
	answer?: CollaborationAnswer,
): Promise<void> {
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
			child.off("message", onMessage);
			reject(error);
		};
		const settleStartupTimeout = async (): Promise<void> => {
			if (settled) return;
			// Timeout wins admission synchronously. A late ready message must stay fenced while the
			// bounded process-tree owner reaches its own terminal.
			settled = true;
			clearTimeout(timer);
			child.off("message", onMessage);
			try {
				const outcome = await killTree(child);
				reject(
					new Error(
						outcome === "failed"
							? "Collaboration controller startup timed out. Helper process-tree termination is unproven."
							: "Collaboration controller startup timed out.",
					),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				reject(
					new Error(
						`Collaboration controller startup timed out. Helper process-tree termination failed (${message}); termination is unproven.`,
					),
				);
			}
		};
		const timer = setTimeout(() => {
			void settleStartupTimeout();
		}, 30000);
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
			child.off("message", onMessage);
			child.unref();
			const channel = child.channel;
			if (channel && typeof channel.unref === "function") channel.unref();
			resolve();
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
					"Collaboration controller exited; delivery will not be replayed.",
				);
			})().catch(() => {
				/* An exact-turn watchdog still owns uncertain live work. */
			});
			if (!admitted) fail(new Error("Collaboration controller exited before admission."));
		});
	});
}
