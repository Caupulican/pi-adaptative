import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ENV_AGENT_DIR } from "../../config.ts";
import { getStableSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import { herdrCommand } from "./herdr-command.ts";
import type { NewCollaborationJob } from "./job-record.ts";
import type { CollaborationPeerCredential } from "./peer-credential-store.ts";
import { collaborationPeerTokenHash } from "./peer-protocol.ts";
import { collaborationAgentDirOverride, collaborationStateDirectory } from "./state-directory.ts";

/** In-process Pi members read the identifiers of their address from the environment their pane starts with. */
const PI_MEMBER_ADDRESS_KEYS = 3;

export function bootstrapCollaborationPeers(
	input: NewCollaborationJob,
	directory: string,
): {
	job: NewCollaborationJob;
	environments: Record<string, string>[];
	credentials: CollaborationPeerCredential[];
} {
	const target = getStableSelfLaunchTarget();
	if (!target) throw new Error("This host cannot provide a portable collaboration peer command.");
	// Members and the peer CLI resolve the state root from the agent directory they are given, so only that root authenticates.
	if (resolve(directory) !== resolve(collaborationStateDirectory()))
		throw new Error("Collaboration state directory is not the managed root; peer credentials cannot be resolved.");
	// An overridden agent directory is carried explicitly: a shell that does not inherit the variable still resolves it.
	const agentDirectory = collaborationAgentDirOverride();
	const environments: Record<string, string>[] = [];
	const credentials: CollaborationPeerCredential[] = [];
	const agents = input.agents.map((agent) => {
		if (Object.keys(agent.env).some((key) => key.startsWith("PI_COLLABORATION_")))
			throw new Error("Collaboration peer environment keys are reserved for the coordinator.");
		const pi = agent.provider === "pi";
		const piKeys = pi ? PI_MEMBER_ADDRESS_KEYS + (agentDirectory ? 1 : 0) : 0;
		if (Object.keys(agent.env).length + piKeys > 64)
			throw new Error("Collaboration environment exceeds 64 entries after peer bootstrap.");
		const token = randomBytes(32).toString("hex");
		environments.push({
			...agent.env,
			...(pi
				? {
						PI_COLLABORATION_PARENT_ID: input.parentSessionId,
						PI_COLLABORATION_JOB_ID: input.id,
						PI_COLLABORATION_AGENT_ID: agent.id,
						...(agentDirectory ? { [ENV_AGENT_DIR]: agentDirectory } : {}),
					}
				: {}),
		});
		credentials.push({ agentId: agent.id, token });
		return { ...agent, peerTokenHash: collaborationPeerTokenHash(token) };
	});
	return {
		job: {
			...input,
			agents,
			// The job's address prefix; each member appends its own identifier. Identifiers and, only when overridden, the agent directory; never a credential.
			peerCommand: herdrCommand(
				target.executable,
				[
					...target.argsPrefix,
					"--collaboration-peer",
					...(agentDirectory ? ["--agent-dir", agentDirectory] : []),
					input.parentSessionId,
					input.id,
				],
				process.platform,
				target.environment,
			),
		},
		environments,
		credentials,
	};
}
