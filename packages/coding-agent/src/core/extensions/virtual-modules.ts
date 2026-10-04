export const PI_AGENT_CORE_EXTENSION_SUBPATHS = {
	agent: "coding-agent/src/kernel/agent.ts",
	"agent-loop": "coding-agent/src/kernel/agent-loop.ts",
	"verification-obligations": "coding-agent/src/kernel/verification-obligations.ts",
	compaction: "coding-agent/src/kernel/compaction/index.ts",
	"compaction/branch-summarization": "coding-agent/src/kernel/compaction/branch-summarization.ts",
	"compaction/compaction": "coding-agent/src/kernel/compaction/compaction.ts",
	"compaction/loop": "coding-agent/src/kernel/compaction/loop.ts",
	"compaction/token-budget": "coding-agent/src/kernel/compaction/token-budget.ts",
	"message-retention": "coding-agent/src/kernel/session/message-retention.ts",
	messages: "coding-agent/src/kernel/messages.ts",
	node: "coding-agent/src/kernel/node.ts",
	paths: "coding-agent/src/kernel/utils/paths.ts",
	"process-tree": "coding-agent/src/kernel/reliability/process-tree.ts",
	"provider-request-estimator": "coding-agent/src/kernel/provider-request-estimator.ts",
	"provider-request-image-budget": "coding-agent/src/kernel/provider-request-image-budget.ts",
	"provider-request-planner": "coding-agent/src/kernel/provider-request-planner.ts",
	"provider-tool-projection": "coding-agent/src/kernel/provider-tool-projection.ts",
	reliability: "coding-agent/src/kernel/reliability/index.ts",
	session: "coding-agent/src/kernel/session/session-manager.ts",
	"shell-output": "coding-agent/src/kernel/utils/shell-output.ts",
	"tool-failure-memory": "coding-agent/src/kernel/tool-failure-memory.ts",
	"tool-protocol-residue": "coding-agent/src/kernel/tool-protocol-residue.ts",
	truncate: "coding-agent/src/kernel/utils/truncate.ts",
	types: "coding-agent/src/kernel/types.ts",
	usage: "coding-agent/src/kernel/usage.ts",
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
 * `host-extension-modules.ts`, which the process entries import.
 */
let hostExtensionModules: Readonly<Record<string, unknown>> | undefined;

export function registerHostExtensionModules(modules: Record<string, unknown>): void {
	if (hostExtensionModules) throw new Error("Host extension modules are already registered");
	hostExtensionModules = Object.freeze({ ...modules });
}

/**
 * The registered host modules, or undefined in a process whose entry did not register them (a focused
 * test of the loader, or a program embedding the SDK without the CLI entry): extensions then resolve
 * packages from disk. Both CLI entries register them before the session program loads.
 */
export function getHostExtensionModules(): Readonly<Record<string, unknown>> | undefined {
	return hostExtensionModules;
}
