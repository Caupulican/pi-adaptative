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
import { resolveMemoryPromptBudget } from "./context/memory-prompt-budget.ts";
import type { Extension } from "./extensions/types.ts";
import { isCurrentSessionReflectionEnabled, resolveAutoLearnSettings } from "./learning/auto-learn-settings.ts";
import type { MemoryManager } from "./memory/memory-manager.ts";
import {
	enforceModelCapabilitySystemPromptBudget,
	MODEL_CAPABILITY_TOOL_GUIDELINES_MAX_CHARS,
	type ModelCapabilityProfile,
} from "./model-capability.ts";
import type { ModelAdaptationRule } from "./models/adaptation-store.ts";
import {
	CHAT_WORK_LIFECYCLE_SYSTEM_RULE,
	DELEGATION_DECISION_RULE,
	WORK_LIFECYCLE_SYSTEM_RULE,
} from "./provider-prompt-contracts.ts";
import { normalizeProviderPromptGuidelines, normalizeProviderPromptSnippet } from "./provider-tool-text.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { UNTRUSTED_BOUNDARY_SYSTEM_RULE } from "./security/untrusted-boundary.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { formatToolSelectionHints, type ToolSelectionHint } from "./tool-selection/promotion.ts";

export interface SystemPromptBuilderDeps {
	/** The session's working directory (read fresh; base for self-modification source resolution). */
	getCwd(): string;
	/** The session's settings manager — soul, self-modification, autonomy, and auto-learn settings. */
	getSettingsManager(): SettingsManager;
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
	 * hint block, same as an empty list. Changes RARELY (only when the underlying evidence flips
	 * which tool is promoted for an intent) — never per turn — so it does not threaten the
	 * single-cached-system-prompt-block invariant (see system-prompt.ts).
	 */
	getToolSelectionHints?(): readonly ToolSelectionHint[];
	/** The session's currently active extensions. */
	getActiveExtensions(): ReadonlyArray<Extension>;
	/** The authoritative profile used by tools, lanes, and stable prompt shaping. */
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Child/worker sessions never receive root autonomy or reflection instructions. */
	isChildSession(): boolean;
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

	constructor(deps: SystemPromptBuilderDeps) {
		this.deps = deps;
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
		const soul = this.deps.getSettingsManager().getActiveProfileSoul();
		if (!soul) return undefined;
		return `SITUATION SOUL\n${soul}`;
	}

