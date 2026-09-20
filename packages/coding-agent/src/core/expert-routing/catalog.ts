/**
 * Expert Catalog Materialization.
 * Implements EXPERT_CATALOG.md and HMOE-020 through HMOE-028.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { resolveCapabilityTier } from "../capability-tier.ts";
import { deriveModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ModelAdaptationStore } from "../models/adaptation-store.ts";
import type { FitnessStore } from "../models/fitness-store.ts";
import type { WorkerModelPinPolicy } from "../orchestration/worker-model-pins.ts";
import type {
	ExpertCandidate,
	ExpertCandidateState,
	ExpertPrivacyClass,
	ExpertRuntimeKind,
	WorkerCapabilityRequest,
} from "./contracts.ts";
import { materializeExpertDescriptor } from "./expert-identity.ts";
import { defaultModelFamilyResolver } from "./independence.ts";

export interface ExpertCatalogDeps {
	modelRegistry?: ModelRegistry;
	fitnessStore?: FitnessStore;
	adaptationStore?: ModelAdaptationStore;
	modelPinPolicy?: WorkerModelPinPolicy;
	isModelExhausted?: (model: Model<Api>) => boolean;
	localRuntimeKeys?: readonly string[];
}

export class ExpertCatalog {
	private readonly deps: ExpertCatalogDeps;

	constructor(deps: ExpertCatalogDeps = {}) {
		this.deps = deps;
	}

	/**
	 * Materializes candidate experts for a given WorkerCapabilityRequest.
	 * Dynamically generates candidates without Cartesian explosion.
	 */
	async materializeCandidates(request: WorkerCapabilityRequest): Promise<readonly ExpertCandidate[]> {
		const allModels = this.deps.modelRegistry ? this.deps.modelRegistry.getAll() : [];
		const candidates: ExpertCandidate[] = [];
		// The operator's pool is a hard boundary applied at generation, so ranking is bounded early
		// rather than picking broadly and rejecting afterwards.
		const allowed = request.allowed_model_refs ? new Set(request.allowed_model_refs) : undefined;

		for (const model of allModels) {
			if (allowed && !allowed.has(`${model.provider}/${model.id}`)) {
				continue;
			}
			const runtimeKind = this._classifyRuntimeKind(model);
			const privacyClass = this._classifyPrivacyClass(runtimeKind);

			// Fast-path filter on local/remote constraints
			if (request.local_only && runtimeKind === "remote") {
				continue;
			}
			if (request.remote_allowed === false && runtimeKind === "remote") {
				continue;
			}

			// Determine candidate thinking levels for this model & work class
			const thinkingLevels = this._resolveCandidateThinkingLevels(model, request);

			const profile = deriveModelCapabilityProfile(model);
			const tier = resolveCapabilityTier({ capabilityClass: profile.class });
			const realToolSurface = this._resolveCandidateToolSurface(model, request.worker_role, profile);
			const modelFamily = defaultModelFamilyResolver(model.id, model.provider) ?? null;

			for (const thinkingLevel of thinkingLevels) {
				const descriptor = materializeExpertDescriptor({
					provider: model.provider,
					modelId: model.id,
					role: request.worker_role,
					thinkingLevel,
					runtimeKind,
					modelFamily,
					capabilityClass: profile.class,
					capabilityTier: tier,
					toolNames: realToolSurface,
					resourceProfiles: [],
					contextWindow: model.contextWindow ?? null,
					privacyClass,
					hostKey: runtimeKind !== "remote" ? (this.deps.localRuntimeKeys?.[0] ?? "local_host") : null,
				});

				const candidateState = this._resolveCandidateState(model);

				candidates.push({
					descriptor,
					state: candidateState,
				});
			}
		}

		return candidates;
	}

	private _resolveCandidateToolSurface(
		model: Model<Api>,
		role: string,
		profile: ReturnType<typeof deriveModelCapabilityProfile>,
	): readonly string[] {
		if (
			profile.class === "minimal" ||
			(model.textToolCallProtocol === false && !model.reasoning && model.input.length === 0)
		) {
			return [];
		}
		if (role === "investigate" || role === "research" || role === "retrieval") {
			return ["read", "grep", "find", "ls", "repo_read"];
		}
		if (role === "verifier" || role === "review") {
			return ["read", "grep", "find", "ls", "repo_read", "run_process", "bash"];
		}
		// implementer / generalist / worker
		return ["read", "grep", "find", "ls", "repo_read", "write", "edit", "bash", "run_process"];
	}

	private _classifyRuntimeKind(model: Model<Api>): ExpertRuntimeKind {
		const p = model.provider.toLowerCase();
		if (p === "ollama" || p === "llama.cpp" || p === "llamacpp") {
			return "local";
		}
		if (p === "vllm" || p === "local-managed" || p === "managed-local") {
			return "managed-local";
		}
		return "remote";
	}

	private _classifyPrivacyClass(kind: ExpertRuntimeKind): ExpertPrivacyClass {
		if (kind === "local" || kind === "managed-local") {
			return "local_only";
		}
		return "remote_allowed";
	}

	private _resolveCandidateThinkingLevels(model: Model<Api>, request: WorkerCapabilityRequest): readonly string[] {
		if (!model.reasoning) {
			return ["off"];
		}

		if (request.consequence === "critical" || request.work_class === "verify" || request.work_class === "review") {
			return ["high", "medium"];
		}

		if (request.work_class === "investigate" || request.work_class === "implement") {
			return ["medium", "low"];
		}

		return ["low", "off"];
	}

	private _resolveCandidateState(model: Model<Api>): ExpertCandidateState {
		const authenticated = this.deps.modelRegistry ? this.deps.modelRegistry.hasConfiguredAuth(model) : true;
		const quotaExhausted = this.deps.isModelExhausted ? this.deps.isModelExhausted(model) : false;
		// Subscription truth is the registry's canonical ownership, never a hand-written provider list.
		const subscriptionBacked =
			typeof this.deps.modelRegistry?.isUsingSubscription === "function"
				? this.deps.modelRegistry.isUsingSubscription(model)
				: false;

		// Calculate approximate cost per token or call with explicit provenance
		const costPerMillion = model.cost?.input ? model.cost.input * 1_000_000 : 0;
		const estimatedCostUsd = costPerMillion > 0 ? (costPerMillion / 1_000_000) * 2000 : 0;
		const costProvenance = model.cost?.input ? "provider_pricing" : "unknown";

		// Latency from adaptation perf if present, otherwise unknown/fallback
		const store = this.deps.adaptationStore as any;
		const adaptationProfile =
			typeof store?.getProfile === "function" ? store.getProfile(model.id) : store?.get?.(model.id);
		const perf = adaptationProfile?.perf;
		const estimatedLatencyMs = perf?.meanMs && perf.meanMs > 0 ? perf.meanMs : model.reasoning ? 1500 : 500;
		const latencyProvenance = perf?.meanMs && perf.meanMs > 0 ? "measured_host" : "unknown";

		return {
			authenticated,
			quotaExhausted,
			providerHealthy: !quotaExhausted,
			localRuntimeWarm: true,
			estimatedCostUsd,
			estimatedLatencyMs,
			costProvenance,
			latencyProvenance,
			concurrencySlotsAvailable: 5,
			subscriptionBacked,
		};
	}
}
