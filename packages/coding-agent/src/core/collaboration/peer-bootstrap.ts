import { createHash, randomBytes } from "node:crypto";
import { getStableSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import { herdrCommand } from "./herdr-command.ts";
import type { NewCollaborationJob } from "./job-store.ts";

export function bootstrapCollaborationPeers(
	input: NewCollaborationJob,
	directory: string,
): {
	job: NewCollaborationJob;
	environments: Record<string, string>[];
} {
	const target = getStableSelfLaunchTarget();
	if (!target) throw new Error("This host cannot provide a portable collaboration peer command.");
	const environments: Record<string, string>[] = [];
	const agents = input.agents.map((agent) => {
		if (Object.keys(agent.env).some((key) => key.startsWith("PI_COLLABORATION_")))
			throw new Error("Collaboration peer environment keys are reserved for the coordinator.");
		if (Object.keys(agent.env).length > 59)
			throw new Error("Collaboration environment exceeds 64 entries after peer bootstrap.");
		const token = randomBytes(32).toString("hex");
		environments.push({
			...agent.env,
			PI_COLLABORATION_STATE_DIR: directory,
			PI_COLLABORATION_PARENT_ID: input.parentSessionId,
			PI_COLLABORATION_JOB_ID: input.id,
			PI_COLLABORATION_AGENT_ID: agent.id,
			PI_COLLABORATION_PEER_TOKEN: token,
		});
		return { ...agent, peerTokenHash: createHash("sha256").update(token).digest("hex") };
	});
	return {
		job: {
			...input,
			agents,
			peerCommand: herdrCommand(
				target.executable,
				[...target.argsPrefix, "--collaboration-peer"],
				process.platform,
				target.environment,
			),
		},
		environments,
	};
}
