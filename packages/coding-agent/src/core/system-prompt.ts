/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { getExtensionDescription, getExtensionDisplayName } from "./extension-metadata.ts";
import type { Extension } from "./extensions/types.ts";
import { enforceModelCapabilitySystemPromptBudget, type ModelCapabilityProfile } from "./model-capability.ts";
import { escapePromptXml } from "./prompt-markup.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Capability profile that selects the stable prompt shape. Missing means full/legacy behavior. */
	modelCapability?: Pick<ModelCapabilityProfile, "class" | "contextWindow" | "reasonCode" | "systemPromptMaxChars">;
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write, context_audit] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Eagerly loaded project/agent instruction files. */
	contextFiles?: Array<{ path: string; content?: string }>;
	/** Discovered skills; startup prompt lists only lazy-loadable locations. */
	skills?: Skill[];
	/** Discovered extensions currently active. */
	extensions?: Extension[];
}

const PI_ADAPTATIVE_CORE_SECTION = `

OPERATING POSTURE

- Treat a clear outcome expressed in normal conversation as a goal; no slash command is required. Persist evidence and progress, survive compaction, and continue until delivered or stopped.
- Hold scope. Verify uncertainty from authoritative sources; use the simplest proven design that satisfies ownership, lifecycle, performance, and failure needs.
- Store durable facts in memory, reusable specialization in skills, and behavior in source. Shard and index oversized memory; discard noise.
- Choose autonomously; delegate bounded execution to the cheapest capable worker while the parent owns integration.
- The user’s desired outcome is authoritative; a proposed method is not. If a method may undermine the outcome, pause: give causal evidence, test the disputed premise when practical, and offer the strongest outcome-preserving alternative. Once chosen, execute faithfully within authority.
- Move work expected to exceed 15 seconds into managed background execution. Require event-driven completion, a bounded handoff, and owner notification; never poll.
- Ask before scope expansion, credentials, destructive actions, or publication. Keep external and tool output bounded, source-labeled, and evidence-focused; show file paths clearly.

N+2 ARCHITECTURE

Apply these language-agnostic principles with direct runtime facilities:

1. Group Lifetimes: Put overlapping lifetimes in bounded arenas, pools, rings, chunks, or flat owners; recycle in batches and avoid per-item churn.

2. Valid Defaults: Make zero/default data, handles, states, and resources safe without hidden allocation; one system owns activation.

3. Stubs and Boundaries: Validate trust and external boundaries once. Internal misses return benign stubs, sentinels, or defaults; external failures stay explicit.

4. Flat Ownership: Prefer flat/chunked data, stable IDs, compact indexes, buffers, and batches over pointer graphs, needless dispatch, fallbacks, or wrappers.

5. Linear Bounds: Never concatenate growing prefixes, prepend repeatedly, rescan consumed input, serialize unchanged history, or rebuild full incremental state. Materialize only the needed window once.

ENGINEERING WORKFLOW

- Map flow, lifetimes, boundaries, hot paths, and one authoritative path per invariant.
- Detect → Verify → Score → Gate: baseline; reproduce with a negative control; fix the lowest owner; run focused, then proportionate gates.
- Scanner, fuzzer, log, static, and model findings are candidates until reproduced. Never weaken tests or claim success from incomplete probes.`;

const PI_ADAPTATIVE_LEAN_CORE_SECTION = `

OPERATING CONTRACT

- Complete the current goal within scope and granted authority. Keep progress and evidence concise.
- Inspect relevant files and project instructions before mutation. Make the smallest coherent change and verify it with focused checks.
- Use only active tools and follow their schemas exactly. When a call fails, use the returned error and expected shape to correct it; never repeat an unchanged failed call.
- Keep independent reads together and mutations ordered. Report real output and unresolved failures.
- Ask before destructive actions, credentials, publication, push/tag/release, or material scope expansion.`;

const PI_ADAPTATIVE_MINIMAL_CORE_SECTION = `

EXECUTION RULES

- Work on one scoped task at a time. Inspect before editing, make a small coherent change, then run the narrowest useful verification.
- Use only listed tools and exact schemas. If a tool call fails, read the returned error and expected shape, correct the call, and do not repeat it unchanged.
- Keep independent reads together and mutations ordered. Report actual results; never claim an action you did not complete.
- Ask before destructive actions, credentials, publication, push/tag/release, or a material scope change.`;

