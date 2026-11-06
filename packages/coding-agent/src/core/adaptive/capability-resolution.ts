/**
 * Capability Resolution: Wide ranking & Deep absolute-fit shortlist.
 * Implements S1A-060..S1A-066, JEV-007, and JEV-008.
 */

import { noulProbability, readNoul, settledFromBand } from "../decision/noul.ts";
import { choiceAct } from "../decision/thresholds.ts";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import { noulHolds } from "../system-one/policy.ts";
import type { CapabilityCatalog, CapabilityCatalogEntry } from "./capability-catalog.ts";
import type { CapabilityKind, EstablishedCapability } from "./types.ts";

export interface CapabilityNeed {
	readonly requiredOutcome: string;
	readonly kind?: CapabilityKind;
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

	private normalizeNeed(need: CapabilityNeed) {
		return {
			requiredOutcome: need.requiredOutcome,
			...(need.kind !== undefined ? { kind: need.kind } : {}),
			...(need.requiredInputs !== undefined ? { requiredInputs: need.requiredInputs } : {}),
			...(need.requiredOutputs !== undefined ? { requiredOutputs: need.requiredOutputs } : {}),
			...(need.sideEffects !== undefined ? { sideEffects: need.sideEffects } : {}),
		};
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
				need: this.normalizeNeed(need),
				roster,
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				signal: options.signal,
			},
		);

		const whichCandidateAns = cert.answers.which_candidate as
			| {
					choice?: string;
					probabilities?: Record<string, number>;
			  }
			| undefined;

		const probabilities = whichCandidateAns?.probabilities ?? {};
		const selectedChoice = whichCandidateAns?.choice;

		// PH-068, PH-070: Rank candidates by real choice probabilities or selected choice without synthetic 0.9/0.1
		const rankedCandidates = roster
			.map((c) => {
				const id = String(c.id);
				const probability =
					typeof probabilities[id] === "number" ? probabilities[id] : id === selectedChoice ? 1.0 : 0.0;
				return { id, probability };
			})
			.sort((a, b) => b.probability - a.probability);

		return {
			need,
			rankedCandidates,
			// A settled yes, not a coin flip and not an unasked question: synthesising a capability on
			// ignorance is expensive work nobody asked for.
			needsCapability: noulHolds(cert.answers.needs_capability, "required_true"),
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

		// Take top candidates
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
				need: this.normalizeNeed(need),
				candidates: shortlistedCandidates.map((c) => ({
					id: c.capabilityId,
					kind: c.kind,
					purpose: c.purpose,
					...(c.inputShape !== undefined ? { inputShape: c.inputShape } : {}),
					...(c.outputShape !== undefined ? { outputShape: c.outputShape } : {}),
				})),
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				signal: options.signal,
			},
		);

		const answers = cert.answers;
		// A candidate's absolute fit is only what System One answered: an unanswered fit is absent, never 0.
		const absoluteFits: Record<string, number> = {};
		for (const candidate of shortlistedCandidates) {
			const fit = noulProbability(answers[`fits::${candidate.capabilityId}`]);
			if (fit !== undefined) absoluteFits[candidate.capabilityId] = fit;
		}

		// The pick is acted on at the reversible floor on P(chosen option); its absolute fit must settle a
		// yes on the advisory family (pass at 0.7).
		const pick = choiceAct(answers.which_candidate, undefined, "reversible");
		const bestFitId =
			pick === "act" ? (answers.which_candidate as { choice?: string } | undefined)?.choice : undefined;
		const bestFit = bestFitId ? readNoul(answers[`fits::${bestFitId}`], "required_true", "advisory") : "unasked";
		// gap_remains asks whether a gap is still present; the required end is "no gap". The band gives the
		// truth of the proposition (a gap is present); an unasked or undecided answer falls back to the
		// best fit rather than inventing a verdict from a probability that settled nothing.
		const gapReading = readNoul(answers.gap_remains, "required_false");
		const gapSettled = gapReading === "unasked" ? undefined : settledFromBand(gapReading, "required_false");
		const gapRemains = gapSettled ?? bestFit !== "hard_pass";
		this.steering.noteDecision(
			cert.certificate_id,
			`capability ${gapRemains ? "gap remains" : `fits ${bestFitId}`}`,
			[
				{ id: "which_candidate", result: `${pick}${bestFitId ? ` ${bestFitId}` : ""}`, decided: pick !== "act" },
				{ id: "best_fit", result: bestFit, decided: gapSettled === undefined },
				{ id: "gap_remains", result: gapReading, decided: gapSettled !== undefined },
			],
		);

		// S1A-065: Shortlist can reject all if below absolute fit threshold
		if (!gapRemains && bestFitId && bestFit === "hard_pass") {
			const entry = this.catalog.get(bestFitId);
			// PH-071: Catalog entry becomes established only with current:
			// - CapabilitySpec
			// - artifact/provenance
			// - active state
			// - proof/certificate lineage
			// Never fabricate missing spec, digest, smoke test or active record.
			if (entry?.spec && entry.record) {
				const activeStates = new Set([
					"active_ephemeral",
					"active_session",
					"active_project",
					"active_global",
					"verified",
				]);
				const hasValidState = activeStates.has(entry.record.state);
				const hasArtifact = Boolean(entry.record.artifact_digest && entry.record.artifact_digest.length > 0);
				const hasCertLineage =
					Array.isArray(entry.record.certificate_refs) && entry.record.certificate_refs.length > 0;
				const hasProof = Boolean(entry.spec.proof?.task_specific_test);

				if (hasValidState && hasArtifact && hasCertLineage && hasProof) {
					const established: EstablishedCapability = {
						capabilityId: entry.capabilityId,
						kind: entry.kind,
						lifetime: entry.lifetime,
						spec: entry.spec,
						record: entry.record,
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
