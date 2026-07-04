import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import type { ModelTier, RouteDecision, RouteRisk } from "../autonomy/contracts.ts";
import type { ModelRouterIntent } from "./intent-classifier.ts";

export const MODEL_ROUTER_DECISION_CUSTOM_TYPE = "model_router_decision";

export type ModelRouterStatusSettings = {
	enabled: boolean;
	cheapModel?: string;
	mediumModel?: string;
	expensiveModel?: string;
	learningModel?: string;
};

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
	const { tier, risk, reasonCode } = decision.route;
	let outcomeText: string = decision.outcome;
	if (decision.outcome === "escalated" && decision.retryModel) {
		outcomeText = `escalated -> ${decision.retryModel}`;
	} else if (decision.outcome === "failed") {
		outcomeText = "failed";
	}
	return `${tier}/${risk} -> ${decision.routedModel} (${reasonCode}, ${outcomeText})`;
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
): string {
	const effectiveLastDecision = lastSkipReason ? undefined : lastDecision;
	const lines = [
		`${formatLabel("Status:")} ${settings.enabled ? "enabled" : "disabled"}`,
		`${formatLabel("Cheap model:")} ${settings.cheapModel ?? "unset"}`,
		`${formatLabel("Medium model:")} ${settings.mediumModel ?? "unset"}`,
		`${formatLabel("Expensive model:")} ${settings.expensiveModel ?? "unset"}`,
		`${formatLabel("Learning model:")} ${settings.learningModel ?? "active"}`,
	];
	if (!settings.enabled) {
		lines.push(`${formatLabel("Routing:")} inactive (disabled)`);
	} else if (lastSkipReason) {
		lines.push(`${formatLabel("Routing:")} skipped (${lastSkipReason})`);
	} else if (effectiveLastDecision) {
		lines.push(`${formatLabel("Routing:")} active`);
	} else {
		lines.push(`${formatLabel("Routing:")} waiting for prompt`);
	}
	lines.push(`${formatLabel("Latest intent:")} ${latestIntent ?? "none"}`);
	if (!effectiveLastDecision) {
		lines.push(`${formatLabel("Last decision:")} none`);
	} else {
		lines.push(`${formatLabel("Last decision:")} ${formatDecision(effectiveLastDecision)}`);
	}
	if (recentDecisions.length > 0) {
		lines.push(formatLabel("Recent decisions:"));
		for (const decision of recentDecisions) {
			lines.push(`- ${formatDecision(decision)}`);
		}
	}
	return lines.join("\n");
}
