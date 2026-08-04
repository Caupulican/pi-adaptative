import { createEventBus } from "../event-bus.ts";
import { createExtensionRuntime, loadExtension } from "../extensions/loader.ts";
import {
	createExtensionifyToolDefinitionWithRuntime,
	type ExtensionifyRuntimeOptions,
} from "./extensionify-runtime.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export type { ExtensionifyInput, ExtensionifyReport, ExtensionifyToolDetails } from "./extensionify-runtime.ts";

export interface ExtensionifyToolOptions {
	agentDir?: string;
}

export function createDefaultExtensionifyRuntimeOptions(
	options: ExtensionifyToolOptions = {},
): ExtensionifyRuntimeOptions {
	return {
		...options,
		loadExtension: async ({ extensionPath, cwd: loadCwd, agentDir }) =>
			loadExtension(extensionPath, loadCwd, createEventBus(), createExtensionRuntime(), {
				fresh: true,
				agentDir,
			}),
	};
}

export function createExtensionifyToolDefinition(cwd: string, options: ExtensionifyToolOptions = {}) {
	return createExtensionifyToolDefinitionWithRuntime(cwd, createDefaultExtensionifyRuntimeOptions(options));
}

export function createExtensionifyTool(cwd: string, options?: ExtensionifyToolOptions) {
	return wrapToolDefinition(createExtensionifyToolDefinition(cwd, options));
}
