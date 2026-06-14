import type { ResourceProfileKind, ResourceProfileSettings } from "./settings-manager.ts";

const RESOURCE_PROFILE_TAG_RE = /<resource-profile\b([^>]*)>([\s\S]*?)<\/resource-profile>/gi;
const RESOURCE_PROFILE_NAME_RE = /\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const RESOURCE_PROFILE_KINDS = new Set<ResourceProfileKind>([
	"extensions",
	"skills",
	"prompts",
	"themes",
	"agents",
	"tools",
]);

export interface ParseResourceProfileBlocksOptions {
	/** Parse only these tag names. When omitted or empty, parse every resource-profile tag. */
	profileNames?: string[];
}

export interface ParseResourceProfileBlocksResult {
	profiles: Record<string, ResourceProfileSettings>;
	errors: string[];
}

function mergeStringArrays(target: string[] | undefined, source: string[] | undefined): string[] | undefined {
	if (!source || source.length === 0) return target;
	return [...new Set([...(target ?? []), ...source])];
}

export function mergeResourceProfileSettings(
	base: ResourceProfileSettings | undefined,
	override: ResourceProfileSettings | undefined,
): ResourceProfileSettings {
	const result: ResourceProfileSettings = { ...(base ?? {}) };
	if (!override) return result;
	for (const kind of RESOURCE_PROFILE_KINDS) {
		const incoming = override[kind];
		if (!incoming) continue;
		const existing = result[kind] ?? {};
		result[kind] = {
			allow: mergeStringArrays(existing.allow, incoming.allow),
			block: mergeStringArrays(existing.block, incoming.block),
		};
	}
	return result;
}

export function mergeResourceProfileMap(
	base: Record<string, ResourceProfileSettings> = {},
	override: Record<string, ResourceProfileSettings> = {},
): Record<string, ResourceProfileSettings> {
	const result: Record<string, ResourceProfileSettings> = { ...base };
	for (const [name, profile] of Object.entries(override)) {
		result[name] = mergeResourceProfileSettings(result[name], profile);
	}
	return result;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return values.length > 0 ? values : undefined;
}

function normalizeResourceProfileSettings(value: unknown): ResourceProfileSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resource profile JSON must be an object");
	}
	const input = value as Record<string, unknown>;
	const result: ResourceProfileSettings = {};
	for (const [kind, filterValue] of Object.entries(input)) {
		if (!RESOURCE_PROFILE_KINDS.has(kind as ResourceProfileKind)) continue;
		if (!filterValue || typeof filterValue !== "object" || Array.isArray(filterValue)) continue;
		const filter = filterValue as Record<string, unknown>;
		result[kind as ResourceProfileKind] = {
			allow: asStringArray(filter.allow),
			block: asStringArray(filter.block),
		};
	}
	return result;
}

function extractProfileName(attrs: string): string | undefined {
	const match = attrs.match(RESOURCE_PROFILE_NAME_RE);
	return (match?.[1] ?? match?.[2])?.trim() || undefined;
}

export function parseResourceProfileBlocks(
	content: string,
	options: ParseResourceProfileBlocksOptions = {},
): ParseResourceProfileBlocksResult {
	const profiles: Record<string, ResourceProfileSettings> = {};
	const errors: string[] = [];
	const activeNames =
		options.profileNames && options.profileNames.length > 0 ? new Set(options.profileNames) : undefined;

	RESOURCE_PROFILE_TAG_RE.lastIndex = 0;
	for (const match of content.matchAll(RESOURCE_PROFILE_TAG_RE)) {
		const name = extractProfileName(match[1] ?? "");
		if (!name) {
			errors.push("resource-profile block is missing a name attribute");
			continue;
		}
		if (activeNames && !activeNames.has(name)) {
			continue;
		}
		try {
			const parsed = JSON.parse((match[2] ?? "").trim());
			profiles[name] = mergeResourceProfileSettings(profiles[name], normalizeResourceProfileSettings(parsed));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`resource-profile ${name}: ${message}`);
		}
	}

	return { profiles, errors };
}

export function parseResourceProfileJson(json: string): ParseResourceProfileBlocksResult {
	try {
		const parsed = JSON.parse(json);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("resource profile JSON must be an object");
		}
		const input = parsed as Record<string, unknown>;
		const profiles: Record<string, ResourceProfileSettings> = {};
		for (const [name, value] of Object.entries(input)) {
			profiles[name] = normalizeResourceProfileSettings(value);
		}
		return { profiles, errors: [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { profiles: {}, errors: [message] };
	}
}

export function parseResourceProfileInput(input: string): ParseResourceProfileBlocksResult {
	if (/<resource-profile\b/i.test(input)) {
		return parseResourceProfileBlocks(input);
	}
	return parseResourceProfileJson(input);
}

export function stripResourceProfileBlocks(content: string): string {
	return content.replace(RESOURCE_PROFILE_TAG_RE, "").trim();
}
