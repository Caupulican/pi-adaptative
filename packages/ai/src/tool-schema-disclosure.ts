import type { Context, Message, Tool, ToolResultMessage } from "./types.ts";
import { isRecord } from "./utils/value-guards.ts";

export const TOOL_SCHEMA_SEARCH_NAME = "tool_search";
export const TOOL_SCHEMA_SEARCH_DETAILS_KIND = "deferred_tool_schema_search";
export const TOOL_SCHEMA_DISCLOSURE_BETA = "tool-search-tool-2025-10-19";

export const MIN_TOOL_SCHEMA_DISCLOSURE_SEARCHABLE_TOOLS = 10;
/**
 * Estimated tokens of the resident schemas, the search tool excluded. A tool that declares `neverDefer` stays resident
 * past it; the remaining room goes to the other tools in list order.
 */
export const DEFAULT_RESIDENT_TOOL_SCHEMA_TOKENS = 4_096;
const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCHABLE_SCHEMA_CHARS = 32_768;
const CATALOG_LINE_CHARS = 96;

export interface ToolSchemaSearchDetails {
	kind: typeof TOOL_SCHEMA_SEARCH_DETAILS_KIND;
	query: string;
	maxResults: number;
}

/**
 * Who serves the deferred schemas of one tool list.
 * - `native`: the provider's own tool search (the adapter sends the deferred schemas marked deferred).
 * - `harness`: a provider without one; {@link discloseToolSchemas} lists the deferred tools in the search tool and
 *   answers searches itself.
 * - `disclosed`: a list the harness already disclosed upstream; it is sent as it is.
 * - `eager`: nothing is deferred and the search tool is left out.
 */
export type ToolSchemaDisclosureMode = "native" | "harness" | "disclosed" | "eager";

export interface ToolSchemaDisclosurePlan {
	mode: ToolSchemaDisclosureMode;
	/** This plan defers schemas: `native` or `harness`. */
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

/** One request's disclosure: the plan, and the deferred tools its own history activated (in activation order). */
export interface ToolSchemaDisclosureDecision {
	plan: ToolSchemaDisclosurePlan;
	activatedToolNames: readonly string[];
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

/** Characters of a tool as a provider renders it: name, description and parameters. Memoized by tool identity. */
const schemaCharactersByTool = new WeakMap<Tool, number>();

function schemaCharacters(tool: Tool): number {
	const cached = schemaCharactersByTool.get(tool);
	if (cached !== undefined) return cached;
	const characters = JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}).length;
	schemaCharactersByTool.set(tool, characters);
	return characters;
}

function estimatedTokens(characters: number): number {
	return Math.ceil(characters / 4);
}

function disclosureMetrics(
	tools: readonly Tool[],
	eagerToolNames: ReadonlySet<string>,
	deferredToolNames: ReadonlySet<string>,
): ToolSchemaDisclosureMetrics {
	let eagerSchemaCharacters = 0;
	let deferredSchemaCharacters = 0;
	for (const tool of tools) {
		const characters = schemaCharacters(tool);
		if (deferredToolNames.has(tool.name)) deferredSchemaCharacters += characters;
		else eagerSchemaCharacters += characters;
	}
	return {
		totalToolCount: tools.length,
		eagerToolCount: eagerToolNames.size,
		deferredToolCount: deferredToolNames.size,
		eagerSchemaCharacters,
		deferredSchemaCharacters,
		estimatedEagerSchemaTokens: estimatedTokens(eagerSchemaCharacters),
		estimatedDeferredSchemaTokens: estimatedTokens(deferredSchemaCharacters),
	};
}

/**
 * ChatGPT Codex serves client-executed `tool_search` (verified against `gpt-6.1-sol`): the request carries only the
 * resident tools plus the search spec, a search answers with a `tool_search_output` item that holds the loaded
 * definitions, and the request's tool list never changes. GPT-6 models are the ones verified; others use the harness.
 */
