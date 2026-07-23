import type { Tool } from "../types.ts";

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOL_NAME_LENGTH = 64;

export interface ToolNameMap {
	toProviderName(name: string): string;
	toOriginalName(name: string): string;
}

export interface ToolNameMapOptions {
	reservedNames?: ReadonlySet<string>;
	reservedSuffix?: string;
	normalizeName?: (sanitizedName: string) => string;
}

function baseSanitizedToolName(name: string): string {
	const sanitized = name
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, MAX_TOOL_NAME_LENGTH);
	return sanitized.length > 0 ? sanitized : "tool";
}

function uniqueToolName(base: string, usedNames: Set<string>, reservedNames?: ReadonlySet<string>): string {
	if (!usedNames.has(base) && !reservedNames?.has(base)) {
		usedNames.add(base);
		return base;
	}

	let index = 2;
	while (true) {
		const suffix = `_${index}`;
		const prefix = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length);
		const candidate = `${prefix}${suffix}`;
		if (!usedNames.has(candidate) && !reservedNames?.has(candidate)) {
			usedNames.add(candidate);
			return candidate;
		}
		index++;
	}
}

export function createToolNameMap(tools: readonly Tool[], options?: ToolNameMapOptions): ToolNameMap {
	const originalToProvider = new Map<string, string>();
	const providerToOriginal = new Map<string, string>();
	const usedProviderNames = new Set<string>();

	const allocate = (originalName: string): string => {
		const existing = originalToProvider.get(originalName);
		if (existing) return existing;
		const sanitizedBase = VALID_TOOL_NAME.test(originalName) ? originalName : baseSanitizedToolName(originalName);
		const normalizedBase = baseSanitizedToolName(options?.normalizeName?.(sanitizedBase) ?? sanitizedBase);
		const base = options?.reservedNames?.has(normalizedBase)
			? baseSanitizedToolName(`${normalizedBase}${options.reservedSuffix ?? "_tool"}`)
			: normalizedBase;
		const providerName = uniqueToolName(base, usedProviderNames, options?.reservedNames);
		originalToProvider.set(originalName, providerName);
		providerToOriginal.set(providerName, originalName);
		return providerName;
	};

	for (const tool of tools) {
		if (originalToProvider.has(tool.name)) throw new TypeError(`Duplicate tool name '${tool.name}'.`);
		allocate(tool.name);
	}

	return {
		toProviderName(name: string): string {
			return allocate(name);
		},
		toOriginalName(name: string): string {
			return providerToOriginal.get(name) ?? name;
		},
	};
}
