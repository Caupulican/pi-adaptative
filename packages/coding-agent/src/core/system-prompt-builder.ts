/**
 * Session system-prompt construction.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the assembly of the
 * session's base system prompt from live session state — the active profile's situational soul, the
 * self-modification and autonomy guardrail blocks, the memory block, the loader's custom/append
 * prompts, and the per-tool snippet/guideline surface — into the {@link BuildSystemPromptOptions}
 * that the pure {@link buildSystemPrompt} renderer (core/system-prompt.ts, a different job: the
 * stateless string builder) consumes. Holds the last-built `_baseSystemPromptOptions` so a
 * before_agent_start extension hook can read it. Takes narrow accessor deps (each read fresh, since
 * several collaborators — tool registries, memory manager, extension runner — are reassigned across
 * the session lifecycle) rather than the whole AgentSession.
 */

import { existsSync } from "node:fs";
import { resolvePath } from "../utils/paths.ts";
import type { AgentIdentity } from "./agent-identity.ts";
import { estimateTokensFromChars } from "./context/context-item.ts";
import { resolveMemoryPromptBudget } from "./context/memory-prompt-budget.ts";
import type { BuildSystemPromptOptions, Extension } from "./extensions/types.ts";
import type { MemoryManager } from "./memory/memory-manager.ts";
import { ICM_MEMORY_GUIDANCE } from "./memory/providers/icm.ts";
import {
	enforceModelCapabilitySystemPromptBudget,
	MODEL_CAPABILITY_TOOL_GUIDELINES_MAX_CHARS,
	type ModelCapabilityProfile,
} from "./model-capability.ts";
import type { ModelAdaptationRule } from "./models/adaptation-store.ts";
import { buildProjectInstructionIsolationPrompt } from "./project-instruction-isolation.ts";
import { CHAT_WORK_LIFECYCLE_SYSTEM_RULE } from "./provider-prompt-contracts.ts";
import { normalizeProviderPromptGuidelines, normalizeProviderPromptSnippet } from "./provider-tool-text.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { MemorySystem, ResolvedWorkerDelegationSettings } from "./settings/settings-schema.ts";
import { buildSystemPrompt, promptDate } from "./system-prompt.ts";
import { formatToolSelectionHints, type ToolSelectionHint } from "./tool-selection/promotion.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "./util/timer-port.ts";

/**
 * The line a run that carries a third party's words reads where the owner's memory block stands in the prompt (see
 * `SystemPromptBuilder.withholdMemory`).
 */
export const THIRD_PARTY_MEMORY_WITHHELD = "MEMORY: withheld from this run, which carries a third party's words.";

/** The memory blocks and projected prompts a builder keeps: one block per budget, a few prompts per tool surface. */
const MAX_WITHHELD_ENTRIES = 8;

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface SystemPromptBuilderSettingsSource {
	getActiveProfileSoul(): string | undefined;
	getMemorySystem(): MemorySystem;
	getProjectContextFiles(): "on-demand" | "off";
	getSelfModificationSettings(): { enabled: boolean; sourcePath?: string; sourcePaths?: string[] };
	getSteStrictness(): number;
	getWorkerDelegationSettings(): ResolvedWorkerDelegationSettings;
}

export interface SystemPromptBuilderDeps {
	/** The session's working directory (read fresh; base for self-modification source resolution). */
	getCwd(): string;
	/** The session's settings manager — soul, self-modification, autonomy, and auto-learn settings. */
	getSettingsManager(): SystemPromptBuilderSettingsSource;
	/** The session's resource loader — custom/append system prompts and agents files. */
	getResourceLoader(): ResourceLoader;
	/** The session's memory manager — the static, frozen-per-session memory system-prompt block. */
	getMemoryManager(): MemoryManager;
	/** Whether a tool name is currently registered on the session. */
	hasTool(name: string): boolean;
	/** The one-line prompt snippet registered for a tool, if any. */
	getToolPromptSnippet(name: string): string | undefined;
	/** The extra guideline bullets registered for a tool, if any. */
	getToolPromptGuidelines(name: string): string[] | undefined;
	/** The standing tool-shape rules learned for the session's current model. */
	getModelAdaptationRules(): readonly ModelAdaptationRule[];
	/**
	 * The evidence-gated tool-selection hints active for the session's current model (see
	 * `tool-selection/promotion.ts` and `ToolSelectionController.getActiveHints`). Optional: a
	 * session that has not wired a `ToolSelectionController` into this builder simply renders no
	 * hint block, same as an empty list. The evidence moves with every observed tool call, so the
	 * builder freezes the hints at its first build (and again when the model changes): a rebuild
	 * mid-session must not move bytes of the single cached system prompt block (see system-prompt.ts).
	 */
	getToolSelectionHints?(): readonly ToolSelectionHint[];
	/** The session's currently active extensions. */
	getActiveExtensions(): ReadonlyArray<Extension>;
	/** The authoritative profile used by tools, lanes, and stable prompt shaping. */
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Child/worker sessions never receive root autonomy or reflection instructions. */
	isChildSession(): boolean;
	/**
	 * The owner's replacement for the whole generated prompt, scoped to this session. Read fresh on
	 * every build so each rebuild path (tool surface change, routed turn, refresh) honors it.
	 */
	getSystemPromptOverride?(): string | undefined;
	/** The agent's identity (soul.md). Read once per builder so the cached prompt prefix stays stable. */
	getAgentIdentity?(): AgentIdentity;
	/** The clock the prompt's date is read from (the session's `system-prompt` timer owner); the system clock if omitted. */
	promptClock?: Pick<TimerPort, "now">;
}

