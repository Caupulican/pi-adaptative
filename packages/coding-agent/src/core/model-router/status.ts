import type { ThinkingLevel } from "../../kernel/index.ts";
import type { SessionEntry } from "../../kernel/node.ts";
import type { ModelTier, RouteDecision, RouteRisk } from "../autonomy/contracts.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRouterIntent } from "./intent-classifier.ts";

export const MODEL_ROUTER_DECISION_CUSTOM_TYPE = "model_router_decision";

export type ModelRouterTierFitnessStatus =
	| { status: "fit" }
	| { status: "unprobed" }
	| { status: "unfit"; lane: string; succeeded: number; total: number };

export type ModelRouterFitnessStatuses = Partial<
	Record<"cheap" | "medium" | "expensive", ModelRouterTierFitnessStatus>
>;

export type ModelRouterFailoverStatus = {
	exhausted: string[];
	lastNotice?: string;
	failureStats?: { total: number; unknown: number };
};

export type ModelRouterStatusSettings = {
	enabled: boolean;
	selectionMode?: "manual" | "auto" | "hybrid";
	poolPreference?: "subscription-first" | "balanced";
	fitnessGate?: boolean;
	cheapModel?: string;
	cheapThinking?: ThinkingLevel;
	mediumModel?: string;
	mediumThinking?: ThinkingLevel;
	expensiveModel?: string;
	expensiveThinking?: ThinkingLevel;
	learningModel?: string;
	executorModel?: string;
	executorThinking?: ThinkingLevel;
};

function getThinkingLabel(level: ThinkingLevel | undefined): string {
	return level ?? interfaceText().localModels.routerStatus.inheritThinking;
}

function formatModelWithThinking(
	label: string,
	model: string | undefined,
	level: ThinkingLevel | undefined,
	fitness?: ModelRouterTierFitnessStatus,
): string {
	const words = interfaceText().localModels.routerStatus;
	const fitnessSuffix = fitness ? words.fitness(formatFitness(fitness)) : "";
	return `${label} ${model ?? words.unset} · ${words.thinking(getThinkingLabel(level))}${fitnessSuffix}`;
}

function formatFitness(fitness: ModelRouterTierFitnessStatus): string {
	const words = interfaceText().localModels.routerStatus;
	if (fitness.status === "fit") return words.fitnessFit;
	if (fitness.status === "unprobed") return words.fitnessUnprobed;
	return words.fitnessUnfit(fitness.lane, fitness.succeeded, fitness.total);
}

export type ModelRouterDecisionStatus = {
	route: RouteDecision;
	routedModel: string;
	outcome: "routed" | "escalated" | "failed";
	retryModel?: string;
	intent?: ModelRouterIntent;
};

function isRouteDecision(value: unknown): value is RouteDecision {
	if (!value || typeof value !== "object") return false;
	const route = value as Partial<RouteDecision>;
	const validTiers = new Set<ModelTier>(["cheap", "medium", "expensive", "learning"]);
	const validRisks = new Set<RouteRisk>(["read-only", "scoped-write", "high-impact", "approval-required"]);

	return (
		typeof route.confidence === "number" &&
		typeof route.reasonCode === "string" &&
		Array.isArray(route.reasons) &&
		route.reasons.every((r) => typeof r === "string") &&
		validTiers.has(route.tier as ModelTier) &&
		validRisks.has(route.risk as RouteRisk) &&
		(route.model === undefined || typeof route.model === "string") &&
		(route.fallbackFrom === undefined ||
			route.fallbackFrom === "cheap" ||
			route.fallbackFrom === "medium" ||
			route.fallbackFrom === "expensive" ||
			route.fallbackFrom === "learning") &&
		(route.createdAt === undefined || typeof route.createdAt === "string")
	);
}

function isModelRouterDecisionStatus(data: unknown): data is ModelRouterDecisionStatus {
	if (!data || typeof data !== "object") return false;
	const record = data as Partial<ModelRouterDecisionStatus>;
	return (
		isRouteDecision(record.route) &&
		record.route.tier !== "learning" && // Validate user prompt decisions never need learning tier in runtime
		typeof record.routedModel === "string" &&
		(record.outcome === "routed" || record.outcome === "escalated" || record.outcome === "failed") &&
		(record.retryModel === undefined || typeof record.retryModel === "string") &&
		(record.intent === undefined || record.intent === "research" || record.intent === "modify")
	);
}

