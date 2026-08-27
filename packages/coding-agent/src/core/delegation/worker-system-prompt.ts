import type { Model } from "@caupulican/pi-ai";
import { composeSubagentSystemPrompt } from "../autonomy/subagent-prompt.ts";
import { enforceModelCapabilitySystemPromptBudget, type ModelCapabilityProfile } from "../model-capability.ts";
import {
	type ModelAdaptationProfile,
	type ModelAdaptationRule,
	ModelAdaptationStore,
} from "../models/adaptation-store.ts";
import {
	buildProjectInstructionIsolationPrompt,
	type ProjectContextFilesMode,
} from "../project-instruction-isolation.ts";
import { formatContextFilesForPrompt } from "../system-prompt.ts";

export interface WorkerModelGuidance {
	rules: ModelAdaptationRule[];
	toolProbeStatus?: string;
	toolProbeGrade?: string;
	toolProbeDiagnostic?: string;
	protocolStatus?: string;
	protocolVariant?: string;
	teachStats?: Record<string, { taught: number; recurrenceBefore: number; recurrenceAfter: number }>;
}

export interface BuildWorkerSystemPromptOptions {
	/** Situational soul / identity snippet from shipped profile. */
	soul?: string;
	/** Worker role prompt or execution plan prompt. */
	rolePrompt: string;
	/** Materialized worker resource system prompt (skills/tools). */
	workerResourceSystemPrompt?: string;
	/** Final profile-filtered context files from the parent ResourceLoader. */
	contextFiles?: ReadonlyArray<{ path: string; content?: string }>;
	/** Whether deferred context paths remain reachable through the worker read tool. */
	canReadContextFiles?: boolean;
	/** Selected worker model capability; enforces the same fail-closed prompt budget as root. */
	modelCapability?: Pick<ModelCapabilityProfile, "class" | "systemPromptMaxChars">;
	/** Override for all layers above Level-0 subagent core. */
	override?: string;
	/** Session agent directory to resolve ModelAdaptationStore. */
	agentDir?: string;
	/** Provider string (e.g. "anthropic", "openai"). */
	provider?: string;
	/** Model ID string (e.g. "claude-3-5-sonnet-20241022"). */
	modelId?: string;
	/** Target model instance if available. */
	model?: Model<any>;
	/** Parent projectContextFiles mode. Omitted defaults to off. */
	projectContextFiles?: ProjectContextFilesMode;
}

/** Formats provider and model ID into standard modelRef key. */
export function formatWorkerModelRef(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/**
 * Dynamically loads model-specific adaptation rules and tool-recovery observations
 * from the session's ModelAdaptationStore based on provider and model ID.
 */
export function loadWorkerModelGuidance(options: {
	agentDir: string;
	provider: string;
	modelId: string;
}): WorkerModelGuidance {
	const modelRef = formatWorkerModelRef(options.provider, options.modelId);
	const store = ModelAdaptationStore.forAgentDir(options.agentDir, { readOnly: true });
	const profile: ModelAdaptationProfile = store.get(modelRef);

	return {
		rules: profile.rules,
		toolProbeStatus: profile.toolProbe?.status,
		toolProbeGrade: profile.toolProbe?.nativeGrade,
		toolProbeDiagnostic: profile.toolProbe?.diagnostic,
		protocolStatus: profile.protocol?.status ?? (profile.protocol ? "calibrated" : undefined),
		protocolVariant: profile.protocol?.status !== "failed" ? profile.protocol?.variant : undefined,
		teachStats: profile.teachStats,
	};
}

/**
 * Formats model adaptation rules and tool-recovery observations into prompt blocks.
 */
export function formatWorkerModelGuidancePrompt(guidance: WorkerModelGuidance): string | undefined {
	const blocks: string[] = [];

	if (guidance.rules.length > 0) {
		const ruleLines = guidance.rules.map((rule) => `- ${rule.text}`);
		blocks.push(`MODEL TOOL SHAPE RULES\n${ruleLines.join("\n")}`);
	}

	const observationLines: string[] = [];
	if (guidance.toolProbeStatus) {
		const gradeInfo = guidance.toolProbeGrade ? ` (grade: ${guidance.toolProbeGrade})` : "";
		observationLines.push(`- Tool probe verdict: ${guidance.toolProbeStatus}${gradeInfo}`);
	}
	if (guidance.toolProbeDiagnostic) {
		observationLines.push(`- Tool probe diagnostic: ${guidance.toolProbeDiagnostic}`);
	}
	if (guidance.protocolStatus) {
		const variantInfo = guidance.protocolVariant ? ` (${guidance.protocolVariant})` : "";
		observationLines.push(`- Text protocol status: ${guidance.protocolStatus}${variantInfo}`);
	}

	const activeTeachModes = Object.entries(guidance.teachStats ?? {}).filter(([_, stats]) => stats.taught > 0);
	if (activeTeachModes.length > 0) {
		for (const [mode, stats] of activeTeachModes) {
			observationLines.push(`- Calibrated repair mode ${mode}: taught=${stats.taught}`);
		}
	}

	if (observationLines.length > 0) {
		blocks.push(`MODEL TOOL-RECOVERY OBSERVATIONS\n${observationLines.join("\n")}`);
	}

	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * Builds worker system prompt with level-0 subagent core, situational soul,
 * role prompt, resource system prompt, and dynamically appended model adaptation guidance.
 */
export function buildWorkerSystemPrompt(options: BuildWorkerSystemPromptOptions): string {
	const provider = options.model?.provider ?? options.provider;
	const modelId = options.model?.id ?? options.modelId;

	let modelGuidancePrompt: string | undefined;
	if (options.agentDir && provider && modelId) {
		try {
			const guidance = loadWorkerModelGuidance({
				agentDir: options.agentDir,
				provider,
				modelId,
			});
			modelGuidancePrompt = formatWorkerModelGuidancePrompt(guidance);
		} catch {
			modelGuidancePrompt = undefined;
		}
	}

	const contextPrompt =
		options.contextFiles && options.contextFiles.length > 0
			? formatContextFilesForPrompt(options.contextFiles, {
					deferContents: false,
					canRead: options.canReadContextFiles === true,
				}).trim()
			: undefined;
	const rolePromptParts = [
		options.rolePrompt,
		options.workerResourceSystemPrompt,
		modelGuidancePrompt,
		contextPrompt,
	].filter((part): part is string => Boolean(part && part.trim().length > 0));

	const systemPrompt = composeSubagentSystemPrompt({
		soul: options.soul,
		rolePrompt: rolePromptParts.join("\n\n"),
		override: options.override,
	}).replace(/\r\n?/g, "\n");
	const isolation = buildProjectInstructionIsolationPrompt({
		mode: options.projectContextFiles,
		capabilityClass: options.modelCapability?.class,
	});
	const withIsolation = isolation ? `${systemPrompt}\n\n${isolation}` : systemPrompt;
	return options.modelCapability
		? enforceModelCapabilitySystemPromptBudget(withIsolation, options.modelCapability)
		: withIsolation;
}
