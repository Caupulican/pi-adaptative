/**
 * Worker Capability Request Builder.
 * Deterministically constructs typed capability requests from ObjectiveRoute, task, and Decision Kernel signals.
 * Implements WORKER_CAPABILITY_REQUEST.md, reference/request-builder.ts, and HMOE-001.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ObjectiveRoute } from "../objective-execution/objective-route.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime-state.ts";
import {
	EXPERT_ROUTING_SCHEMA_VERSION,
	type ExpertConsequence,
	type ExpertIndependenceLevel,
	type ExpertWorkClass,
	type WorkerCapabilityRequest,
} from "./contracts.ts";

export interface DecisionSignalsInput {
	independentWorkerRequired?: boolean;
	capabilityEscalationRequired?: boolean;
	contextStale?: boolean;
	strategyRepetition?: boolean;
	semanticProgress?: number;
}

export interface BuildWorkerCapabilityRequestInput {
	objectiveId?: string;
	taskId?: string;
	role?: string;
	task?: {
		taskId?: string;
		role?: string;
		requiredCapabilities?: readonly string[];
		title?: string;
		description?: string;
	};
	route?: ObjectiveRoute | string;
	workClass?: ExpertWorkClass;
	consequence?: ExpertConsequence;
	routingBand?: "cheap" | "medium" | "expensive";
	requiredCapabilities?: readonly string[];
	requiredTools?: readonly string[];
	decisionSignals?: DecisionSignalsInput & {
		suggestedTier?: string;
		taskKind?: string;
	};
	priorAttempts?: readonly (
		| AttemptRuntimeState
		| {
				attemptId: string;
				status: string;
				reasonCode?: string;
				expertId?: string;
				modelId?: string;
				provider?: string;
		  }
	)[];
	excludedExpertIds?: readonly string[];
	excludedModelRefs?: readonly string[];
	excludedProviders?: readonly string[];
	localOnly?: boolean;
	remoteAllowed?: boolean;
	maxCostUsd?: number | null;
	targetLatencyMs?: number | null;
	minimumContextWindow?: number | null;
	metadata?: Record<string, unknown>;
}

export function routeToWorkClass(routeName?: string): ExpertWorkClass {
	switch (routeName) {
		case "retrieve":
		case "task_retrieve":
			return "retrieve";
		case "investigate":
		case "task_investigate":
			return "investigate";
		case "deterministic_test":
		case "task_deterministic_test":
			return "deterministic_test";
		case "verify":
		case "task_verify":
			return "verify";
		case "review":
		case "task_review":
			return "review";
		case "replan":
			return "replan";
		default:
			return "implement";
	}
}

export function buildWorkerCapabilityRequest(input: BuildWorkerCapabilityRequestInput): WorkerCapabilityRequest {
	const rawRoute = typeof input.route === "string" ? input.route : input.route?.route;
	const workClass = input.workClass ?? routeToWorkClass(rawRoute);
	const consequence = input.consequence ?? "medium";
	const objectiveId = input.objectiveId ?? "default-objective";
	const taskId = input.taskId ?? input.task?.taskId ?? `task-${Date.now().toString(36)}`;
	const role = input.role ?? input.task?.role ?? "generalist";

	// Determine independence level from decision signals
	let independenceLevel: ExpertIndependenceLevel = "none";
	if (input.decisionSignals?.independentWorkerRequired) {
		independenceLevel = consequence === "critical" ? "distinct_provider" : "distinct_model";
	} else if (workClass === "verify" || workClass === "review") {
		independenceLevel = "distinct_model";
	}

	// Extract failure signatures and excluded expert IDs from prior attempts
	const excludedExpertIds: string[] = [...(input.excludedExpertIds ?? [])];
	const excludedModelRefs: string[] = [...(input.excludedModelRefs ?? [])];
	const excludedProviders: string[] = [...(input.excludedProviders ?? [])];
	const failureSignatures: string[] = [];

	if (input.priorAttempts) {
		for (const attempt of input.priorAttempts) {
			if (attempt.status === "failed") {
				const reason = attempt.reasonCode ?? "unknown_failure";
				failureSignatures.push(reason);
				const expId = (attempt as { expertId?: string }).expertId;
				if (expId && !excludedExpertIds.includes(expId)) {
					excludedExpertIds.push(expId);
				}
			}
			// If independence is required, also exclude models/providers from prior attempts
			if (input.decisionSignals?.independentWorkerRequired || workClass === "verify" || workClass === "review") {
				const modelId = (attempt as { modelId?: string }).modelId;
				const provider = (attempt as { provider?: string }).provider;
				if (modelId && !excludedModelRefs.includes(modelId)) {
					excludedModelRefs.push(modelId);
				}
				if (independenceLevel === "distinct_provider" && provider && !excludedProviders.includes(provider)) {
					excludedProviders.push(provider);
				}
			}
		}
	}

	const suggestedTier = input.decisionSignals?.suggestedTier;
	const isRoutingBand = suggestedTier === "cheap" || suggestedTier === "medium" || suggestedTier === "expensive";
	const isCapabilityTier =
		suggestedTier === "frontier" || suggestedTier === "strong" || suggestedTier === "constrained";
	const routingBand = input.routingBand ?? (isRoutingBand ? suggestedTier : undefined);

	const taskSignature: Record<string, unknown> = {
		workClass,
		role,
		consequence,
		hasPriorFailures: failureSignatures.length > 0,
		failureCount: failureSignatures.length,
		...(routingBand ? { routingBand } : {}),
		...(isCapabilityTier ? { suggestedTier } : {}),
		...(input.metadata ?? {}),
	};

	const requiredCapabilities = [...(input.task?.requiredCapabilities ?? []), ...(input.requiredCapabilities ?? [])];
	if (isCapabilityTier && !requiredCapabilities.some((c) => c.startsWith("tier:"))) {
		requiredCapabilities.push(`tier:${suggestedTier}`);
	}

	const requestId = createHash("sha256")
		.update(`${objectiveId}:${taskId}:${workClass}:${Date.now()}:${randomUUID()}`)
		.digest("hex")
		.slice(0, 16);

	return {
		schema_version: EXPERT_ROUTING_SCHEMA_VERSION,
		request_id: `req_${requestId}`,
		objective_id: objectiveId,
		task_id: taskId,
		work_class: workClass,
		worker_role: role,
		consequence,
		routing_band: routingBand,
		task_signature: taskSignature,
		required_capabilities: requiredCapabilities,
		required_tools: input.requiredTools ? [...input.requiredTools] : [],
		minimum_context_window: input.minimumContextWindow ?? null,
		fresh_context_required: Boolean(
			input.decisionSignals?.contextStale || input.decisionSignals?.independentWorkerRequired,
		),
		independence_level: independenceLevel,
		excluded_expert_ids: excludedExpertIds,
		excluded_model_refs: excludedModelRefs,
		excluded_providers: excludedProviders,
		local_only: input.localOnly ?? false,
		remote_allowed: input.remoteAllowed ?? true,
		max_cost_usd: input.maxCostUsd ?? null,
		target_latency_ms: input.targetLatencyMs ?? null,
		capability_escalation_requested: Boolean(input.decisionSignals?.capabilityEscalationRequired),
		failure_signatures: failureSignatures,
	};
}
