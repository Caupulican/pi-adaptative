import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../utils/json-types.ts";
import { isPlainRecord } from "../utils/value-guards.ts";

/** Shared bound for durable orchestration identity fields. */
export const MAX_ORCHESTRATION_IDENTIFIER_LENGTH = 512;

export interface AgentResumeContext {
	provider: "pi" | "external";
	sessionId: string;
	sessionDir?: string;
	sessionFile?: string;
	cwd: string;
	worktreeLaneKey?: string;
	orchestrationProfileId?: string;
	resourceProfileNames: readonly string[];
	modelRef?: string;
	contextPointers: readonly ResourcePointer[];
	latestCheckpointId?: string;
}

/** Provider-neutral logical identity shared by durable orchestration and process supervision. */
export interface AgentIdentityContract {
	agentId: string;
	resumeContext: AgentResumeContext;
}

export const RESOURCE_POINTER_KINDS = [
	"repository",
	"worktree",
	"artifact",
	"evidence",
	"memory-query",
	"skill",
	"prompt",
	"service",
] as const;
export type ResourcePointerKind = (typeof RESOURCE_POINTER_KINDS)[number];

export function isResourcePointerKind(value: unknown): value is ResourcePointerKind {
	return RESOURCE_POINTER_KINDS.some((kind) => kind === value);
}

export interface ResourcePointer {
	id: string;
	kind: ResourcePointerKind;
	uri: string;
	readOnly: boolean;
	digest?: string;
	metadata?: JsonObject;
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

/** Compare only the immutable identity behind a resumable agent; checkpoint position is mutable. */
export function sameAgentResumeIdentity(left: AgentResumeContext, right: AgentResumeContext): boolean {
	const { latestCheckpointId: _leftCheckpoint, ...leftIdentity } = left;
	const { latestCheckpointId: _rightCheckpoint, ...rightIdentity } = right;
	return isDeepStrictEqual(leftIdentity, rightIdentity);
}

export function cloneResumeContext(context: AgentResumeContext): AgentResumeContext {
	return structuredClone(context);
}
