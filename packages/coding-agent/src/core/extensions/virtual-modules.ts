export const PI_AGENT_CORE_EXTENSION_SUBPATHS = {
	agent: "agent/src/agent.ts",
	"agent-loop": "agent/src/agent-loop.ts",
	"verification-obligations": "agent/src/verification-obligations.ts",
	compaction: "agent/src/compaction/index.ts",
	"compaction/branch-summarization": "agent/src/compaction/branch-summarization.ts",
	"compaction/compaction": "agent/src/compaction/compaction.ts",
	"compaction/loop": "agent/src/compaction/loop.ts",
	"compaction/token-budget": "agent/src/compaction/token-budget.ts",
	"message-retention": "agent/src/session/message-retention.ts",
	messages: "agent/src/messages.ts",
	node: "agent/src/node.ts",
	paths: "agent/src/utils/paths.ts",
	"process-tree": "agent/src/reliability/process-tree.ts",
	"provider-request-estimator": "agent/src/provider-request-estimator.ts",
	"provider-request-image-budget": "agent/src/provider-request-image-budget.ts",
	"provider-request-planner": "agent/src/provider-request-planner.ts",
	"provider-tool-projection": "agent/src/provider-tool-projection.ts",
	reliability: "agent/src/reliability/index.ts",
	session: "agent/src/session/session-manager.ts",
	"shell-output": "agent/src/utils/shell-output.ts",
	"tool-failure-memory": "agent/src/tool-failure-memory.ts",
	"tool-protocol-residue": "agent/src/tool-protocol-residue.ts",
	truncate: "agent/src/utils/truncate.ts",
	types: "agent/src/types.ts",
	usage: "agent/src/usage.ts",
} as const;

export type PiAgentCoreExtensionSubpath = keyof typeof PI_AGENT_CORE_EXTENSION_SUBPATHS;

export const PI_AI_EXTENSION_SUBPATHS = {
	"api-registry": "ai/src/api-registry.ts",
	"abort-signals": "ai/src/utils/abort-signals.ts",
	"bedrock-provider": "ai/src/bedrock-provider.ts",
	"event-stream": "ai/src/utils/event-stream.ts",
	"env-api-keys": "ai/src/env-api-keys.ts",
	faux: "ai/src/providers/faux.ts",
	"json-parse": "ai/src/utils/json-parse.ts",
	models: "ai/src/models.ts",
	oauth: "ai/src/oauth.ts",
	overflow: "ai/src/utils/overflow.ts",
	"provider-retry": "ai/src/utils/provider-retry.ts",
	"register-builtins": "ai/src/providers/register-builtins.ts",
	stream: "ai/src/stream.ts",
	"session-resources": "ai/src/session-resources.ts",
	"streaming-lines": "ai/src/utils/streaming-lines.ts",
	"text-tool-protocol": "ai/src/utils/tool-repair/text-protocol.ts",
	"tool-repair-registry": "ai/src/utils/tool-repair/registry.ts",
	"typebox-helpers": "ai/src/utils/typebox-helpers.ts",
	types: "ai/src/types.ts",
	usage: "ai/src/usage.ts",
	uuid: "ai/src/utils/uuid.ts",
	validation: "ai/src/utils/validation.ts",
	"validation-path": "ai/src/utils/validation-path.ts",
} as const;

export type PiAiExtensionSubpath = keyof typeof PI_AI_EXTENSION_SUBPATHS;

/**
 * The host program's own module instances, by the specifiers extensions import them under. Extensions
 * bind to these live modules instead of loading a private copy of the program: one instance of every
 * module-level singleton, and no re-evaluation of the host on each extension load. Registered once, by
 * `host-extension-modules.ts`, which the session builder imports.
 */
let hostExtensionModules: Readonly<Record<string, unknown>> | undefined;

export function registerHostExtensionModules(modules: Record<string, unknown>): void {
	if (hostExtensionModules) throw new Error("Host extension modules are already registered");
	hostExtensionModules = Object.freeze({ ...modules });
}

/**
 * The registered host modules, or undefined in a process that never built a session (a focused test
 * of the loader): there is no running program to share, and extensions resolve packages from disk.
 * Every session registers them first, through the session builder's static import.
 */
export function getHostExtensionModules(): Readonly<Record<string, unknown>> | undefined {
	return hostExtensionModules;
}
