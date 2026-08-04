import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/factory-runtime.ts";
import type { Extension, ExtensionFactory, LoadExtensionsResult } from "../../src/core/extensions/types.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";

export interface CreateTestExtensionsResultInput {
	factory: ExtensionFactory;
	path?: string;
}

export async function createTestExtensionsResult(
	inputs: Array<ExtensionFactory | CreateTestExtensionsResultInput>,
	cwd = process.cwd(),
): Promise<LoadExtensionsResult> {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions: Extension[] = [];
	for (const [index, input] of inputs.entries()) {
		const factory = typeof input === "function" ? input : input.factory;
		const extensionPath =
			typeof input === "function" ? `<inline:${index + 1}>` : (input.path ?? `<inline:${index + 1}>`);
		extensions.push(await loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath));
	}
	return { extensions, errors: [], runtime };
}

export interface CreateTestResourceLoaderOptions {
	extensionsResult?: LoadExtensionsResult;
}

export function createTestResourceLoader(options: CreateTestResourceLoaderOptions = {}): ResourceLoader {
	const extensionsResult = options.extensionsResult ?? {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getActiveSkills() {
			return this.getSkills().skills;
		},
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getActivePrompts() {
			return this.getPrompts().prompts;
		},
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getActiveThemes() {
			return this.getThemes().themes;
		},
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getAgentsDiagnostics: () => [],
		getDiscoverableSkillPaths: () => [],
		getDiscoverablePromptPaths: () => [],
		getDiscoverableAgentsFilePaths: () => [],
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getLoadedExtension: () => undefined,
		removeLoadedExtension: () => undefined,
		loadSingleExtension: async () => ({ extension: null, error: "Not implemented in mock" }),
		extendResources: () => {},
		reload: async () => {},
		getDiscoverableExtensionPaths: async () => extensionsResult.extensions.map((extension) => extension.path),
	};
}
