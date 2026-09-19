/**
 * Capability Resolution: Wide ranking & Deep absolute-fit shortlist.
 * Implements S1A-060..S1A-066, JEV-007, and JEV-008.
 */

import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import type { CapabilityCatalog, CapabilityCatalogEntry } from "./capability-catalog.ts";
import type { EstablishedCapability } from "./types.ts";

export interface CapabilityNeed {
	readonly requiredOutcome: string;
	readonly requiredInputs?: readonly string[];
	readonly requiredOutputs?: readonly string[];
	readonly sideEffects?: readonly string[];
}

export interface WideResolutionResult {
	readonly need: CapabilityNeed;
	readonly rankedCandidates: readonly { readonly id: string; readonly probability: number }[];
	readonly needsCapability: boolean;
	readonly certificateId: string;
}

export interface DeepResolutionResult {
	readonly need: CapabilityNeed;
	readonly shortlistedCandidates: readonly CapabilityCatalogEntry[];
	readonly absoluteFits: Record<string, number>;
	readonly establishedCapability?: EstablishedCapability;
	readonly gapRemains: boolean;
	readonly certificateId: string;
}

export class CapabilityResolver {
	private readonly catalog: CapabilityCatalog;
	private readonly steering: SystemOneSteeringPlane;

	constructor(catalog: CapabilityCatalog, steering: SystemOneSteeringPlane) {
		this.catalog = catalog;
		this.steering = steering;
	}

	/**
	 * Wide pass over compact roster.
	 * S1A-061, S1A-062.
	 */
	async rankWide(
		need: CapabilityNeed,
		options: { objectiveId?: string; taskId?: string; signal?: AbortSignal } = {},
	): Promise<WideResolutionResult> {
		if (options.signal?.aborted) {
			throw new Error("Capability resolution aborted.");
		}

		const roster = this.catalog.compactRoster();

		const cert = await this.steering.requireCertificate(
			"JEV-007",
			{
				need,
				roster,
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				signal: options.signal,
			},
		);

		const needsCap = (cert.answers.needs_capability as { noul?: number })?.noul ?? 0.8;
		const whichChoice = (cert.answers.which_candidate as { choice?: string })?.choice;

		// Rank candidates by relevance
		const rankedCandidates = roster
			.map((c) => {
				const id = String(c.id);
				const probability = id === whichChoice ? 0.9 : 0.1;
				return { id, probability };
			})
			.sort((a, b) => b.probability - a.probability);

		return {
			need,
			rankedCandidates,
			needsCapability: needsCap >= 0.5,
			certificateId: cert.certificate_id,
		};
	}

	/**
	 * Deep pass over top candidates with absolute-fit gates.
	 * S1A-063, S1A-064, S1A-065, S1A-066.
	 */
	async rerankDeep(
		need: CapabilityNeed,
		wide: WideResolutionResult,
		options: { objectiveId?: string; taskId?: string; signal?: AbortSignal } = {},
	): Promise<DeepResolutionResult> {
		if (options.signal?.aborted) {
			throw new Error("Capability resolution aborted.");
		}

		// Take top 3-5 candidates
		const topIds = wide.rankedCandidates.slice(0, 5).map((c) => c.id);
		const shortlistedCandidates: CapabilityCatalogEntry[] = [];
		for (const id of topIds) {
			const entry = this.catalog.get(id);
			if (entry) {
				shortlistedCandidates.push(entry);
			}
		}

		const cert = await this.steering.requireCertificate(
			"JEV-008",
			{
				need,
				candidates: shortlistedCandidates.map((c) => ({
					id: c.capabilityId,
					kind: c.kind,
					purpose: c.purpose,
					inputShape: c.inputShape,
					outputShape: c.outputShape,
				})),
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				signal: options.signal,
			},
		);

		const answers = cert.answers;
		const absoluteFits: Record<string, number> = {};
		for (const candidate of shortlistedCandidates) {
			const fitKey = `fits::${candidate.capabilityId}`;
			const fitNoul = (answers[fitKey] as { noul?: number })?.noul ?? 0.2;
			absoluteFits[candidate.capabilityId] = fitNoul;
		}

		const bestFitId = (answers.which_candidate as { choice?: string })?.choice;
		const bestFitScore = bestFitId ? (absoluteFits[bestFitId] ?? 0) : 0;
		const gapRemains = (answers.gap_remains as { noul?: number })?.noul ?? (bestFitScore < 0.7 ? 1.0 : 0.0);

		// S1A-065: Shortlist can reject all if below absolute fit threshold
		if (!gapRemains && bestFitId && bestFitScore >= 0.7) {
			const entry = this.catalog.get(bestFitId);
			if (entry) {
				const established: EstablishedCapability = {
					capabilityId: entry.capabilityId,
					kind: entry.kind,
					lifetime: entry.lifetime,
					spec: entry.spec ?? {
						schema_version: "1.0",
						capability_id: entry.capabilityId,
						version: "1.0",
						kind: entry.kind,
						lifetime: entry.lifetime,
						purpose: entry.purpose,
						interface: { inputs: entry.inputShape, outputs: entry.outputShape },
						side_effects: [...entry.sideEffects],
						denied_behavior: [],
						proof: { deterministic_tests: ["test_smoke"], task_specific_test: "test_task" },
						activation: {},
						rollback: {},
					},
					record: entry.record ?? {
						schema_version: "1.0",
						capability_id: entry.capabilityId,
						version: "1.0",
						kind: entry.kind,
						state: "active_global",
						artifact_digest: "digest_preexisting",
						certificate_refs: [cert.certificate_id],
						created_at: new Date().toISOString(),
					},
					isExisting: true,
				};

				return {
					need,
					shortlistedCandidates,
					absoluteFits,
					establishedCapability: established,
					gapRemains: false,
					certificateId: cert.certificate_id,
				};
			}
		}

		return {
			need,
			shortlistedCandidates,
			absoluteFits,
			gapRemains: true,
			certificateId: cert.certificate_id,
		};
	}
}
