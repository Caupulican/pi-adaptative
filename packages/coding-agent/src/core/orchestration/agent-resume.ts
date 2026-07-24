import { PI_ORCHESTRATION_AGENT_ID_ENV } from "../process-identity.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { type AgentIdentityContract, type AgentResumeContext, isResourcePointerKind } from "./contracts.ts";

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

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

export function isAgentIdentity(value: unknown): value is AgentIdentityContract {
	if (!isPlainRecord(value) || !isPlainRecord(value.resumeContext)) return false;
	const context = value.resumeContext;
	return (
		typeof value.agentId === "string" &&
		value.agentId.trim().length > 0 &&
		(context.provider === "pi" || context.provider === "external") &&
		typeof context.sessionId === "string" &&
		context.sessionId.trim().length > 0 &&
		typeof context.cwd === "string" &&
		context.cwd.trim().length > 0 &&
		isOptionalString(context.sessionDir) &&
		isOptionalString(context.sessionFile) &&
		isOptionalString(context.worktreeLaneKey) &&
		isOptionalString(context.orchestrationProfileId) &&
		isOptionalString(context.modelRef) &&
		isOptionalString(context.latestCheckpointId) &&
		Array.isArray(context.resourceProfileNames) &&
		context.resourceProfileNames.every((name) => typeof name === "string" && name.trim().length > 0) &&
		Array.isArray(context.contextPointers) &&
		context.contextPointers.every(
			(pointer) =>
				isPlainRecord(pointer) &&
				typeof pointer.id === "string" &&
				pointer.id.trim().length > 0 &&
				isResourcePointerKind(pointer.kind) &&
				typeof pointer.uri === "string" &&
				pointer.uri.trim().length > 0 &&
				typeof pointer.readOnly === "boolean" &&
				isOptionalString(pointer.digest) &&
				(pointer.metadata === undefined || isPlainRecord(pointer.metadata)),
		)
	);
}

/** Build and validate the one logical identity shared by orchestration and process supervision. */
export function createAgentIdentity(agentId: string, resumeContext: AgentResumeContext): AgentIdentityContract {
	const normalizedAgentId = agentId.trim();
	if (!normalizedAgentId) throw new TypeError("A logical agent id is required.");
	if (!resumeContext.sessionId.trim()) throw new TypeError("An agent session id is required.");
	if (!resumeContext.cwd.trim()) throw new TypeError("An agent working directory is required.");
	const identity = { agentId: normalizedAgentId, resumeContext: structuredClone(resumeContext) };
	if (!isAgentIdentity(identity)) throw new TypeError("Agent resume context is invalid.");
	return identity;
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
	} else if (context.resourceProfileNames.length > 0) {
		args.push("--resource-profile", context.resourceProfileNames.join(","));
	}
	if (options.wakePrompt?.trim()) args.push("--print", options.wakePrompt.trim());
	return {
		executable: options.executable ?? "pi",
		args,
		cwd: context.cwd,
		env: { PI_SESSION_ROLE: "worker", [PI_ORCHESTRATION_AGENT_ID_ENV]: identity.agentId },
	};
}