const PI_ADAPTATIVE_CHAT_CORE_SECTION = `

CHAT RULES

- Answer concisely from the conversation and state uncertainty.
- No execution tools are active. Do not claim to read files, run commands, or make changes.
- Say when the request requires a tool-capable model or additional user-provided context.`;

const DEFERRED_CONTEXT_PATH_BUDGET_CHARS = 512;
const LEAN_SKILL_CATALOG_BUDGET_CHARS = 500;

function formatContextFilesForPrompt(
	contextFiles: Array<{ path: string; content?: string }>,
	options: { deferContents: boolean; canRead: boolean },
): string {
	if (contextFiles.length === 0) {
		return "";
	}
	if (options.deferContents) {
		const lines = [
			"\n\n<project_context>",
			"",
			"Project instruction contents are deferred for this capability profile to preserve working context.",
			options.canRead
				? "Before editing, writing, or running a mutating command, read each relevant listed file completely before any mutation. Follow its instructions; if a file cannot fit, ask for a scoped instruction digest."
				: "No read tool is active. Ask the user for the relevant project instructions before giving project-specific guidance.",
			"",
			"<deferred_project_instructions>",
		];
		let pathChars = 0;
		let included = 0;
		for (const { path } of contextFiles) {
			const line = `  <file path="${escapePromptXml(path)}" />`;
			if (pathChars + line.length > DEFERRED_CONTEXT_PATH_BUDGET_CHARS) break;
			lines.push(line);
			pathChars += line.length + 1;
			included++;
		}
		const omitted = contextFiles.length - included;
		if (omitted > 0) {
			lines.push(`  <omitted count="${omitted}" />`);
		}
		lines.push("</deferred_project_instructions>", "", "</project_context>");
		if (omitted > 0) {
			lines.push(
				"Do not mutate until the omitted instruction paths are supplied or a more capable profile is used.",
			);
		}
		return lines.join("\n");
	}

	const lines = ["\n\n<project_context>", "", "Project-specific instructions and guidelines:", ""];

	for (const { path, content } of contextFiles) {
		lines.push(`<project_instructions path="${escapePromptXml(path)}">`);
		lines.push(content ?? "");
		lines.push("</project_instructions>", "");
	}

	lines.push("</project_context>");
	return lines.join("\n");
}

function formatLeanSkillsForPrompt(skills: Skill[]): string {
	const eligibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (eligibleSkills.length === 0) return "";
	const lines = ["\n\nSpecialized skills (load only when clearly relevant):", "<available_skills>"];
	let catalogChars = 0;
	let included = 0;
	for (const skill of eligibleSkills) {
		const line = `  <skill name="${escapePromptXml(skill.name)}" location="${escapePromptXml(skill.filePath)}">${escapePromptXml(skill.description.slice(0, 120))}</skill>`;
		if (catalogChars + line.length > LEAN_SKILL_CATALOG_BUDGET_CHARS) break;
		lines.push(line);
		catalogChars += line.length + 1;
		included++;
	}
	lines.push("</available_skills>");
	const omitted = eligibleSkills.length - included;
	if (omitted > 0) lines.push(`${omitted} additional skill(s) are not preloaded on this profile.`);
	return lines.join("\n");
}

