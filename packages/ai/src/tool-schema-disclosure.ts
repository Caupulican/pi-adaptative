import type { Message, Tool } from "./types.ts";

export const TOOL_SCHEMA_SEARCH_NAME = "tool_search";
export const TOOL_SCHEMA_SEARCH_DETAILS_KIND = "deferred_tool_schema_search";
export const TOOL_SCHEMA_DISCLOSURE_BETA = "tool-search-tool-2025-10-19";

export const MIN_TOOL_SCHEMA_DISCLOSURE_SEARCHABLE_TOOLS = 10;
const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCHABLE_SCHEMA_CHARS = 32_768;
const EAGER_TOOL_PRIORITY = ["read", "bash", "edit", "write", "grep", "find", "delegate"] as const;

export interface ToolSchemaSearchDetails {
	kind: typeof TOOL_SCHEMA_SEARCH_DETAILS_KIND;
	query: string;
	maxResults: number;
}

export interface ToolSchemaDisclosurePlan {
	enabled: boolean;
	tools: readonly Tool[];
	eagerToolNames: ReadonlySet<string>;
	deferredToolNames: ReadonlySet<string>;
	metrics: ToolSchemaDisclosureMetrics;
}

export interface ToolSchemaDisclosureMetrics {
	totalToolCount: number;
	eagerToolCount: number;
	deferredToolCount: number;
	eagerSchemaCharacters: number;
	deferredSchemaCharacters: number;
	estimatedEagerSchemaTokens: number;
	estimatedDeferredSchemaTokens: number;
}

export interface ToolSchemaDisclosureRequestMetrics extends ToolSchemaDisclosureMetrics {
	searchCount: number;
	searchMissCount: number;
	referencedToolCount: number;
	searchResolutionMs: number | null;
}

interface ToolSchemaDisclosureModel {
	api: string;
	baseUrl: string;
	compat?: unknown;
	id: string;
	provider: string;
}

function isFirstPartyAnthropicHost(baseUrl: string): boolean {
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return hostname === "api.anthropic.com" || hostname.endsWith(".api.anthropic.com");
	} catch {
		return false;
	}
}

function supportsToolReferences(modelId: string): boolean {
	const match = /^claude-(opus|sonnet|haiku|fable|mythos)[-.]?(\d+)(?:[-.](\d+))?(?=$|[-.])/iu.exec(modelId);
	if (!match) return false;
	const family = match[1]?.toLowerCase();
	const major = Number.parseInt(match[2] ?? "0", 10);
	const minor = Number.parseInt(match[3] ?? "0", 10);
	if (major >= 5) return true;
	if (major !== 4) return false;
	if (family === "opus" || family === "sonnet") return true;
	return family === "haiku" && minor >= 5;
}

function disclosureMetrics(
	tools: readonly Tool[],
	eagerToolNames: ReadonlySet<string>,
	deferredToolNames: ReadonlySet<string>,
): ToolSchemaDisclosureMetrics {
	let eagerSchemaCharacters = 0;
	let deferredSchemaCharacters = 0;
	for (const tool of tools) {
		const characters = searchableText(tool).length;
		if (deferredToolNames.has(tool.name)) deferredSchemaCharacters += characters;
		else eagerSchemaCharacters += characters;
	}
	return {
		totalToolCount: tools.length,
		eagerToolCount: eagerToolNames.size,
		deferredToolCount: deferredToolNames.size,
		eagerSchemaCharacters,
		deferredSchemaCharacters,
		estimatedEagerSchemaTokens: Math.ceil(eagerSchemaCharacters / 4),
		estimatedDeferredSchemaTokens: Math.ceil(deferredSchemaCharacters / 4),
	};
}

/** Capability gate shared by activation and the Anthropic adapter. Unknown endpoints fail open. */
export function supportsToolSchemaDisclosure(model: ToolSchemaDisclosureModel): boolean {
	if (model.api !== "anthropic-messages") return false;
	const override = (model.compat as { supportsToolSearch?: boolean } | undefined)?.supportsToolSearch;
	if (override !== undefined) return override;
	return (
		model.provider === "anthropic" && isFirstPartyAnthropicHost(model.baseUrl) && supportsToolReferences(model.id)
	);
}

/** Stable eager/deferred split. The search tool plus four frequent tools remain resident. */
export function planToolSchemaDisclosure(
	model: ToolSchemaDisclosureModel,
	tools: readonly Tool[],
): ToolSchemaDisclosurePlan {
	const searchTool = tools.find((tool) => tool.name === TOOL_SCHEMA_SEARCH_NAME);
	const searchableTools = tools.filter((tool) => tool !== searchTool);
	if (
		!supportsToolSchemaDisclosure(model) ||
		!searchTool ||
		searchableTools.length < MIN_TOOL_SCHEMA_DISCLOSURE_SEARCHABLE_TOOLS
	) {
		const eagerToolNames = new Set(tools.map((tool) => tool.name));
		const deferredToolNames = new Set<string>();
		return {
			enabled: false,
			tools,
			eagerToolNames,
			deferredToolNames,
			metrics: disclosureMetrics(tools, eagerToolNames, deferredToolNames),
		};
	}

	const eagerToolNames = new Set<string>([TOOL_SCHEMA_SEARCH_NAME]);
	for (const name of EAGER_TOOL_PRIORITY) {
		if (eagerToolNames.size >= 5) break;
		if (searchableTools.some((tool) => tool.name === name)) eagerToolNames.add(name);
	}
	for (const tool of searchableTools) {
		if (eagerToolNames.size >= 5) break;
		eagerToolNames.add(tool.name);
	}
	const deferredToolNames = new Set(
		searchableTools.filter((tool) => !eagerToolNames.has(tool.name)).map((tool) => tool.name),
	);
	return {
		enabled: true,
		tools,
		eagerToolNames,
		deferredToolNames,
		metrics: disclosureMetrics(tools, eagerToolNames, deferredToolNames),
	};
}

