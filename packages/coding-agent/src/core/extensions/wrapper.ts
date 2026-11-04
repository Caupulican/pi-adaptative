/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers adapt tool execution so extension tools receive the runner context
 * and reuse the session identity they declare (`sessionIdentity`) from prior successful results of the same extension.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool, ExecutionContext } from "../../kernel/index.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { applyExtensionSessionHeal, extensionSessionScopeFor } from "./extension-session-scope.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createToolContext(): the full context for every tool except one granted to a worker
 * process from a tool-only extension, which gets the restricted context.
 */
export function wrapRegisteredTool(
	registeredTool: RegisteredTool,
	runner: ExtensionRunner,
	getExecutionContext?: () => ExecutionContext | undefined,
): AgentTool {
	// One scope per registering extension: its entry path. A directory shared by several extensions (the bundled
	// ones) is not an owner, and an SDK tool is its own owner.
	const definition = applyExtensionSessionHeal(
		registeredTool.definition,
		registeredTool.sourceInfo.path,
		extensionSessionScopeFor(runner),
	);
	return wrapToolDefinition(definition, () => runner.createToolContext(registeredTool, getExecutionContext?.()));
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(
	registeredTools: RegisteredTool[],
	runner: ExtensionRunner,
	getExecutionContext?: () => ExecutionContext | undefined,
): AgentTool[] {
	return registeredTools.map((registeredTool) => wrapRegisteredTool(registeredTool, runner, getExecutionContext));
}
