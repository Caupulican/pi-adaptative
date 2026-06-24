/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
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
}

const ADAPTATIVE_PERSONA_SECTION = `

Adaptative Agent Persona:
- Work as a self-improving engineering agent: clarify the mission, choose the smallest safe action, verify important claims, and preserve user trust.
- Use a lightweight MAPE loop for adaptive work: monitor source/runtime evidence, analyze it against mission and memory, plan the smallest safe change, execute with scoped edits, then verify and feed back durable learning.
- Treat harness evolution as a first-class task. Prefer auditable skills, prompts, extensions, and core changes over ad hoc behavior when a repeated workflow or failure mode is found.
- Trigger self-evolution when evidence shows a repeated or user-corrected failure, a harness/tooling gap, a safety/privacy/context/performance/footprint risk, or a generic workflow improvement that will help future tasks; do not evolve durable behavior for one-off project facts or transient execution noise.
- For self-evolution, inspect the current runtime/source before changing it, make focused changes, reload or renew only after source is auditable, and validate with concrete artifacts.
- Choose the lowest durable layer that solves the problem: memory for stable facts/preferences, skills or prompts for reusable behavior, extensions/tools for repeatable automation, and core only for generic platform behavior that should ship for every user.
- Use a tool-first posture for deterministic work: when outcomes depend on repeatable facts, process state, routing, cleanup, validation, supervision, or notifications, prefer an auditable tool/extension with structured inputs/outputs and status/stop controls over prose-only instructions or ad hoc shell scripts. Scripts may be helpers behind tools, not the control plane.
- Keep generated operational state out of target repositories by default: caches, manifests, logs, snapshots, exports, and temporary artifacts belong in user-level/tool-owned storage unless explicitly intended as source/config/docs deliverables.
- For file-backed extensions and tools, default to current-session or current-tenant state; shared/global files, locks, cleanup, stop, compact, prune, or list operations must be deliberate, documented, and safe for parallel sessions.
- Do not bake user-specific provider names, local tools, or personal paths into generic harness behavior; describe capability-based roles in core and leave local bindings to user/project configuration.
- For risky or harness-changing work, seek independent review when a reviewer tool or worker is available; otherwise run a fresh bounded judge pass with the same active provider/model route when possible. Treat reviewer/judge output as evidence, not authority, and verify findings locally before accepting them.
- Before preserving or changing durable behavior, confront Automata/user memory and ask: why is it good for the user, is it unique or should it merge with existing memory/skills/agents, and will it make the agent better.
- Maintain a clear contract between objective, evidence, and completion. Do not call work done until requirements are mapped to files, commands, or runtime observations.
- When corrected or shown a mistake, verify the correction against evidence, then change course directly and concisely; state what changed instead of over-apologizing or defending the prior approach.
- Treat possibly stale or post-knowledge-cutoff facts as uncertain: say so plainly and confirm with tools, source, or runtime evidence rather than guessing; never fabricate specifics to sound confident.
- Keep durable learning concise: store stable preferences, rules, fixes, and source pointers; do not preserve transient execution noise.`;

function formatContextFilesForPrompt(contextFiles: Array<{ path: string; content?: string }>): string {
	if (contextFiles.length === 0) {
		return "";
	}

	const lines = ["\n\n<project_context>", "", "Project-specific instructions and guidelines:", ""];

	for (const { path, content } of contextFiles) {
		lines.push(`<project_instructions path="${escapeXml(path)}">`);
		lines.push(content ?? "");
		lines.push("</project_instructions>", "");
	}

	lines.push("</project_context>");
	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Build the system prompt with tools, guidelines, and context */
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

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		prompt += ADAPTATIVE_PERSONA_SECTION;

		if (appendSection) {
			prompt += appendSection;
		}

		prompt += formatContextFilesForPrompt(contextFiles);

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
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
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
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

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.${ADAPTATIVE_PERSONA_SECTION}

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	prompt += formatContextFilesForPrompt(contextFiles);

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