	private _buildSelfModificationPrompt(profile: ModelCapabilityProfile): string | undefined {
		const settings = this.deps.getSettingsManager().getSelfModificationSettings();
		if (!settings.enabled) {
			return undefined;
		}

		// Resolve from an ordered candidate list first (portable WSL/Termux switching
		// from settings alone), then fall back to the legacy single sourcePath.
		const rawCandidates = collectSelfModificationSourceCandidates(settings);

		if (rawCandidates.length === 0) {
			return "PI SELF-MODIFICATION: enabled but sourcePaths/sourcePath is missing. Do not modify core/runtime output; ask for the pi-adaptative source checkout path.";
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
		const autonomy = this.deps.getSettingsManager().getAutonomySettings();
		const settingsGate =
			autonomy.mode === "full"
				? "autonomy.mode=full grants autonomy/autoLearn tuning. Ask before credential disclosure, provider authentication changes, credential operations outside active user-plane secret_store grant, package-source changes, unrelated preferences."
				: "Ask for explicit approval before changing global settings.";
		if (profile.class !== "full") {
			return `PI SELF-MODIFICATION: edit core only under ${sourceStatus}. Inspect first; preserve concurrent work; smallest auditable change; focused validation. ${settingsGate} Always ask before publish/push/tag/release.`;
		}
		return `PI SELF-MODIFICATION: source=${sourceStatus}. Edit core/harness only there; never patch installed/generated output as source of truth. Restate scope; inspect source/docs; preserve concurrent changes; make the smallest auditable edit; run focused then proportionate checks; reload only after saved evidence. ${settingsGate} Always ask before publish/push/tag/release.`;
	}

	private _buildStaticMemoryPrompt(profile: ModelCapabilityProfile): string | undefined {
		const budget =
			profile.class !== "full" && profile.contextWindow !== undefined
				? resolveMemoryPromptBudget({ contextWindow: profile.contextWindow, configuredMaxResults: 3 })
				: undefined;
		return this.deps.getMemoryManager().buildSystemPromptBlock(budget) || undefined;
	}

	private _buildModelAdaptationPrompt(): string | undefined {
		const rules = this.deps.getModelAdaptationRules();
		if (rules.length === 0) return undefined;
		const lines = rules.map((rule) => `- ${rule.text}`);
		return `MODEL TOOL SHAPE RULES\n${lines.join("\n")}`;
	}

	/** The evidence-gated tool-selection hint block (see `getToolSelectionHints` on the deps). */
	private _buildToolSelectionHintPrompt(): string | undefined {
		return formatToolSelectionHints(this.deps.getToolSelectionHints?.() ?? []);
	}

	private _buildToolApplicabilityPrompt(
		validToolNames: readonly string[],
		activeExtensions: ReadonlyArray<Extension>,
		profile: ModelCapabilityProfile,
	): string | undefined {
		const activeNames = new Set(validToolNames);
		if (!activeNames.has("secret_store")) {
			let hasActiveExtensionTool = false;
			for (const extension of activeExtensions) {
				for (const name of extension.tools.keys()) {
					if (!activeNames.has(name)) continue;
					hasActiveExtensionTool = true;
					break;
				}
				if (hasActiveExtensionTool) break;
			}
			if (!hasActiveExtensionTool) return undefined;
		}
		if (profile.class !== "full") {
			return "PI TOOL APPLICABILITY: availability is not a mandate. Use extension/project/account tools only when this request needs their data or action. Context or guidance alone is not a trigger. Missing optional credentials never block unrelated work or require secret_store.";
		}
		return "PI TOOL APPLICABILITY: active means available, not required. Use extension/project/account tools only when the current request explicitly asks for them or genuinely depends on their data/action; cwd, repository, prior session, wildcard profile, or tool guidance alone are not triggers. Missing optional credentials never block unrelated work or justify speculative secret_store use.";
	}

	private _buildAutonomyPrompt(profile: ModelCapabilityProfile): string | undefined {
		if (this.deps.isChildSession()) return undefined;
		const settingsManager = this.deps.getSettingsManager();
		const autonomy = settingsManager.getAutonomySettings();
		const autoLearn = resolveAutoLearnSettings(autonomy.mode, settingsManager.getAutoLearnSettings());
		if (!autoLearn.enabled && autonomy.mode !== "full") {
			return undefined;
		}

		const reflectionContract = isCurrentSessionReflectionEnabled(autoLearn)
			? "ROOT REFLECTION: decide and apply warranted durable learning in the current root provider turn only; never add a provider request or delegate reflection."
			: "Root reflection is disabled.";
		if (profile.class !== "full") {
			return `PI AUTONOMY ${autonomy.mode}: ${reflectionContract} Active task primary. Observations are evidence; bound changes. Approval: publish/push/tag/release, credential/authentication changes outside active secret_store authority, destructive deletion, broader authority.`;
		}
		if (autonomy.mode === "full") {
			return `PI AUTONOMY full (standing): ${reflectionContract} Grant: high-confidence memory; user/project skills and small extensions/tools; autonomy/autoLearn tuning; authorized selfModification source edits; validation plus rollback evidence. Hard stop for publish/release/push/tag, credential disclosure/provider authentication/out-of-grant secret operations, destructive user-data deletion, exposed services, or more authority. Current-turn evidence is a cue, not proof; active task stays primary.`;
		}
		return `PI AUTONOMY ${autonomy.mode}: ${reflectionContract} Query memory and use bounded tools already available in this session. Auto-apply configured high-confidence memory and clean additive skill promotions; code/prompt/extension/settings changes need approval. Evidence is cue, never proof; active task primary.`;
	}

	private _buildWorkLifecyclePrompt(toolNames: readonly string[]): string | undefined {
		if (this.deps.isChildSession()) return undefined;
		const capabilityClass = this.deps.getModelCapabilityProfile().class;
		if (capabilityClass === "chat") return CHAT_WORK_LIFECYCLE_SYSTEM_RULE;
		if (capabilityClass === "minimal") return `PI WORK LIFECYCLE\n- ${CHAT_WORK_LIFECYCLE_SYSTEM_RULE}`;
		const hasWorkPlanningTool = toolNames.some(
			(name) =>
				name === "goal" ||
				name === "create_goal" ||
				name === "get_goal" ||
				name === "update_goal" ||
				name === "task_steps",
		);
		const ownerRule = hasWorkPlanningTool
			? "\n- One owner per invariant: goal owns outcome/contract, task_steps owns plan, delegate owns workers, evidence owns acceptance. Never create parallel workflow state."
			: "";
		return `PI WORK LIFECYCLE
- ${WORK_LIFECYCLE_SYSTEM_RULE}${ownerRule}`;
	}

	private _buildDelegationPrompt(delegateActive: boolean): string | undefined {
		if (!delegateActive || !this.deps.getSettingsManager().getWorkerDelegationSettings().enabled) {
			return undefined;
		}
		return `PI DELEGATION
- ${DELEGATION_DECISION_RULE}
- Continue parent work while workers run; wait only at a true dependency, then inspect status and handoffs event-driven.
- Parent owns integration, verification, security and approval decisions, and writes unless authority explicitly grants worker writes.
- Treat worker output as evidence, reconcile conflicts, and finish only after success criteria.
- Per-worker token, cost, wall-clock, and tool ceilings come only from host settings or an owner-authored profileId.`;
	}

	private _buildSystemPromptOptionsForToolNames(toolNames: string[]): BuildSystemPromptOptions {
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
			// Always-on untrusted-content boundary contract (gives the <untrusted_content> fences meaning).
			UNTRUSTED_BOUNDARY_SYSTEM_RULE,
			this._buildSelfModificationPrompt(modelCapability),
			this._buildAutonomyPrompt(modelCapability),
			this._buildWorkLifecyclePrompt(validToolNames),
			this._buildDelegationPrompt(validToolNames.includes("delegate")),
			this._buildModelAdaptationPrompt(),
			this._buildToolSelectionHintPrompt(),
			this._buildToolApplicabilityPrompt(validToolNames, activeExtensions, modelCapability),
			// Memory subsystem: static, frozen-per-session block (e.g. file-store MEMORY.md/USER.md).
			this._buildStaticMemoryPrompt(modelCapability),
			...loaderAppendSystemPrompt,
		].filter((part): part is string => Boolean(part));
		const appendSystemPrompt = appendSystemPromptParts.length > 0 ? appendSystemPromptParts.join("\n\n") : undefined;
		const loadedContextFiles = this.deps.getResourceLoader().getAgentsFiles().agentsFiles;

		return {
			modelCapability,
			cwd: this.deps.getCwd(),
			contextFiles: loadedContextFiles,
			// Metadata remains available to extension hooks, but buildSystemPrompt never renders it.
			skills: [...this.deps.getResourceLoader().getActiveSkills()],
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			extensions: [...activeExtensions],
		};
	}

	rebuildSystemPrompt(toolNames: string[]): string {
		this._baseSystemPromptOptions = this._buildSystemPromptOptionsForToolNames(toolNames);
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	/**
	 * Build a system prompt for a specific tool surface WITHOUT touching the session's base prompt
	 * state. Used for a router-swapped turn (G4): the routed model runs against a filtered tool set,
	 * so it must also receive a system prompt whose tool guidelines/snippets match that filtered
	 * surface — but the change is per-turn, so it must not mutate `_baseSystemPromptOptions` (which
	 * later turns and extension events read).
	 */
	buildSystemPromptForToolNames(toolNames: string[]): string {
		return buildSystemPrompt(this._buildSystemPromptOptionsForToolNames(toolNames));
	}
}
