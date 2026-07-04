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
import type { Extension } from "./extensions/types.ts";
import type { MemoryManager } from "./memory/memory-manager.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { UNTRUSTED_BOUNDARY_SYSTEM_RULE } from "./security/untrusted-boundary.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";

export interface SystemPromptBuilderDeps {
	/** The session's working directory (read fresh; base for self-modification source resolution). */
	getCwd(): string;
	/** The session's settings manager — soul, self-modification, autonomy, and auto-learn settings. */
	getSettingsManager(): SettingsManager;
	/** The session's resource loader — custom/append system prompts, active skills, agents files. */
	getResourceLoader(): ResourceLoader;
	/** The session's memory manager — the static, frozen-per-session memory system-prompt block. */
	getMemoryManager(): MemoryManager;
	/** Whether a tool name is currently registered on the session. */
	hasTool(name: string): boolean;
	/** The one-line prompt snippet registered for a tool, if any. */
	getToolPromptSnippet(name: string): string | undefined;
	/** The extra guideline bullets registered for a tool, if any. */
	getToolPromptGuidelines(name: string): string[] | undefined;
	/** The session's currently active extensions. */
	getActiveExtensions(): ReadonlyArray<Extension>;
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

	normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	/**
	 * R6: the active profile's situational soul, wrapped so the model reads it as its identity for this
	 * situation. Empty when no active profile defines a soul.
	 */
	private _buildSituationSoulPrompt(): string | undefined {
		const soul = this.deps.getSettingsManager().getActiveProfileSoul();
		if (!soul) return undefined;
		return `<situation_soul>\n${soul}\n</situation_soul>`;
	}

	private _buildSelfModificationPrompt(): string | undefined {
		const settings = this.deps.getSettingsManager().getSelfModificationSettings();
		if (!settings.enabled) {
			return undefined;
		}

		// Resolve from an ordered candidate list first (portable WSL/Termux switching
		// from settings alone), then fall back to the legacy single sourcePath.
		const rawCandidates = [
			...(Array.isArray(settings.sourcePaths) ? settings.sourcePaths : []),
			...(settings.sourcePath ? [settings.sourcePath] : []),
		]
			.map((candidate) => candidate?.trim())
			.filter((candidate): candidate is string => Boolean(candidate));

		if (rawCandidates.length === 0) {
			return `Pi self-modification guardrails (local setting active, source missing):
- Self-modification is enabled, but no \`selfModification.sourcePaths\`/\`selfModification.sourcePath\` value is set.
- Do not modify Pi core or runtime output. Ask the user to set \`selfModification.sourcePaths\` to the pi-adaptative source checkout before proceeding.`;
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
			: `${sourcePath} (missing or not a source checkout; ask the user to correct \`selfModification.sourcePaths\` before editing)`;
		const autonomy = this.deps.getSettingsManager().getAutonomySettings();
		const settingsGate =
			autonomy.mode === "full"
				? "In autonomy.mode=full, autonomy/autoLearn setting tuning is covered by the standing autonomy grant; ask before changing credentials, provider auth, package sources, or unrelated preferences."
				: "Ask for explicit approval before changing global settings.";
		return `Pi self-modification guardrails (local setting active):
- Authorized pi-adaptative source path: ${sourceStatus}
- Only modify Pi core/harness source under the authorized source path; never patch installed node_modules or generated runtime output as the source of truth.
- Before changing Pi itself, restate the objective and scope, inspect relevant source/docs/examples, and make the smallest auditable change.
- Preserve user changes: check git status before and after, avoid unrelated edits, and do not overwrite concurrent work.
- Validate with focused tests and broader checks proportional to risk before claiming success.
- Reload/restart/renew only after source changes are saved and auditable.
- ${settingsGate}
- Always ask for explicit approval before publishing, pushing, tagging, or releasing.`;
	}

	private _buildAutonomyPrompt(): string | undefined {
		const autoLearn = this.deps.getSettingsManager().getAutoLearnSettings();
		const autonomy = this.deps.getSettingsManager().getAutonomySettings();
		if (!autoLearn.enabled && autonomy.mode !== "full") {
			return undefined;
		}

		const reflection = autoLearn.reflectionReview ?? autonomy.mode !== "off";
		const model = autoLearn.model?.trim() || "active";
		if (autonomy.mode === "full") {
			return `Pi autonomy policy (mode full, standing autonomy):
- Setting-authorized background learners may run after long sessions or corrective/complex turns using model ${model}; they may act without asking first inside this standing grant.
- Standing grant: write high-confidence durable memory, create/patch user/project skills, create/patch small user/project extensions/tools, tune autonomy/autoLearn settings, edit the authorized selfModification.sourcePath, run validation, and leave audit/rollback evidence.
- Hard stops still require explicit foreground approval: publish/npm release, git push, tag creation, credential/provider-auth changes, destructive user-data deletion, network-exposed services, or expanding authority beyond this policy.
- Treat current-turn evidence as a cue, not proof; prefer deterministic or longitudinal corroboration for durable behavior changes.
- Active-task work remains primary: autonomy runs must not interrupt user-visible execution or claim task completion without evidence.`;
		}
		return `Pi autonomy policy (mode ${autonomy.mode}):
- Setting-authorized background learners may run after long sessions${reflection ? " or corrective/complex turns" : ""} using model ${model}.
- Background learning may query durable memory and run bounded learning tools.
- Auto-apply is limited to high-confidence durable memory when explicitly configured; tooling, skill, prompt, extension, settings, and core-source changes stay proposal/approval-gated.
- Treat current-turn evidence as a cue, not proof; prefer longitudinal corroboration before changing durable behavior.
- Active-task work remains primary: learning runs must not interrupt user-visible execution or claim task completion.`;
	}

	private _buildSystemPromptOptionsForToolNames(toolNames: string[]): BuildSystemPromptOptions {
		const validToolNames = toolNames.filter((name) => this.deps.hasTool(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this.deps.getToolPromptSnippet(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this.deps.getToolPromptGuidelines(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this.deps.getResourceLoader().getSystemPrompt();
		const loaderAppendSystemPrompt = this.deps.getResourceLoader().getAppendSystemPrompt();
		const appendSystemPromptParts = [
			// R6: situational soul — the active profile's identity prefix, switched atomically with the
			// profile's capabilities/model. Most prominent, so it comes first.
			this._buildSituationSoulPrompt(),
			// Always-on untrusted-content boundary contract (gives the <untrusted_content> fences meaning).
			UNTRUSTED_BOUNDARY_SYSTEM_RULE,
			this._buildSelfModificationPrompt(),
			this._buildAutonomyPrompt(),
			// Memory subsystem: static, frozen-per-session block (e.g. file-store MEMORY.md/USER.md).
			this.deps.getMemoryManager().buildSystemPromptBlock() || undefined,
			...loaderAppendSystemPrompt,
		].filter((part): part is string => Boolean(part));
		const appendSystemPrompt = appendSystemPromptParts.length > 0 ? appendSystemPromptParts.join("\n\n") : undefined;
		// Only surface skills the active profile permits — the agent must not be told about (or able
		// to invoke) a skill its profile blocks.
		const loadedSkills = this.deps.getResourceLoader().getActiveSkills();
		const loadedContextFiles = this.deps.getResourceLoader().getAgentsFiles().agentsFiles;

		return {
			cwd: this.deps.getCwd(),
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			extensions: [...this.deps.getActiveExtensions()],
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