function supportsCodexToolSearch(model: ToolSchemaDisclosureModel): boolean {
	return model.provider === "openai-codex" && /^gpt-[6-9](?:[.-]|$)/u.test(model.id);
}

/** Native capability gate shared by planning and the provider adapters. Unknown endpoints use the harness. */
export function supportsToolSchemaDisclosure(model: ToolSchemaDisclosureModel): boolean {
	if (model.api !== "anthropic-messages" && model.api !== "openai-codex-responses") return false;
	const override = (model.compat as { supportsToolSearch?: boolean } | undefined)?.supportsToolSearch;
	if (override !== undefined) return override;
	if (model.api === "openai-codex-responses") return supportsCodexToolSearch(model);
	return (
		model.provider === "anthropic" && isFirstPartyAnthropicHost(model.baseUrl) && supportsToolReferences(model.id)
	);
}

/**
 * The search tool of a list the harness disclosed, with the deferred names its catalog lists. Identity marks a
 * disclosed list, so a second materialization or a provider adapter carries it as it is.
 */
const harnessSearchToolCatalogs = new WeakMap<Tool, ReadonlySet<string>>();

/** The deferred tool names a harness-disclosed search tool lists, or undefined for any other tool. */
export function harnessDeferredToolNames(tool: Tool): ReadonlySet<string> | undefined {
	return harnessSearchToolCatalogs.get(tool);
}

function eagerPlan(tools: readonly Tool[], mode: "disclosed" | "eager"): ToolSchemaDisclosurePlan {
	const eagerToolNames = new Set(tools.map((tool) => tool.name));
	const deferredToolNames = new Set<string>();
	return {
		mode,
		enabled: false,
		tools,
		eagerToolNames,
		deferredToolNames,
		metrics: disclosureMetrics(tools, eagerToolNames, deferredToolNames),
	};
}

/**
 * Resident tools: every tool that declares `neverDefer`, then the others in list order while the estimated schema
 * tokens of all residents stay within the budget. The search tool is not part of the list and spends no budget.
 */
function residentToolNames(searchableTools: readonly Tool[]): Set<string> {
	const resident = new Set<string>();
	let tokens = 0;
	for (const tool of searchableTools) {
		if (tool.neverDefer !== true) continue;
		resident.add(tool.name);
		tokens += estimatedTokens(schemaCharacters(tool));
	}
	for (const tool of searchableTools) {
		if (resident.has(tool.name)) continue;
		const cost = estimatedTokens(schemaCharacters(tool));
		if (tokens + cost > DEFAULT_RESIDENT_TOOL_SCHEMA_TOKENS) continue;
		resident.add(tool.name);
		tokens += cost;
	}
	return resident;
}

/**
 * Stable eager/deferred split of one tool list. Disclosure needs the search tool and at least
 * {@link MIN_TOOL_SCHEMA_DISCLOSURE_SEARCHABLE_TOOLS} other tools, and leaves something deferred; otherwise every schema
 * is eager. The mode names who serves the deferred schemas: the provider when it searches natively, else the harness.
 */
export function planToolSchemaDisclosure(
	model: ToolSchemaDisclosureModel,
	tools: readonly Tool[],
): ToolSchemaDisclosurePlan {
	const searchTool = tools.find((tool) => tool.name === TOOL_SCHEMA_SEARCH_NAME);
	if (searchTool && harnessSearchToolCatalogs.has(searchTool)) return eagerPlan(tools, "disclosed");
	const searchableTools = tools.filter((tool) => tool !== searchTool);
	if (!searchTool || searchableTools.length < MIN_TOOL_SCHEMA_DISCLOSURE_SEARCHABLE_TOOLS) {
		return eagerPlan(tools, "eager");
	}
	const eagerToolNames = residentToolNames(searchableTools);
	const deferredToolNames = new Set(
		searchableTools.filter((tool) => !eagerToolNames.has(tool.name)).map((tool) => tool.name),
	);
	if (deferredToolNames.size === 0) return eagerPlan(tools, "eager");
	eagerToolNames.add(TOOL_SCHEMA_SEARCH_NAME);
	return {
		mode: supportsToolSchemaDisclosure(model) ? "native" : "harness",
		enabled: true,
		tools,
		eagerToolNames,
		deferredToolNames,
		metrics: disclosureMetrics(tools, eagerToolNames, deferredToolNames),
	};
}