function formatDecision(decision: ModelRouterDecisionStatus): string {
	const { tier, risk, reasonCode, selection } = decision.route;
	const words = interfaceText().localModels.routerStatus;
	let outcomeText: string = decision.outcome;
	if (decision.outcome === "escalated" && decision.retryModel) {
		outcomeText = words.escalatedTo(decision.retryModel);
	} else if (decision.outcome === "failed") {
		outcomeText = words.failed;
	}
	// Selection provenance is shown only when it was recorded; older decisions carry none.
	const selectionText = selection
		? words.selectedBy(selection === "hmoe" ? "H-MoE" : selection === "system_one" ? "System One" : selection)
		: "";
	return `${tier}/${risk} -> ${decision.routedModel} (${reasonCode}, ${outcomeText}${selectionText})`;
}

export function getRecentModelRouterDecisions(entries: SessionEntry[], limit = 3): ModelRouterDecisionStatus[] {
	const decisions: ModelRouterDecisionStatus[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODEL_ROUTER_DECISION_CUSTOM_TYPE) continue;
		if (!isModelRouterDecisionStatus(entry.data)) continue;
		decisions.push(entry.data);
	}
	return decisions.slice(-limit);
}

export function formatModelRouterStatus(
	settings: ModelRouterStatusSettings,
	lastDecision?: ModelRouterDecisionStatus,
	formatLabel: (label: string) => string = (label) => label,
	recentDecisions: ModelRouterDecisionStatus[] = [],
	lastSkipReason?: string,
	latestIntent?: ModelRouterIntent,
	fitnessStatuses?: ModelRouterFitnessStatuses,
	failoverStatus?: ModelRouterFailoverStatus,
	poolSummary?: string,
): string {
	const words = interfaceText().localModels.routerStatus;
	const effectiveLastDecision = lastSkipReason ? undefined : lastDecision;
	const lines = [
		`${formatLabel(words.status)} ${settings.enabled ? words.enabled : words.disabled}`,
		...(settings.selectionMode
			? [`${formatLabel(words.selectionMode)} ${settings.selectionMode.toUpperCase()}`]
			: []),
		...(poolSummary ? [`${formatLabel(words.candidatePool)} ${poolSummary}`] : []),
		...(settings.poolPreference ? [`${formatLabel(words.poolPreference)} ${settings.poolPreference}`] : []),
		formatModelWithThinking(
			formatLabel(words.cheapModel),
			settings.cheapModel,
			settings.cheapThinking,
			settings.fitnessGate ? fitnessStatuses?.cheap : undefined,
		),
		formatModelWithThinking(
			formatLabel(words.mediumModel),
			settings.mediumModel,
			settings.mediumThinking,
			settings.fitnessGate ? fitnessStatuses?.medium : undefined,
		),
		formatModelWithThinking(
			formatLabel(words.expensiveModel),
			settings.expensiveModel,
			settings.expensiveThinking,
			settings.fitnessGate ? fitnessStatuses?.expensive : undefined,
		),
		formatModelWithThinking(formatLabel(words.executorModel), settings.executorModel, settings.executorThinking),
		`${formatLabel(words.learningModel)} ${settings.learningModel ?? words.active}`,
	];
	if (!settings.enabled) {
		lines.push(`${formatLabel(words.routing)} ${words.inactive}`);
	} else if (lastSkipReason) {
		lines.push(`${formatLabel(words.routing)} ${words.skipped(lastSkipReason)}`);
	} else if (effectiveLastDecision) {
		lines.push(`${formatLabel(words.routing)} ${words.active}`);
	} else {
		lines.push(`${formatLabel(words.routing)} ${words.waitingForPrompt}`);
	}
	lines.push(`${formatLabel(words.latestIntent)} ${latestIntent ?? words.none}`);
	if (!effectiveLastDecision) {
		lines.push(`${formatLabel(words.lastDecision)} ${words.none}`);
	} else {
		lines.push(`${formatLabel(words.lastDecision)} ${formatDecision(effectiveLastDecision)}`);
	}
	if (failoverStatus?.exhausted.length) {
		lines.push(`${formatLabel(words.exhaustedModels)} ${failoverStatus.exhausted.join(", ")}`);
	}
	if (failoverStatus?.lastNotice) {
		lines.push(`${formatLabel(words.lastFailover)} ${failoverStatus.lastNotice}`);
	}
	if (failoverStatus?.failureStats && failoverStatus.failureStats.total > 0) {
		const { total, unknown } = failoverStatus.failureStats;
		lines.push(`${formatLabel(words.providerFailures)} ${words.providerFailuresDetail(total, unknown)}`);
	}
	if (recentDecisions.length > 0) {
		lines.push(formatLabel(words.recentDecisions));
		for (const decision of recentDecisions) {
			lines.push(`- ${formatDecision(decision)}`);
		}
	}
	return lines.join("\n");
}