export function isToolSchemaSearchDetails(value: unknown): value is ToolSchemaSearchDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const details = value as Record<string, unknown>;
	return (
		details.kind === TOOL_SCHEMA_SEARCH_DETAILS_KIND &&
		typeof details.query === "string" &&
		details.query.length >= 1 &&
		details.query.length <= 500 &&
		typeof details.maxResults === "number" &&
		Number.isSafeInteger(details.maxResults) &&
		details.maxResults >= 1 &&
		details.maxResults <= MAX_SEARCH_RESULTS
	);
}

function schemaSearchText(value: unknown, seen: Set<object>, parts: string[], chars: { value: number }): void {
	if (chars.value >= MAX_SEARCHABLE_SCHEMA_CHARS || value === null || value === undefined) return;
	if (typeof value === "string") {
		const remaining = MAX_SEARCHABLE_SCHEMA_CHARS - chars.value;
		const text = value.slice(0, remaining);
		parts.push(text);
		chars.value += text.length;
		return;
	}
	if (typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) schemaSearchText(entry, seen, parts, chars);
		return;
	}
	for (const [key, entry] of Object.entries(value)) {
		schemaSearchText(key, seen, parts, chars);
		schemaSearchText(entry, seen, parts, chars);
	}
}

const searchableTextByTool = new WeakMap<Tool, string>();

function searchableText(tool: Tool): string {
	const cached = searchableTextByTool.get(tool);
	if (cached !== undefined) return cached;
	const name = tool.name.slice(0, MAX_SEARCHABLE_SCHEMA_CHARS);
	const description = tool.description.slice(0, Math.max(0, MAX_SEARCHABLE_SCHEMA_CHARS - name.length));
	const schemaParts: string[] = [];
	schemaSearchText(tool.parameters, new Set(), schemaParts, { value: name.length + description.length });
	const text = `${name} ${description} ${schemaParts.join(" ")}`.slice(0, MAX_SEARCHABLE_SCHEMA_CHARS).toLowerCase();
	searchableTextByTool.set(tool, text);
	return text;
}

function queryTokens(query: string): string[] {
	return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter((token) => token.length > 1);
}

/** Deterministic bounded search over the exact deferred set in the accepted request. */
export function searchDeferredToolSchemas(plan: ToolSchemaDisclosurePlan, query: string, maxResults: number): Tool[] {
	if (!plan.enabled) return [];
	const deferred = plan.tools.filter((tool) => plan.deferredToolNames.has(tool.name));
	const limit = Number.isSafeInteger(maxResults)
		? Math.min(MAX_SEARCH_RESULTS, Math.max(1, maxResults))
		: MAX_SEARCH_RESULTS;
	const boundedQuery = query.slice(0, 500);
	const selection = /^select:(.+)$/iu.exec(boundedQuery.trim());
	if (selection) {
		const byName = new Map(deferred.map((tool) => [tool.name.toLowerCase(), tool]));
		const selected: Tool[] = [];
		for (const rawName of selection[1]?.split(",") ?? []) {
			const tool = byName.get(rawName.trim().toLowerCase());
			if (tool && !selected.includes(tool)) selected.push(tool);
			if (selected.length >= limit) break;
		}
		return selected;
	}

	const normalized = boundedQuery.trim().toLowerCase();
	const tokens = queryTokens(normalized);
	if (tokens.length === 0) return [];
	return deferred
		.map((tool) => {
			const name = tool.name.toLowerCase();
			const description = tool.description.toLowerCase();
			const haystack = searchableText(tool);
			let score = name === normalized ? 1_000 : name.includes(normalized) ? 200 : 0;
			for (const token of tokens) {
				if (name.includes(token)) score += 40;
				else if (description.includes(token)) score += 12;
				else if (haystack.includes(token)) score += 4;
			}
			return { tool, score };
		})
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, limit)
		.map((candidate) => candidate.tool);
}

/** Bounded request telemetry. Only trailing search results belong to this provider round trip. */
export function measureToolSchemaDisclosureRequest(
	plan: ToolSchemaDisclosurePlan,
	messages: readonly Message[],
	now = Date.now(),
): ToolSchemaDisclosureRequestMetrics {
	let searchCount = 0;
	let searchMissCount = 0;
	let referencedToolCount = 0;
	let searchResolutionMs: number | null = null;
	if (plan.enabled) {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "toolResult") break;
			if (message.toolName !== TOOL_SCHEMA_SEARCH_NAME || !isToolSchemaSearchDetails(message.details)) continue;
			searchCount++;
			const matches = searchDeferredToolSchemas(plan, message.details.query, message.details.maxResults);
			if (matches.length === 0) searchMissCount++;
			referencedToolCount += matches.length;
			if (Number.isFinite(now) && Number.isFinite(message.timestamp)) {
				const elapsed = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(now - message.timestamp)));
				searchResolutionMs = Math.max(searchResolutionMs ?? 0, elapsed);
			}
		}
	}
	return {
		...plan.metrics,
		searchCount,
		searchMissCount,
		referencedToolCount,
		searchResolutionMs,
	};
}
