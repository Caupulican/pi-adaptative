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

		for (const model of allModels) {
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

			for (const thinkingLevel of thinkingLevels) {
				const descriptor = materializeExpertDescriptor({
					provider: model.provider,
					modelId: model.id,
					role: request.worker_role,
					thinkingLevel,
					runtimeKind,
					capabilityClass: profile.class,
					capabilityTier: tier,
					toolNames: request.required_tools ?? [],
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

		// Calculate approximate cost per token or call
		const costPerMillion = model.cost?.input ? model.cost.input * 1_000_000 : 0;
		const estimatedCostUsd = costPerMillion > 0 ? (costPerMillion / 1_000_000) * 2000 : 0;

		return {
			authenticated,
			quotaExhausted,
			providerHealthy: !quotaExhausted,
			localRuntimeWarm: true,
			estimatedCostUsd,
			estimatedLatencyMs: model.reasoning ? 1500 : 500,
			concurrencySlotsAvailable: 5,
		};
	}
}
