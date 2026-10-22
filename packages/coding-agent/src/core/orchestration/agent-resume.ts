import { createAgentIdentity } from "../../kernel/session/agent-identity.ts";

export { createAgentIdentity, isAgentIdentity, sameAgentResumeIdentity } from "../../kernel/session/agent-identity.ts";

import { PI_ORCHESTRATION_AGENT_ID_ENV } from "../process-identity.ts";
import { WORKER_PROCESS_ALLOWED_TOOLS } from "../worker-tool-ceiling.ts";
import type { AgentIdentityContract } from "./contracts.ts";

export interface PiResumeLaunchSpec {
	executable: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string>>;
}

export interface BuildPiResumeLaunchSpecOptions {
	executable?: string;
	argsPrefix?: readonly string[];
	parentPid: number;
	parentSessionId: string;
	taskRef?: string;
	wakePrompt?: string;
}

/**
 * Build an argv-safe launch specification for the exact persisted Pi session behind a logical
 * agent. The caller passes argv directly to spawn; no shell quoting or command string is involved.
 */
export function buildPiResumeLaunchSpec(
	agent: AgentIdentityContract,
	options: BuildPiResumeLaunchSpecOptions,
): PiResumeLaunchSpec {
	const identity = createAgentIdentity(agent.agentId, agent.resumeContext);
	const context = identity.resumeContext;
	if (context.provider !== "pi") throw new TypeError(`Agent '${identity.agentId}' is not backed by a Pi session.`);
	if (!Number.isSafeInteger(options.parentPid) || options.parentPid <= 0) {
		throw new TypeError("A positive parent pid is required to resume a Pi agent.");
	}
	if (!options.parentSessionId.trim()) throw new TypeError("A parent session id is required to resume a Pi agent.");
	const args: string[] = [...(options.argsPrefix ?? [])];
	if (context.sessionDir) args.push("--session-dir", context.sessionDir);
	args.push("--session", context.sessionFile ?? context.sessionId);
	args.push("--parent-pid", String(options.parentPid));
	args.push("--parent-session", options.parentSessionId);
	if (options.taskRef?.trim()) args.push("--task-ref", options.taskRef.trim());
	if (context.worktreeLaneKey) args.push("--worktree-lane", context.worktreeLaneKey);
	if (context.orchestrationProfileId) {
		args.push("--orchestration-profile", context.orchestrationProfileId);
	} else {
		// Without an orchestration profile the resumed child still gets the worker allow-list, never
		// whatever the registry happens to hold (extension tools included).
		args.push("--tools", [...WORKER_PROCESS_ALLOWED_TOOLS].join(","));
		if (context.resourceProfileNames.length > 0) {
			args.push("--resource-profile", context.resourceProfileNames.join(","));
		}
	}
	if (options.wakePrompt?.trim()) args.push("--print", options.wakePrompt.trim());
	return {
		executable: options.executable ?? "pi",
		args,
		cwd: context.cwd,
		env: { PI_SESSION_ROLE: "worker", [PI_ORCHESTRATION_AGENT_ID_ENV]: identity.agentId },
	};
}
