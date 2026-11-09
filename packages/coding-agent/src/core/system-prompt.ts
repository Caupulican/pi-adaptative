/**
 * System prompt construction and project context loading
 */

import { TOOL_FAILURE_RETRY_MODEL_RULE } from "../kernel/index.ts";
import { getExtensionDescription, getExtensionDisplayName } from "./extension-metadata.ts";
import type { BuildSystemPromptOptions, Extension } from "./extensions/types.ts";
import { enforceModelCapabilitySystemPromptBudget } from "./model-capability.ts";
import {
	normalizeSteStrictness,
	ORIENTATION_SURVEY_RULE,
	OWNER_AUTHORIZATION_RULE,
	renderExplanationStyleRule,
	rootDirectorRolePrompt,
} from "./provider-prompt-contracts.ts";
import { LOOKUP_TOOL_NAME } from "./tools/lookup-tool-name.ts";
import { PLAN_TOOL_NAME } from "./tools/plan-tool-name.ts";
import { TOOL_BRIDGE_CLIENT_MODULE } from "./tools/tool-bridge-policy.ts";
import { workspaceSnapshotLine } from "./workspace-snapshot.ts";

export { OWNER_AUTHORIZATION_RULE };

const OUTPUT_POLICY = `

OUTPUT
- Terse, in the user's language: fragments, each fact once.
- No filler, self-reference, tool narration or emoji.
- Keep not/never/no/only/except and exact identifiers, numbers, commands, errors.
- Full grammar for security, irreversible actions, ambiguous order.
- Never answer with harness protocol or failure JSON.
- Analysis, review, evaluation: complete and structured (D decisions, O options, F findings, R risks, Q questions, A actions).
- Complex content (diagrams, comparisons, tables): an HTML page (skill explain-html).
- An explicit instruction in the current message overrides this style.`;

const piAdaptativeCoreSection = (extraPrinciples: readonly string[]): string => `

PRINCIPLES
- Pursue the request with creativity, up to its root:
  - Interrogate yourself before acting: do I know enough to deliver a truly valuable result? If not, find out by reading, searching, measuring.
  - Work out what the request is for, trace it to the cause, and finish the outcome, not the literal words.
  - When the obvious route is blocked, find another route to the same goal.
  - Failing check. Expected: find and fix the cause. Bad: loosen or skip the check.
  - "Make it faster". Expected: measure, find the hot spot, fix it. Bad: add a cache that hides it.
  - A defect in one place. Expected: fix it and the same defect elsewhere. Bad: patch only the reported line.
  - A tool or path refused. Expected: reach the goal another way. Bad: stop and report it cannot be done.
- Apply judgement: scale the effort to the certainty and the risk.
  - Cause known (a missing comma). Expected: fix it and run the quick check. Bad: build tooling, tests or a new app to prove it breaks.
  - Cause unknown or change risky. Expected: reproduce or inspect first. Bad: ship a guess.
- ${OWNER_AUTHORIZATION_RULE}
- State only what you verified; label the rest inferred or guess.${extraPrinciples.map((principle) => `\n- ${principle}`).join("")}`;

const PI_ADAPTATIVE_LEAN_CORE_SECTION = `

OPERATING CONTRACT

- Complete current goal within scope, granted authority; keep progress, evidence concise.
- Inspect relevant files and instructions before editing; make minimal coherent change, run focused checks.
- Use active tools/schemas. On failure, follow error guidance. ${TOOL_FAILURE_RETRY_MODEL_RULE}
- Emit independent calls in one message; order dependent/mutating/stateful calls; report real output, unresolved failures.
- ${OWNER_AUTHORIZATION_RULE}`;

const PI_ADAPTATIVE_MINIMAL_CORE_SECTION = `

EXECUTION RULES

- One scoped task: inspect before small coherent edits; run narrowest useful check.
- Listed tools/schemas only; follow failure guidance. ${TOOL_FAILURE_RETRY_MODEL_RULE}
- Batch independent calls in one message; order dependent/mutating/stateful calls. Report actual results; never claim incomplete actions as done.
- ${OWNER_AUTHORIZATION_RULE}`;

const PI_ADAPTATIVE_CHAT_CORE_SECTION = `

CHAT RULES

- Answer concisely from conversation; state uncertainty.
- No execution tools are active. Do not claim to read files, run commands, or make changes.
- Say when the request requires a tool-capable model or additional user-provided context.

REFERENCE POINTS
D decisions. O options. F findings. R risks. Q questions. A actions. Invent letters only for missing sections; keep codes; do not code short answers.`;

const LOOKUP_BATCH_RULE = `Use \`${LOOKUP_TOOL_NAME}\` for 2 or more independent reads, searches or listings: one call, one round.`;
const SCRIPT_TOOLS_RULE = `For 3 or more dependent or bulk tool calls (search, read the matches, edit them), run one \`python\` script with \`tools\` that calls them through \`${TOOL_BRIDGE_CLIENT_MODULE}\` and prints only what you need.`;

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