/** Whether a provider adapter sends the search tool: its own native search serves it, or the harness disclosed the list. */
export function providerSendsToolSchemaSearch(plan: ToolSchemaDisclosurePlan): boolean {
	return plan.mode === "native" || plan.mode === "disclosed";
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

/** The deferred tools one search result loads, resolved against `plan`; none for another tool or a failed search. */
function searchResultTools(plan: ToolSchemaDisclosurePlan, message: ToolResultMessage): Tool[] | undefined {
	if (message.toolName !== TOOL_SCHEMA_SEARCH_NAME || message.isError || !isToolSchemaSearchDetails(message.details)) {
		return undefined;
	}
	return searchDeferredToolSchemas(plan, message.details.query, message.details.maxResults);
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
			if (message.toolName !== TOOL_SCHEMA_SEARCH_NAME) continue;
			searchCount++;
			const matches = message.isError ? [] : (message.toolSearch?.tools ?? searchResultTools(plan, message) ?? []);
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

/** The first line and sentence of a description, cut at a word within {@link CATALOG_LINE_CHARS}. */
function catalogLine(tool: Tool): string {
	const firstLine = tool.description.split("\n", 1)[0]?.trim() ?? "";
	const sentenceEnd = firstLine.search(/[.!?](?:\s|$)/u);
	const sentence = sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd) : firstLine;
	if (sentence.length <= CATALOG_LINE_CHARS) return sentence;
	const cut = sentence.slice(0, CATALOG_LINE_CHARS);
	const wordEnd = cut.lastIndexOf(" ");
	return `${wordEnd > 0 ? cut.slice(0, wordEnd) : cut}...`;
}

/** Harness search tools by source search tool, keyed by their catalog text, so an unchanged plan reuses one object. */
const harnessSearchTools = new WeakMap<Tool, { catalog: string; tool: Tool }>();

/** The search tool a harness-disclosed request sends: its own description, then the plan's deferred catalog. */
function harnessSearchTool(plan: ToolSchemaDisclosurePlan, searchTool: Tool): Tool {
	const catalog = plan.tools
		.filter((tool) => plan.deferredToolNames.has(tool.name))
		.map((tool) => `${tool.name}: ${catalogLine(tool)}`)
		.join("; ");
	const cached = harnessSearchTools.get(searchTool);
	if (cached?.catalog === catalog) return cached.tool;
	const tool: Tool = {
		...searchTool,
		description: `${searchTool.description}\nDeferred tools (load them with select:name1,name2 before calling): ${catalog}.`,
	};
	harnessSearchTools.set(searchTool, { catalog, tool });
	harnessSearchToolCatalogs.set(tool, plan.deferredToolNames);
	return tool;
}

function renderSearchResult(matches: readonly Tool[]): string {
	if (matches.length === 0) return "No matching deferred tools found.";
	return [
		`Loaded ${matches.length} deferred tool schema(s); they are callable from the next step:`,
		...matches.map((tool) =>
			JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
		),
	].join("\n");
}

/** Rewritten search results by source message, with the tools they were resolved to. */
const rewrittenSearchResults = new WeakMap<Message, { matches: readonly Tool[]; message: ToolResultMessage }>();

function sameTools(left: readonly Tool[], right: readonly Tool[]): boolean {
	return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

/**
 * Harness disclosure of one request, for a provider without native tool search. Pure in its inputs, so every request
 * of one history renders the same bytes:
 * - the resident tools keep their list order, and the search tool carries the plan's catalog (names and one line each);
 * - each search result is answered with the full schemas of what it loaded, resolved against the plan's deferred set;
 * - a deferred tool a search loaded, the history already called, or `options.forcedToolName` names is appended after
 *   the resident tools in first-activation order, so activation extends the tool list and never reorders it;
 * - the history activation reads is `options.activationHistory` when given (the conversation's whole transcript), then
 *   the request's own messages: a bounded projection of the transcript (a folded or packed context view) no longer
 *   carries the search or call that activated a tool, while the conversation still shows the model it used that tool,
 *   so activation read from the projection alone would drop a tool the model goes on to call;
 * - with `options.appendActivated` false (a text tool protocol, whose primer sits in the system prompt) activated tools
 *   are not appended: the search result already carries their schemas, and the reply parser accepts every granted tool.
 * A list with nothing to defer is sent eager without the search tool; a native or already disclosed list is unchanged.
 */
export function discloseToolSchemas(
	model: ToolSchemaDisclosureModel,
	context: Context,
	options: { forcedToolName?: string; appendActivated: boolean; activationHistory?: readonly Message[] },
): { context: Context; decision: ToolSchemaDisclosureDecision } {
	const tools = context.tools ?? [];
	const plan = planToolSchemaDisclosure(model, tools);
	if (plan.mode === "native" || plan.mode === "disclosed")
		return { context, decision: { plan, activatedToolNames: [] } };
	if (plan.mode === "eager") {
		const sent = tools.filter((tool) => tool.name !== TOOL_SCHEMA_SEARCH_NAME);
		return {
			context: sent.length === tools.length ? context : { ...context, tools: sent },
			decision: { plan, activatedToolNames: [] },
		};
	}
	const activated = new Set<string>();
	const activate = (name: string): void => {
		if (plan.deferredToolNames.has(name)) activated.add(name);
	};
	/** Activates what one message called or loaded; returns the tools a search result loaded, for its rewrite. */
	const activateFrom = (message: Message): Tool[] | undefined => {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") activate(block.name);
			return undefined;
		}
		if (message.role !== "toolResult") return undefined;
		const matches = searchResultTools(plan, message);
		for (const tool of matches ?? []) activate(tool.name);
		return matches;
	};
	for (const message of options.activationHistory ?? []) activateFrom(message);
	let messages: Message[] | undefined;
	for (const [index, message] of context.messages.entries()) {
		const matches = activateFrom(message);
		if (matches === undefined || message.role !== "toolResult") continue;
		const cached = rewrittenSearchResults.get(message);
		const rewritten: ToolResultMessage =
			cached && sameTools(cached.matches, matches)
				? cached.message
				: { ...message, content: [{ type: "text", text: renderSearchResult(matches) }] };
		if (rewritten !== cached?.message) rewrittenSearchResults.set(message, { matches, message: rewritten });
		messages ??= context.messages.slice();
		messages[index] = rewritten;
	}
	if (options.forcedToolName !== undefined) activate(options.forcedToolName);
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const sentTools: Tool[] = [];
	for (const tool of tools) {
		if (!plan.eagerToolNames.has(tool.name)) continue;
		sentTools.push(tool.name === TOOL_SCHEMA_SEARCH_NAME ? harnessSearchTool(plan, tool) : tool);
	}
	if (options.appendActivated) {
		for (const name of activated) {
			const tool = byName.get(name);
			if (tool) sentTools.push(tool);
		}
	}
	return {
		context: { ...context, ...(messages ? { messages } : {}), tools: sentTools },
		decision: { plan, activatedToolNames: [...activated] },
	};
}

/**
 * The tool a provider option forces, in the shapes the adapters accept (`{ name }`, `{ function: { name } }`), so a
 * forced tool is never left deferred.
 */
export function forcedToolChoiceName(toolChoice: unknown): string | undefined {
	if (!isRecord(toolChoice)) return undefined;
	if (typeof toolChoice.name === "string") return toolChoice.name;
	const fn = toolChoice.function;
	return isRecord(fn) && typeof fn.name === "string" ? fn.name : undefined;
}