export function collectSelfModificationSourceCandidates(settings: {
	sourcePath?: string;
	sourcePaths?: string[];
}): string[] {
	const candidates: string[] = [];
	if (Array.isArray(settings.sourcePaths)) {
		for (const candidate of settings.sourcePaths) {
			const normalized = candidate?.trim();
			if (normalized) candidates.push(normalized);
		}
	}
	const legacyCandidate = settings.sourcePath?.trim();
	if (legacyCandidate) candidates.push(legacyCandidate);
	return candidates;
}

/**
 * Constrained profiles admit tool guidance in priority rounds: every tool's first rule is
 * considered before any tool's second. Tool definitions already list mandatory guidance first;
 * this prevents an early verbose tool from starving a later security or authorization rule.
 */
function collectPromptGuidelines(
	groups: readonly (readonly string[])[],
	maxRenderedChars: number | undefined,
): string[] {
	if (maxRenderedChars === undefined) return groups.flat();

	const accepted: string[] = [];
	const seen = new Set<string>();
	let renderedChars = 0;
	for (let priority = 0; ; priority++) {
		let foundCandidate = false;
		for (const group of groups) {
			const guideline = group[priority]?.trim();
			if (!guideline) continue;
			foundCandidate = true;
			if (seen.has(guideline)) continue;
			seen.add(guideline);

			// "- " plus the separating newline. Charging three for the first bullet too is a
			// conservative upper bound and keeps the policy independent of renderer position.
			const candidateChars = guideline.length + 3;
			if (renderedChars + candidateChars > maxRenderedChars) continue;
			accepted.push(guideline);
			renderedChars += candidateChars;
		}
		if (!foundCandidate) break;
	}
	return accepted;
}

export class SystemPromptBuilder {
	private readonly deps: SystemPromptBuilderDeps;
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	/** The date every prompt this session builds states, pinned until `advancePromptDate` at a cold moment. */
	private _promptDate: string | undefined;
	private _agentIdentity: AgentIdentity | undefined;
	/** Every owner memory block this builder rendered, oldest first (bounded). */
	private readonly _memoryBlocks: string[] = [];
	/** Owner prompt to its withheld variant, for the prompts projected most recently (bounded, least recent first). */
	private readonly _withheld = new Map<string, string>();

	constructor(deps: SystemPromptBuilderDeps) {
		this.deps = deps;
	}

	private _promptNow(): Date {
		return new Date((this.deps.promptClock ?? SYSTEM_TIMER_PORT).now());
	}

	/** Move the pinned date to today; true when it changed (the caller rebuilds the base prompt). */
	advancePromptDate(now: Date = this._promptNow()): boolean {
		if (this.isIcmMode()) return false;
		const today = promptDate(now);
		if (this._promptDate === today) return false;
		const changed = this._promptDate !== undefined;
		this._promptDate = today;
		return changed;
	}

	/** The options used to render the last base prompt — read by a before_agent_start extension hook. */
	getBaseSystemPromptOptions(): BuildSystemPromptOptions {
		return this._baseSystemPromptOptions;
	}

	/** Recheck the final prompt after extension and routed-turn overrides, immediately before use. */
	enforceSystemPromptBudget(systemPrompt: string): string {
		return enforceModelCapabilitySystemPromptBudget(systemPrompt, this.deps.getModelCapabilityProfile());
	}

	normalizePromptSnippet(text: string | undefined): string | undefined {
		return normalizeProviderPromptSnippet(text);
	}

	normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		return normalizeProviderPromptGuidelines(guidelines);
	}

	/**
	 * R6: the active profile's situational soul, wrapped so the model reads it as its identity for this
	 * situation. Empty when no active profile defines a soul.
	 */
	private _buildSituationSoulPrompt(): string | undefined {
		// An agent of its own carries its soul and its memory here, where every capability class renders them, and takes no
		// situational soul.
		const identity = this._agentIdentity;
		if (identity?.standalone) {
			const parts = [identity.soul ? `SOUL\n${identity.soul}` : undefined, identity.memory].filter(Boolean);
			return parts.length > 0 ? parts.join("\n\n") : undefined;
		}
		const soul = this.deps.getSettingsManager().getActiveProfileSoul();
		if (!soul) return undefined;
		return `SITUATION SOUL\n${soul}`;
	}

	private _buildSelfModificationPrompt(profile: ModelCapabilityProfile): string | undefined {
		const settings = this.deps.getSettingsManager().getSelfModificationSettings();
		const cwd = this.deps.getCwd();
		const inSourceCheckout =
			existsSync(resolvePath("package.json", cwd)) &&
			existsSync(resolvePath("packages/coding-agent/package.json", cwd));
		if (!settings.enabled && !inSourceCheckout) {
			return undefined;
		}

		// Resolve from an ordered candidate list first (portable WSL/Termux switching
		// from settings alone), then fall back to the legacy single sourcePath.
		const rawCandidates = collectSelfModificationSourceCandidates(settings);
		if (rawCandidates.length === 0 && inSourceCheckout) {
			rawCandidates.push(cwd);
		}

		if (rawCandidates.length === 0) {
			return "Self-modification: enabled but sourcePaths/sourcePath is missing. Do not modify core/runtime output; ask for the source checkout path.";
		}

		const resolvedCandidates = rawCandidates.map((candidate) =>
			resolvePath(candidate, this.deps.getCwd(), { trim: true }),
		);
		const sourcePath =
			resolvedCandidates.find(
				(candidate) => existsSync(candidate) && existsSync(resolvePath("package.json", candidate)),
			) ?? resolvedCandidates[0];
		const sourceLooksValid = existsSync(sourcePath) && existsSync(resolvePath("package.json", sourcePath));
		const sourceStatus = sourceLooksValid
			? sourcePath
			: `${sourcePath} (invalid source checkout; user must correct \`selfModification.sourcePaths\` before editing)`;
		if (profile.class === "minimal") {
			return `SELF-MODIFICATION: edit core only under ${sourceStatus}. Smallest change; validate.`;
		}
		if (profile.class !== "full") {
			return `SELF-MODIFICATION: edit core only under ${sourceStatus}. Inspect first; preserve concurrent work; smallest auditable change; focused validation. Use runtime_update to reload or restart.`;
		}
		return `Self-modification: source ${sourceStatus}; edit core/harness only there, never installed or generated output; runtime_update only after saved evidence.`;
	}

	private _buildStaticMemoryPrompt(profile: ModelCapabilityProfile, availableChars?: number): string | undefined {
		// ICM mode: avoid reading legacy MEMORY.md/USER.md/OKF bodies automatically; install frozen ICM catalog.
		if (this.isIcmMode()) {
			return this.deps.getMemoryManager?.().freezeSystemPromptBlock?.() || ICM_MEMORY_GUIDANCE;
		}
		let budget =
			profile.class !== "full" && profile.contextWindow !== undefined
				? resolveMemoryPromptBudget({ contextWindow: profile.contextWindow, configuredMaxResults: 3 })
				: undefined;
		if (availableChars !== undefined) {
			// Forced constrained profiles can have no known context window. The measured
			// prompt capacity still bounds memory; it is not an inferred context window.
			budget = budget
				? { ...budget, maxChars: Math.min(budget.maxChars, availableChars) }
				: {
						enabled: true,
						compact: false,
						maxChars: availableChars,
						maxLines: availableChars + 1,
						maxEstimatedTokens: estimateTokensFromChars(availableChars),
						maxResults: 3,
					};
		}
		const block = this.deps.getMemoryManager().freezeSystemPromptBlock(budget) || undefined;
		if (block !== undefined && !this._memoryBlocks.includes(block)) {
			this._memoryBlocks.push(block);
			if (this._memoryBlocks.length > MAX_WITHHELD_ENTRIES) this._memoryBlocks.shift();
			this._withheld.clear();
		}
		return block;
	}

	/**
	 * `prompt` without the owner's memory: each memory block this builder rendered, where the prompt carries it after its
	 * separator, becomes {@link THIRD_PARTY_MEMORY_WITHHELD} (or nothing when that line would be longer than the block),
	 * so the variant is never longer than the owner's prompt and fits its budget. The same prompt always projects to the
	 * same text, so owner and third-party runs that alternate each reuse their own cached prefix. A prompt that carries
	 * no block (an ICM prompt, whose block holds no owner records, or a prompt with no memory) is returned as is.
	 */
	withholdMemory(prompt: string): string {
		const known = this._withheld.get(prompt);
		if (known !== undefined) {
			this._withheld.delete(prompt);
			this._withheld.set(prompt, known);
			return known;
		}
		let projected = prompt;
		for (const block of [...this._memoryBlocks].sort((left, right) => right.length - left.length)) {
			const line = THIRD_PARTY_MEMORY_WITHHELD.length <= block.length ? `\n\n${THIRD_PARTY_MEMORY_WITHHELD}` : "";
			projected = projected.split(`\n\n${block}`).join(line);
		}
		this._withheld.set(prompt, projected);
		if (this._withheld.size > MAX_WITHHELD_ENTRIES) {
			const oldest = this._withheld.keys().next().value;
			if (oldest !== undefined) this._withheld.delete(oldest);
		}
		return projected;
	}

	/** Whether `prompt` is a variant {@link withholdMemory} produced lately that differs from its owner prompt. */
	isMemoryWithheld(prompt: string): boolean {
		for (const [owner, projected] of this._withheld) if (projected === prompt && projected !== owner) return true;
		return false;
	}

	private _buildModelAdaptationPrompt(): string | undefined {
		const rules = this.deps.getModelAdaptationRules();
		if (rules.length === 0) return undefined;
		const lines = rules.map((rule) => `- ${rule.text}`);
		return `MODEL TOOL SHAPE RULES\n${lines.join("\n")}`;
	}

	/**
	 * The session's hints, frozen at the first build. Live evidence changes on every observed tool call, and each
	 * rebuild of the base prompt re-read it, moving a mid-prompt section and invalidating the provider's cached prefix
	 * from there on. A model change refreshes them, since the evidence is per model; new evidence otherwise applies
	 * from the next session.
	 */
	private _frozenToolSelectionHints: { modelRef: string | undefined; hints: readonly ToolSelectionHint[] } | undefined;

	private _sessionToolSelectionHints(): readonly ToolSelectionHint[] {
		const current = this.deps.getToolSelectionHints?.() ?? [];
		const frozen = this._frozenToolSelectionHints;
		const currentModelRef = current[0]?.modelRef;
		const modelChanged =
			frozen?.modelRef !== undefined && currentModelRef !== undefined && frozen.modelRef !== currentModelRef;
		if (frozen === undefined || modelChanged) {
			this._frozenToolSelectionHints = { modelRef: currentModelRef, hints: [...current] };
			return current;
		}
		return frozen.hints;
	}

	/** The evidence-gated tool-selection hint block (see `getToolSelectionHints` on the deps). */
	private _buildToolSelectionHintPrompt(validToolNames: readonly string[]): string | undefined {
		const available = new Set(validToolNames);
		return formatToolSelectionHints(this._sessionToolSelectionHints().filter((hint) => available.has(hint.tool)));
	}

	/** True when the configured memory system is Intentional Context Management (ICM). */
	private isIcmMode(): boolean {
		return this.deps.getSettingsManager().getMemorySystem() === "icm";
	}

	private _buildProjectInstructionIsolationPrompt(profile: ModelCapabilityProfile): string | undefined {
		return buildProjectInstructionIsolationPrompt({
			mode: this.deps.getSettingsManager().getProjectContextFiles?.(),
			capabilityClass: profile.class,
		});
	}

	private _buildWorkLifecyclePrompt(): string | undefined {
		if (this.deps.isChildSession()) return undefined;
		const capabilityClass = this.deps.getModelCapabilityProfile().class;
		if (capabilityClass === "chat") return CHAT_WORK_LIFECYCLE_SYSTEM_RULE;
		if (capabilityClass === "minimal") return `WORK LIFECYCLE\n- ${CHAT_WORK_LIFECYCLE_SYSTEM_RULE}`;
		// The full class receives the lifecycle and delegation rule from its rule hook (core/rule-hooks).
		return undefined;
	}

	private _buildSystemPromptOptionsForToolNames(toolNames: string[]): BuildSystemPromptOptions {
		this._agentIdentity ??= this.deps.getAgentIdentity?.();
		const identity = this._agentIdentity;
		const modelCapability = this.deps.getModelCapabilityProfile();
		const validToolNames = toolNames.filter((name) => this.deps.hasTool(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelineGroups: string[][] = [];
		for (const name of validToolNames) {
			const snippet = this.deps.getToolPromptSnippet(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this.deps.getToolPromptGuidelines(name);
			if (toolGuidelines && toolGuidelines.length > 0) {
				promptGuidelineGroups.push(toolGuidelines);
			}
		}
		const promptGuidelines = collectPromptGuidelines(
			promptGuidelineGroups,
			MODEL_CAPABILITY_TOOL_GUIDELINES_MAX_CHARS[modelCapability.class],
		);

		const loaderSystemPrompt = this.deps.getResourceLoader().getSystemPrompt();
		const loaderAppendSystemPrompt = this.deps.getResourceLoader().getAppendSystemPrompt();
		const activeExtensions = this.deps.getActiveExtensions();
		const appendSystemPromptParts = [
			// R6: situational soul — the active profile's identity prefix, switched atomically with the
			// profile's capabilities/model. Most prominent, so it comes first.
			this._buildSituationSoulPrompt(),
			this._buildProjectInstructionIsolationPrompt(modelCapability),
			modelCapability.class === "full" ? undefined : this._buildSelfModificationPrompt(modelCapability),
			this._buildWorkLifecyclePrompt(),
			this._buildModelAdaptationPrompt(),
			this._buildToolSelectionHintPrompt(validToolNames),
		].filter((part): part is string => Boolean(part));
		const loadedContextFiles = this.deps.getResourceLoader().getAgentsFiles().agentsFiles;

		this._promptDate ??= promptDate(this._promptNow());
		const options: BuildSystemPromptOptions = {
			modelCapability,
			cwd: this.deps.getCwd(),
			contextFiles: loadedContextFiles,
			// Metadata remains available to extension hooks, but buildSystemPrompt never renders it.
			skills: [...this.deps.getResourceLoader().getActiveSkills()],
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt:
				[...appendSystemPromptParts, ...(loaderAppendSystemPrompt ?? [])].join("\n\n") || undefined,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			extensions: [...activeExtensions],
			date: this._promptDate,
			...(this.isIcmMode() ? { omitDate: true } : {}),
			steStrictness: this.deps.getSettingsManager().getSteStrictness?.(),
			directorRole:
				modelCapability.class === "full" &&
				!this.deps.isChildSession() &&
				validToolNames.includes("delegate") &&
				this.deps.getSettingsManager().getWorkerDelegationSettings().enabled,
			agentName: identity?.name,
			principles:
				modelCapability.class === "full"
					? [this._buildSelfModificationPrompt(modelCapability)].filter((text): text is string => Boolean(text))
					: undefined,
			missingSoulPath: identity?.missingSoulPath,
			soul: identity?.standalone ? undefined : identity?.soul,
		};
		// A memory allowance is part of the final prompt, not extra capacity on top of it.
		// Measure the mandatory prefix first, including caller guidance and paths; retain its
		// existing failure behavior if it alone cannot fit. Freeze only the admitted memory view.
		const availableChars =
			modelCapability.systemPromptMaxChars === undefined
				? undefined
				: Math.max(0, modelCapability.systemPromptMaxChars - buildSystemPrompt(options).length - 2);
		const memory = this._buildStaticMemoryPrompt(modelCapability, availableChars);
		options.appendSystemPrompt =
			[...appendSystemPromptParts, ...(memory ? [memory] : []), ...(loaderAppendSystemPrompt ?? [])].join("\n\n") ||
			undefined;
		return options;
	}

	rebuildSystemPrompt(toolNames: string[]): string {
		// The options stay current for extension hooks even while an owner override replaces the text.
		this._baseSystemPromptOptions = this._buildSystemPromptOptionsForToolNames(toolNames);
		return this.deps.getSystemPromptOverride?.() ?? buildSystemPrompt(this._baseSystemPromptOptions);
	}

	/**
	 * The generated prompt for a tool surface, ignoring any owner override and leaving the session's base
	 * prompt state untouched. This is what an owner edits from when starting a session override over.
	 */
	renderGeneratedSystemPrompt(toolNames: string[]): string {
		return buildSystemPrompt(this._buildSystemPromptOptionsForToolNames(toolNames));
	}

	/**
	 * Build a system prompt for a specific tool surface WITHOUT touching the session's base prompt
	 * state. Used for a router-swapped turn (G4): the routed model runs against a filtered tool set,
	 * so it must also receive a system prompt whose tool guidelines/snippets match that filtered
	 * surface — but the change is per-turn, so it must not mutate `_baseSystemPromptOptions` (which
	 * later turns and extension events read).
	 */
	buildSystemPromptForToolNames(toolNames: string[]): string {
		return this.deps.getSystemPromptOverride?.() ?? this.renderGeneratedSystemPrompt(toolNames);
	}
}
