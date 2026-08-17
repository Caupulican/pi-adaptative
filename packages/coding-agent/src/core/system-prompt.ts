/**
 * System prompt construction and project context loading
 */

import { dirname } from "node:path";
import { getReadmePath } from "../config.ts";
import { getExtensionDescription, getExtensionDisplayName } from "./extension-metadata.ts";
import type { Extension } from "./extensions/types.ts";
import { enforceModelCapabilitySystemPromptBudget, type ModelCapabilityProfile } from "./model-capability.ts";
import { SKILL_VAULT_SYSTEM_RULE } from "./provider-prompt-contracts.ts";
import type { Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Capability profile that selects the stable prompt shape. Missing means full/legacy behavior. */
	modelCapability?: Pick<ModelCapabilityProfile, "class" | "contextWindow" | "reasonCode" | "systemPromptMaxChars">;
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in the prompt. Defaults come from the shared active-tool surface. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Global instruction files (with content) plus on-demand project paths (path only). */
	contextFiles?: Array<{ path: string; content?: string }>;
	/** Discovered skills remain host-side; retained for extension/API construction compatibility. */
	skills?: Skill[];
	/** Discovered extensions currently active. */
	extensions?: Extension[];
}

const MODEL_BLIND_CREDENTIAL_AUTHORITY =
	"Active secret_store: host gate authorizes model-blind activation/migration from named accessible sources; no duplicate confirmation.";

const ULTRA_TERSE_OUTPUT_POLICY = `

ULTRA-TERSE OUTPUT

- Drop articles/filler/pleasantries/hedging; fragments valid. Strip conjunctions only when clear; each fact once.
- Never drop not/never/no/only/except; never invent abbreviations or use causal arrows. Preserve numbers, units, code symbols, function/API names, commands, errors.
- No self-reference/tool narration/tables/emoji/log dumps. Keep user language. Full grammar: security, irreversible actions, ambiguous order. Replies terse; artifacts normal prose.`;

const PI_ADAPTATIVE_CORE_SECTION = `

OPERATING CONTRACT

- Clear conversational outcome is goal; persist progress/evidence through compaction; finish or report blocker.
- Hold scope; verify unknowns from primary sources; simplest proven design, one owner/path per invariant.
- User outcome governs, method does not. Outcome risk: show evidence, test when practical, offer safest effective path, execute.
- Work over 15 seconds: managed background run, event terminal, bounded handoff, owner notice; never poll.
- Delegate independent work within host bounds; root integrates/verifies. Facts: memory, specialization: skills, behavior: source; discard noise.
- Ask before broader scope, credential or authentication change/disclosure, destructive action, publication. Bound, source-label output; show paths.
- ${MODEL_BLIND_CREDENTIAL_AUTHORITY}

N+2 ARCHITECTURE

Language-agnostic principles:
1. Bounded flat arenas/pools/rings/chunks, batch recycle.
2. Safe zero/default data/state, no hidden allocation, one activation owner.
3. Validate trust boundary once; internal miss gets safe stub/default, external failure explicit.
4. Stable IDs/indexes/buffers/batches; avoid pointer graphs/dispatch/fallback.
5. Never concatenate growing prefixes, prepend, rescan consumed input, serialize unchanged history, rebuild incremental state; materialize once.

EVIDENCE GATE

- Map flow/lifetimes/boundaries/hot paths. Detect, verify, score, gate: baseline; deterministic positive/negative controls; lowest-owner fix; focused/proportionate checks.
- Scanner/fuzzer/log/static/model finding stays candidate pending reproduction. Never weaken tests, claim success from skipped/incomplete probes.`;

const PI_ADAPTATIVE_LEAN_CORE_SECTION = `

OPERATING CONTRACT

- Complete current goal within scope, granted authority; keep progress, evidence concise.
- Inspect relevant files, project instructions before mutation; make smallest coherent change, run focused checks.
- Use active tools, exact schemas. On failure, read error, expected shape, correct call; never repeat unchanged failure.
- Batch independent reads, order mutations; report real output, unresolved failures.
- Ask before destructive actions, credential disclosure or provider authentication changes, publication, push/tag/release, material scope expansion.
- ${MODEL_BLIND_CREDENTIAL_AUTHORITY}`;

const PI_ADAPTATIVE_MINIMAL_CORE_SECTION = `

EXECUTION RULES

- Work one scoped task. Inspect before editing, make small coherent change, run narrowest useful check.
- Use listed tools, exact schemas. On failure, read error, expected shape, correct call; never repeat unchanged failure.
- Batch independent reads, order mutations. Report actual results; never claim incomplete action.
- Ask before destructive actions, credential disclosure or provider authentication changes, publication, push/tag/release, material scope change.
- ${MODEL_BLIND_CREDENTIAL_AUTHORITY}`;

const PI_ADAPTATIVE_CHAT_CORE_SECTION = `

CHAT RULES

- Answer concisely from conversation; state uncertainty.
- No execution tools are active. Do not claim to read files, run commands, or make changes.
- Say when the request requires a tool-capable model or additional user-provided context.`;

