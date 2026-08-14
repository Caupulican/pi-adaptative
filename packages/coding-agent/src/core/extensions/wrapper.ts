/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers adapt tool execution so extension tools receive the runner context
 * and reuse session-scoped identity from prior successful results of the same extension.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@caupulican/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import {
	applyExtensionSessionHeal,
	extensionScopeOwnerKey,
	extensionSessionScopeFor,
} from "./extension-session-scope.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const ownerKey = extensionScopeOwnerKey(registeredTool.sourceInfo);
	const definition =
		ownerKey === undefined
			? registeredTool.definition
			: applyExtensionSessionHeal(registeredTool.definition, ownerKey, extensionSessionScopeFor(runner));
	return wrapToolDefinition(definition, () => runner.createContext());
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((registeredTool) => wrapRegisteredTool(registeredTool, runner));
}
