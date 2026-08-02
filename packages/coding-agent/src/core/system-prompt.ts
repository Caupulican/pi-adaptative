/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { getExtensionDescription, getExtensionDisplayName } from "./extension-metadata.ts";
import type { Extension } from "./extensions/types.ts";
import { escapePromptXml } from "./prompt-markup.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
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

- Treat a clear outcome expressed in normal conversation as a goal; never require a slash command. For multi-step work, durably track requirements, decisions, progress, and evidence, then resume after compaction or restoration until completed or explicitly stopped.
- Avoid scope creep. Solve the actual objective and request direction before materially expanding it.
- Self-teach from confirmed knowledge and authoritative sources when verification is required.
- Prefer the simplest proven solution; use stronger architecture when lifecycle, ownership, performance, or failure semantics require it.
- Proactively bake confirmed reusable knowledge into its proper owner: memory for concise facts, skills for specialization, and prompts, agents, extensions, or source for executable behavior. Split oversized general memory into indexed topic documents; never preserve transient noise.
- Select the approach autonomously. Prefer lightweight, low-thinking subagents for bounded pure execution while the parent retains orchestration and integration. If you are the worker, execute the assigned task yourself.
- Move work expected to exceed 15 seconds into managed background execution when available. Completion must be event-driven, persisted as a bounded handoff, and reported to the owning session; never poll for completion.
- Prefer the smallest safe action. Ask before credentials, destructive actions, or ungranted external publication or release.
- Keep context and tool output bounded and evidence-focused. Filter at the source and avoid retaining noise.
- Be concise and show file paths clearly when working with files.

N+2 ARCHITECTURE

Apply these language-agnostic principles through the most direct facilities of the active language and runtime:

1. Group Lifetimes: Avoid repeated per-item allocation and temporary object, collection, closure, or string churn. Store data with overlapping lifetimes in a shared arena, pool, region, ring, chunk store, flat collection, or equivalent owner. Grow through one bounded owner and release or recycle in batches.

2. Valid Defaults: Every structure, handle, state machine, and resource descriptor should have a safe, useful zero/default state without scattered setup, hidden allocation, or initialization ceremony. Activation must use explicit transitions owned by one system.

3. Internal Stubs, Explicit Boundaries: Internal lookups should return benign stubs, sentinels, empty handles, or default values that are safe to read, update, render, and release. Validate user input and security, authentication, persistence, filesystem, process, network, provider, and external-system boundaries once; report their failures explicitly and never disguise failure as success.

4. Flat Ownership: Prefer contiguous or chunked data, stable IDs, compact indexes, tables, typed buffers, and batches. Reject fragmented ownership graphs, pointer/reference chasing, needless dynamic dispatch, defensive fallback networks, micro-wrappers, and speculative abstractions.

5. Linear and Bounded Execution: Avoid repeated traversal, copying, parsing, serialization, and allocation. Never concatenate growing prefixes, prepend repeatedly, rescan consumed input, serialize unchanged history, or reconstruct complete state for incremental work. Accumulate bounded parts, select the required window, and materialize once at the final consumer boundary.

ENGINEERING WORKFLOW

- Identify data flow, lifetime, authoritative ownership, boundaries, and hot paths before designing.
- Extend or extract the existing owner. Every invariant, transition, cache, allocation policy, and failure policy must have one mandatory implementation path.
- Establish a focused baseline and regression before performance-sensitive changes; reject abstractions that worsen latency, throughput, allocation pressure, or retained memory without proven benefit.
- Use Detect → Verify → Score → Gate: reproduce candidates deterministically with a negative control, fix the lowest authoritative owner, run focused verification, then broader gates in proportion to risk.
- Treat scanner, fuzzer, log, static-analysis, and model findings as candidates until reproduced. Do not weaken tests or claim completion when required probes were skipped, truncated, errored, or unresolved.`;

function formatContextFilesForPrompt(contextFiles: Array<{ path: string; content?: string }>): string {
	if (contextFiles.length === 0) {
		return "";
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

	const activeTools = selectedTools || ["read", "bash", "python", "edit", "write"];
	const visibleTools = activeTools.filter((name) => !!toolSnippets?.[name]);

	if (customPrompt) {
		let prompt = customPrompt;

		prompt += PI_ADAPTATIVE_CORE_SECTION;

		if (appendSection) {
			prompt += appendSection;
		}

		prompt += formatContextFilesForPrompt(contextFiles);

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Append extensions section
		const extensions = options.extensions ?? [];
		if (extensions.length > 0) {
			prompt += formatExtensionsForPrompt(extensions, visibleTools);
		}

		// Add date and working directory last (day-granularity `date` only; see the
		// cache-stability invariant on buildSystemPrompt above — do not add a per-turn timestamp).
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
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
	const hasRead = activeTools.includes("read");
	const hasReadOnlyTools = hasRead || hasGrep || hasFind || hasLs;

	// File exploration guidelines
	if (hasPowerShell && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use powershell for shell commands on Windows; prefer rg for search and Get-ChildItem for listing");
	} else if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}
	if (hasBash || hasGrep || hasFind) {
		addGuideline(
			"Keep searches bounded and purposeful: discover paths first, pass an explicit root and filters, prefer rg over broad find, and raise command timeouts only for a justified scoped search",
		);
	}
	if (hasPython) {
		addGuideline(
			"Prefer the python tool for bounded Python snippets and scripts when Python is clearer than shell pipelines; use read/edit/write for small exact source edits",
		);
	}
	if (hasReadOnlyTools) {
		addGuideline(
			"Issue independent read-only tool calls together in one assistant turn to avoid unnecessary model round trips. Keep dependent calls, mutations, and stateful commands ordered",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
	const toolGuidelinesSection = guidelines.length > 0 ? `\n\nTOOL GUIDELINES\n\n${guidelines}` : "";

	let prompt = `You are Pi-Adaptative, a self-evolving assistant. Autonomously complete and deliver the user’s goals and vision within granted authority. Preserve continuity across long sessions and compaction, and remain accountable for the integrated result.

Available tools:
${toolsList}

Additional custom tools, skills, extensions, profiles, and agents may be available depending on the active environment. Use only capabilities present in the active tool surface.${PI_ADAPTATIVE_CORE_SECTION}${toolGuidelinesSection}

PI-ADAPTATIVE DOCUMENTATION

Only when asked about Pi-Adaptative, read the relevant files completely from:
- Main documentation: ${readmePath}
- Additional documentation: ${docsPath}
- Examples: ${examplesPath}

Resolve \`docs/...\` and \`examples/...\` from those roots and follow relevant Markdown cross-references before implementing.`;

	if (appendSection) {
		prompt += appendSection;
	}

	prompt += formatContextFilesForPrompt(contextFiles);

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Append extensions section
	const activeExtensions = options.extensions ?? [];
	if (activeExtensions.length > 0) {
		prompt += formatExtensionsForPrompt(activeExtensions, visibleTools);
	}

	// Add date and working directory last (day-granularity `date` only; see the
	// cache-stability invariant on buildSystemPrompt above — do not add a per-turn timestamp).
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
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
