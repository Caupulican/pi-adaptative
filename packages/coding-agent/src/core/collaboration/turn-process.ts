import { killTree } from "@caupulican/pi-agent-core/process-tree";
import { spawnProcess } from "../../utils/child-process.ts";
import { getSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import { type CollaborationAnswer, stopCollaborationAgent } from "./coordinator.ts";
import { createHerdrBackend } from "./herdr-runtime.ts";
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
		const timer = setTimeout(() => {
			fail(new Error("Collaboration controller startup timed out."));
			void killTree(child).catch(() => {
				/* Exact-turn cleanup remains with the coordinator watchdog. */
			});
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
			child.channel?.unref();
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
					(session) => createHerdrBackend({ session, ensureRunning: false }),
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