export function formatContextFilesForPrompt(
	contextFiles: ReadonlyArray<{ path: string; content?: string }>,
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
		omitDate?: boolean;
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
	// ICM continuous chat carries current time in its per-turn state message instead of the system prompt.
	if (!options.omitDate) {
		result += `\n\nCurrent date: ${options.date}`;
	}
	// Constrained prompt budgets must not depend on host path length. Chat has no filesystem
	// tools. Lean's envelope is too tight for Windows/temp cwd variation; tools still
	// receive cwd at runtime. Full and minimal keep the path.
	if (options.modelCapability?.class !== "chat" && options.modelCapability?.class !== "lean") {
		result += `\nCurrent working directory: ${options.promptCwd}`;
		result += workspaceSnapshotLine(options.promptCwd);
	}
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
/** The local Y-M-D date a system prompt states. */
export function promptDate(now: Date): string {
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

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
	const date = options.date ?? promptDate(new Date());

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const capabilityClass = options.modelCapability?.class ?? "full";
	const fullPrompt = capabilityClass === "full";
	const leanPrompt = capabilityClass === "lean";

	const activeTools = selectedTools || ["read", "bash", "python", "edit", "write"];
	const visibleTools = activeTools.filter((name) => !!toolSnippets?.[name]);
	const hasRead = activeTools.includes("read");
	const coreSection = fullPrompt
		? piAdaptativeCoreSection(options.principles ?? [])
		: leanPrompt
			? PI_ADAPTATIVE_LEAN_CORE_SECTION
			: capabilityClass === "minimal"
				? PI_ADAPTATIVE_MINIMAL_CORE_SECTION
				: PI_ADAPTATIVE_CHAT_CORE_SECTION;
	const explanationStyle = renderExplanationStyleRule(normalizeSteStrictness(options.steStrictness));
	const styleContract =
		capabilityClass === "chat"
			? explanationStyle
				? `\n\n${explanationStyle}`
				: ""
			: `${OUTPUT_POLICY}${explanationStyle ? `\n- ${explanationStyle}` : ""}`;
	const scopeContract = capabilityClass === "chat" || fullPrompt ? "" : `\n- ${ORIENTATION_SURVEY_RULE}`;
	// Told only where the tool is active: the host rejects a call to a tool that is not.
	const lookupRule =
		capabilityClass !== "chat" && activeTools.includes(LOOKUP_TOOL_NAME) ? `\n- ${LOOKUP_BATCH_RULE}` : "";
	const scriptToolsRule =
		capabilityClass !== "chat" && activeTools.includes("python") ? `\n- ${SCRIPT_TOOLS_RULE}` : "";
	const operatingContract = `${coreSection}${lookupRule}${scriptToolsRule}${scopeContract}${styleContract}`;

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
			omitDate: options.omitDate,
			promptCwd,
			modelCapability: options.modelCapability,
		});
	}

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

	// Constrained profiles get one shell hint; full and lean rely on the tool texts and the host's output routing.
	if (!fullPrompt && !leanPrompt && activeTools.includes("bash")) {
		addGuideline("Use bash for bounded shell commands");
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
	const toolGuidelinesSection = guidelines.length > 0 ? `\n\nTOOL GUIDELINES\n${guidelines}` : "";

	const introduction = fullPrompt
		? `You are "${options.agentName ?? "Pi-Adaptative"}", a creative, self-evolving agent.${options.soul ? `\n${options.soul}` : ""}${options.missingSoulPath ? `\n- No soul exists at ${options.missingSoulPath}: when memory and sessions show who you are, write it.\n- Format: front matter name:, then plain prose on who you are and how you work; never tasks or secrets.` : ""}`
		: leanPrompt
			? "Pi-Adaptative bounded coding agent. Complete current goal with active surface; preserve handoff evidence."
			: capabilityClass === "minimal"
				? "Pi-Adaptative focused coding executor. Complete one scoped task; report verified results."
				: "Pi-Adaptative concise chat assistant. No execution tools active.";
	// The plan lines are told only where the tool is active, like the lookup rule.
	const directorRole =
		fullPrompt && options.directorRole === true
			? `\n\n${rootDirectorRolePrompt({ plan: activeTools.includes(PLAN_TOOL_NAME) })}`
			: "";
	// The host rejects calls to tools that are not active, so only the constrained classes are told.
	const toolSurfaceRule = fullPrompt
		? ""
		: leanPrompt
			? "Use active tool surface only; unlisted capabilities may exist."
			: "Use only the active tool surface.";
	const prompt = `${introduction}${directorRole}

Available tools:
${toolsList}${toolSurfaceRule ? `\n\n${toolSurfaceRule}` : ""}${operatingContract}${toolGuidelinesSection}`;

	return appendPromptResources(prompt, {
		appendSection,
		contextFiles,
		extensions: options.extensions ?? [],
		visibleTools,
		fullPrompt,
		hasRead,
		date,
		omitDate: options.omitDate,
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
