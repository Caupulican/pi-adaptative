import type { Tool } from "../types.ts";

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOL_NAME_LENGTH = 64;

export interface ToolNameMap {
	toProviderName(name: string): string;
	toOriginalName(name: string): string;
}

function baseSanitizedToolName(name: string): string {
	const sanitized = name
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, MAX_TOOL_NAME_LENGTH);
	return sanitized.length > 0 ? sanitized : "tool";
}

function uniqueToolName(base: string, usedNames: Set<string>): string {
	if (!usedNames.has(base)) {
		usedNames.add(base);
		return base;
	}

	let index = 2;
	while (true) {
		const suffix = `_${index}`;
		const prefix = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length);
		const candidate = `${prefix}${suffix}`;
		if (!usedNames.has(candidate)) {
			usedNames.add(candidate);
			return candidate;
		}
		index++;
	}
}

export function createToolNameMap(tools: readonly Tool[]): ToolNameMap {
	const originalToProvider = new Map<string, string>();
	const providerToOriginal = new Map<string, string>();
	const usedProviderNames = new Set<string>();

	for (const tool of tools) {
		const base = VALID_TOOL_NAME.test(tool.name) ? tool.name : baseSanitizedToolName(tool.name);
		const providerName = uniqueToolName(base, usedProviderNames);
		originalToProvider.set(tool.name, providerName);
		providerToOriginal.set(providerName, tool.name);
	}

	return {
		toProviderName(name: string): string {
			return originalToProvider.get(name) ?? name;
		},
		toOriginalName(name: string): string {
			return providerToOriginal.get(name) ?? name;
		},
	};
}