const DEFERRED_CONTEXT_PATH_BUDGET_CHARS = 512;
const EXTENSION_DESCRIPTION_BUDGET_CHARS = 180;

function compactPromptText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	let end = maxChars - 1;
	const code = normalized.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return `${normalized.slice(0, end)}…`;
}

function formatContextFilesForPrompt(
	contextFiles: Array<{ path: string; content?: string }>,
	options: { deferContents: boolean; canRead: boolean },
): string {
	if (contextFiles.length === 0) {
		return "";
	}
	const injected = options.deferContents ? [] : contextFiles.filter((file) => file.content !== undefined);
	const deferred = options.deferContents ? contextFiles : contextFiles.filter((file) => file.content === undefined);
	const parts: string[] = [];

	if (injected.length > 0) {
		const lines = ["\n\nPROJECT-SPECIFIC INSTRUCTIONS (apply in listed order)"];
		const seen = new Set<string>();
		for (const { path, content } of injected) {
			const identity = `${path}\0${content ?? ""}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			lines.push(`FILE ${JSON.stringify(path)} (${(content ?? "").length} chars)`);
			lines.push(content ?? "");
			lines.push("END FILE");
		}
		parts.push(lines.join("\n"));
	}

	if (deferred.length > 0) {
		const lines = [
			"\n\nPROJECT RULE PATHS — contents not preloaded.",
			options.deferContents
				? options.canRead
					? "Before editing, writing, or running a mutating command, read each relevant listed file completely before any mutation. Follow its instructions; if a file cannot fit, ask for a scoped instruction digest."
					: "No read tool is active. Ask the user for the relevant project instructions before giving project-specific guidance."
				: options.canRead
					? "Read a listed file completely before following it. Do not assume its contents."
					: "No read tool is active. Ask the user for the relevant project instructions before giving project-specific guidance.",
		];
		let pathChars = 0;
		let included = 0;
		for (const { path } of deferred) {
			const line = `- ${JSON.stringify(path)}`;
			if (pathChars + line.length > DEFERRED_CONTEXT_PATH_BUDGET_CHARS) break;
			lines.push(line);
			pathChars += line.length + 1;
			included++;
		}
		const omitted = deferred.length - included;
		if (omitted > 0) {
			lines.push(`- omitted=${omitted}`);
			lines.push(
				"Do not mutate until the omitted instruction paths are supplied or a more capable profile is used.",
			);
		}
		parts.push(lines.join("\n"));
	}

	return parts.join("");
}

function appendPromptResources(
	prompt: string,
	options: {
		appendSection: string;
		contextFiles: Array<{ path: string; content?: string }>;
		extensions: Extension[];
		visibleTools: string[];
		fullPrompt: boolean;
		hasRead: boolean;
		date: string;
		promptCwd: string;
		modelCapability: BuildSystemPromptOptions["modelCapability"];
	},
): string {
	let result = prompt;
	if (options.appendSection) result += options.appendSection;
	result += formatContextFilesForPrompt(options.contextFiles, {
		deferContents: !options.fullPrompt,
		canRead: options.hasRead,
	});
	// Extension metadata is redundant with the active tool snippets on constrained profiles.
	if (options.fullPrompt && options.extensions.length > 0) {
		result += formatExtensionsForPrompt(options.extensions, options.visibleTools);
	}
	// Day-granularity only; keep this tail stable across every call on the same calendar day.
	result += `\nCurrent date: ${options.date}`;
	result += `\nCurrent working directory: ${options.promptCwd}`;
	// Prompt resources can come from CRLF checkouts or user files. Canonicalize once at the final
	// assembly boundary so capability budgets and provider cache keys are host-independent.
	const normalizedResult = result.replace(/\r\n?/g, "\n");
	return options.modelCapability
		? enforceModelCapabilitySystemPromptBudget(normalizedResult, options.modelCapability)
		: normalizedResult;
}

/**
 * Build the system prompt with tools, guidelines, and context.
 *
 * CACHE-STABILITY INVARIANT: providers treat the returned string as ONE prompt-cache block (a
 * single cache breakpoint covering the whole system prompt). The caller (SystemPromptBuilder /
 * AgentSession, see `_rebuildSystemPrompt` in agent-session.ts) rebuilds it only when the TOOL
 * SURFACE changes — never per turn. For a fixed `options` (fixed tool surface, cwd, context
 * files, extensions), two calls on the SAME CALENDAR DAY must return byte-identical
 * output, because `date` below is deliberately truncated to Y-M-D granularity. Do NOT widen it
 * to a timestamp (HH:MM:SS) or otherwise fold in any per-turn-volatile field (turn counters,
 * elapsed time, random ids, etc.) — that would cache-bust this entire block on EVERY turn instead
 * of once per calendar day, defeating provider prompt caching (cost + latency regression on every
 * request). Pinned by test/system-prompt-stability.test.ts.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	// Day-granularity only (see cache-stability invariant on buildSystemPrompt above): this must
	// stay stable across every call within a calendar day, not just within a single turn.
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const capabilityClass = options.modelCapability?.class ?? "full";
	const fullPrompt = capabilityClass === "full";
	const leanPrompt = capabilityClass === "lean";

	const activeTools = selectedTools || ["read", "bash", "python", "edit", "write"];
	const visibleTools = activeTools.filter((name) => !!toolSnippets?.[name]);
	const hasRead = activeTools.includes("read");
	const coreSection = fullPrompt
		? PI_ADAPTATIVE_CORE_SECTION
		: leanPrompt
			? PI_ADAPTATIVE_LEAN_CORE_SECTION
			: capabilityClass === "minimal"
				? PI_ADAPTATIVE_MINIMAL_CORE_SECTION
				: PI_ADAPTATIVE_CHAT_CORE_SECTION;
	const skillVaultContract = activeTools.includes("skill") ? `\n\n${SKILL_VAULT_SYSTEM_RULE}` : "";
	const operatingContract = `${coreSection}${skillVaultContract}${ULTRA_TERSE_OUTPUT_POLICY}`;

	if (customPrompt) {
		let prompt = customPrompt;

		prompt += operatingContract;
		return appendPromptResources(prompt, {
			appendSection,
			contextFiles,
			extensions: options.extensions ?? [],
			visibleTools,
			fullPrompt,
			hasRead,
			date,
			promptCwd,
			modelCapability: options.modelCapability,
		});
	}

	const packageRoot = dirname(getReadmePath());

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = activeTools.includes("bash");
	const hasPython = activeTools.includes("python");
	const hasGrep = activeTools.includes("grep");
	const hasFind = activeTools.includes("find");
	const hasLs = activeTools.includes("ls");
	const hasReadOnlyTools = hasRead || hasGrep || hasFind || hasLs;

	// File exploration guidelines
	if (!fullPrompt && !leanPrompt) {
		if (hasBash) addGuideline("Use bash for bounded shell commands");
		if (hasReadOnlyTools) addGuideline("Batch independent reads; keep mutations and dependent calls ordered");
	} else if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Bash: ls, rg, find");
	}
	if (fullPrompt || leanPrompt) {
		if (hasBash || hasGrep || hasFind) {
			addGuideline("rg/jq: scoped roots/filters, exhaustive output to file");
		}
		if (hasPython) {
			addGuideline("Python: bounded scripts/data, source edits via read/edit/write");
		}
		if (hasReadOnlyTools) {
			addGuideline("Batch independent reads; order dependent/mutating/stateful calls");
		}
	}

	if (fullPrompt || leanPrompt) {
		for (const guideline of promptGuidelines ?? []) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				addGuideline(normalized);
			}
		}
	}

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
	const toolGuidelinesSection = guidelines.length > 0 ? `\n\nTOOL GUIDELINES\n\n${guidelines}` : "";

	const introduction = fullPrompt
		? "Pi-Adaptative: self-evolving assistant. Deliver goals within authority; preserve continuity, own integration."
		: leanPrompt
			? "Pi-Adaptative bounded coding agent. Complete current goal with active surface; preserve handoff evidence."
			: capabilityClass === "minimal"
				? "Pi-Adaptative focused coding executor. Complete one scoped task with active tools; report verified results."
				: "Pi-Adaptative concise chat assistant. No execution tools active.";
	const toolSurfaceRule =
		fullPrompt || leanPrompt
			? "Use active tool surface only; unlisted capabilities may exist."
			: "Use only the active tool surface.";
	let prompt = `${introduction}

Available tools:
${toolsList}

${toolSurfaceRule}${operatingContract}${toolGuidelinesSection}`;

	if (fullPrompt) {
		prompt += `

PI DOCS: root=${packageRoot}. Relevant work only; read needed README.md, \`docs/...\`, \`examples/...\` fully, follow links.`;
	}

	return appendPromptResources(prompt, {
		appendSection,
		contextFiles,
		extensions: options.extensions ?? [],
		visibleTools,
		fullPrompt,
		hasRead,
		date,
		promptCwd,
		modelCapability: options.modelCapability,
	});
}

function formatExtensionsForPrompt(extensions: Extension[], visibleTools: string[]): string {
	if (extensions.length === 0) {
		return "";
	}

	const lines = ["\n\nEXTENSIONS: name, path, tools, commands, description"];
	let added = 0;

	for (const ext of extensions) {
		const name = getExtensionDisplayName(ext.path);
		const description = getExtensionDescription(ext.path);

		const tools = Array.from(ext.tools.keys()).filter((t) => visibleTools.includes(t));
		const commands = Array.from(ext.commands.keys());

		// Skip extension listing if it has no visible tools, commands, or description
		if (tools.length === 0 && commands.length === 0 && !description) {
			continue;
		}

		lines.push(
			JSON.stringify({
				name,
				path: ext.path,
				...(tools.length > 0 ? { tools } : {}),
				...(commands.length > 0 ? { commands } : {}),
				...(description ? { description: compactPromptText(description, EXTENSION_DESCRIPTION_BUDGET_CHARS) } : {}),
			}),
		);
		added++;
	}

	if (added === 0) {
		return "";
	}

	return lines.join("\n");
}