function appendPromptResources(
	prompt: string,
	options: {
		appendSection: string;
		contextFiles: Array<{ path: string; content?: string }>;
		skills: Skill[];
		extensions: Extension[];
		visibleTools: string[];
		fullPrompt: boolean;
		leanPrompt: boolean;
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
	if (options.hasRead && options.skills.length > 0) {
		if (options.fullPrompt) result += formatSkillsForPrompt(options.skills);
		else if (options.leanPrompt) result += formatLeanSkillsForPrompt(options.skills);
	}
	// Extension metadata is redundant with the active tool snippets on constrained profiles.
	if (options.fullPrompt && options.extensions.length > 0) {
		result += formatExtensionsForPrompt(options.extensions, options.visibleTools);
	}
	// Day-granularity only; keep this tail stable across every call on the same calendar day.
	result += `\nCurrent date: ${options.date}`;
	result += `\nCurrent working directory: ${options.promptCwd}`;
	return options.modelCapability ? enforceModelCapabilitySystemPromptBudget(result, options.modelCapability) : result;
}

/**
 * Build the system prompt with tools, guidelines, and context.
 *
 * CACHE-STABILITY INVARIANT: providers treat the returned string as ONE prompt-cache block (a
 * single cache breakpoint covering the whole system prompt). The caller (SystemPromptBuilder /
 * AgentSession, see `_rebuildSystemPrompt` in agent-session.ts) rebuilds it only when the TOOL
 * SURFACE changes — never per turn. For a fixed `options` (fixed tool surface, cwd, context
 * files, skills, extensions), two calls on the SAME CALENDAR DAY must return byte-identical
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
		skills: providedSkills,
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
	const skills = providedSkills ?? [];
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

	if (customPrompt) {
		let prompt = customPrompt;

		prompt += coreSection;
		return appendPromptResources(prompt, {
			appendSection,
			contextFiles,
			skills,
			extensions: options.extensions ?? [],
			visibleTools,
			fullPrompt,
			leanPrompt,
			hasRead,
			date,
			promptCwd,
			modelCapability: options.modelCapability,
		});
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

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
	const hasPowerShell = activeTools.includes("powershell");
	const hasGrep = activeTools.includes("grep");
	const hasFind = activeTools.includes("find");
	const hasLs = activeTools.includes("ls");
	const hasReadOnlyTools = hasRead || hasGrep || hasFind || hasLs;

	// File exploration guidelines
	if (!fullPrompt && !leanPrompt) {
		if (hasPowerShell) addGuideline("Use powershell for Windows shell commands");
		else if (hasBash) addGuideline("Use bash for bounded shell commands");
		if (hasReadOnlyTools) addGuideline("Batch independent reads; keep mutations and dependent calls ordered");
	} else if (hasPowerShell && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use powershell for shell commands on Windows; prefer rg for search and Get-ChildItem for listing");
	} else if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}
	if (fullPrompt || leanPrompt) {
		if (hasBash || hasGrep || hasFind) {
			addGuideline(
				"Use scoped rg to filter text and jq to project JSON: pass explicit roots and filters, inspect only selected records natively, and route unavoidable exhaustive output to a file",
			);
		}
		if (hasPython) {
			addGuideline(
				"Use python for bounded scripts and data shaping when clearer than shell; use read/edit/write for exact source edits",
			);
		}
		if (hasReadOnlyTools) {
			addGuideline(
				"Issue independent read-only tool calls together in one assistant turn. Keep dependent calls, mutations, and stateful commands ordered",
			);
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
		? "You are Pi-Adaptative, a self-evolving assistant. Complete and deliver the user’s goals within granted authority; preserve continuity through compaction and own the integrated result."
		: leanPrompt
			? "You are Pi-Adaptative's bounded coding agent. Complete the current goal with the active surface and preserve enough evidence for handoff."
			: capabilityClass === "minimal"
				? "You are Pi-Adaptative's focused coding executor. Complete one scoped task with active tools and report verified results."
				: "You are Pi-Adaptative's concise chat assistant. No execution tools are active.";
	const toolSurfaceRule =
		fullPrompt || leanPrompt
			? "Use only capabilities present in the active tool surface; others may exist in the environment."
			: "Use only the active tool surface.";
	let prompt = `${introduction}

Available tools:
${toolsList}

${toolSurfaceRule}${coreSection}${toolGuidelinesSection}`;

	if (fullPrompt) {
		prompt += `

PI-ADAPTATIVE DOCUMENTATION

Only when asked about Pi-Adaptative, read the relevant files completely from:
- Main documentation: ${readmePath}
- Additional documentation: ${docsPath}
- Examples: ${examplesPath}

Resolve \`docs/...\` and \`examples/...\` from those roots and follow relevant Markdown cross-references before implementing.`;
	}

	return appendPromptResources(prompt, {
		appendSection,
		contextFiles,
		skills,
		extensions: options.extensions ?? [],
		visibleTools,
		fullPrompt,
		leanPrompt,
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

	const lines = ["\n\nThe following extensions are currently loaded and active:", "", "<active_extensions>"];
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

		lines.push("  <extension>");
		lines.push(`    <name>${escapePromptXml(name)}</name>`);
		if (description) {
			lines.push(`    <description>${escapePromptXml(description)}</description>`);
		}
		lines.push(`    <path>${escapePromptXml(ext.path)}</path>`);

		if (tools.length > 0) {
			lines.push(`    <registered_tools>${tools.map(escapePromptXml).join(", ")}</registered_tools>`);
		}
		if (commands.length > 0) {
			lines.push(`    <registered_commands>${commands.map(escapePromptXml).join(", ")}</registered_commands>`);
		}
		lines.push("  </extension>");
		added++;
	}

	if (added === 0) {
		return "";
	}

	lines.push("</active_extensions>");
	return lines.join("\n");
}
