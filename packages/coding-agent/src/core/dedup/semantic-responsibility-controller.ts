/**
 * Semantic Responsibility Controller.
 * Orthogonal cross-cutting invariant enforcing single semantic ownership per responsibility.
 * Implements S1A-200..S1A-224, JEV-041..JEV-045.
 */

import { randomUUID } from "node:crypto";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import { SteeringProtocolError } from "../steering/types.ts";
import { noulHolds } from "../system-one/policy.ts";
import type { CandidateDiscoveryService } from "./candidate-discovery.ts";
import type { ResponsibilityRegistry } from "./responsibility-registry.ts";
import type {
	DispositionOutcome,
	PostMutationDedupVerdict,
	ResponsibilityDisposition,
	ResponsibilityRecord,
	ResponsibilityStatement,
} from "./types.ts";
import type { WaiverStore } from "./waiver-store.ts";

export class SemanticDuplicateResponsibilityError extends Error {
	readonly details: unknown;

	constructor(details: unknown) {
		super(
			`Semantic duplicate responsibility detected: ${
				typeof details === "object" && details && "reason" in details
					? String((details as { reason: unknown }).reason)
					: "Compete or duplicate responsibility without explicit waiver"
			}`,
		);
		this.name = "SemanticDuplicateResponsibilityError";
		this.details = details;
	}
}

export class ResponsibilityEvidenceInsufficientError extends Error {
	constructor() {
		super("Insufficient evidence for semantic responsibility disposition; more retrieval required.");
		this.name = "ResponsibilityEvidenceInsufficientError";
	}
}

export interface SemanticResponsibilityControllerDeps {
	readonly steering: SystemOneSteeringPlane;
	readonly registry: ResponsibilityRegistry;
	readonly discovery: CandidateDiscoveryService;
	readonly waivers: WaiverStore;
	readonly mechanicalCloneGate?: {
		assertGreen(): Promise<void> | void;
	};
}

export class SemanticResponsibilityController {
	private readonly steering: SystemOneSteeringPlane;
	readonly registry: ResponsibilityRegistry;
	private readonly discovery: CandidateDiscoveryService;
	readonly waivers: WaiverStore;
	private readonly mechanicalCloneGate?: SemanticResponsibilityControllerDeps["mechanicalCloneGate"];
	private readonly dispositions = new Map<string, ResponsibilityDisposition>();

	constructor(deps: SemanticResponsibilityControllerDeps) {
		this.steering = deps.steering;
		this.registry = deps.registry;
		this.discovery = deps.discovery;
		this.waivers = deps.waivers;
		this.mechanicalCloneGate = deps.mechanicalCloneGate;
	}

	/**
	 * Pre-implementation responsibility guard.
	 * S1A-202, S1A-208, S1A-209, S1A-210, S1A-211.
	 */
	async preImplementation(input: {
		objectiveId: string;
		taskId: string;
		proposed: ResponsibilityStatement;
		sourceRevision?: string;
		evidenceRevision?: number;
		signal?: AbortSignal;
	}): Promise<ResponsibilityDisposition> {
		if (input.signal?.aborted) {
			throw new Error("Pre-implementation responsibility check aborted.");
		}

		const evidenceRevision = input.evidenceRevision ?? 1;

		// 1. Deterministic candidate discovery (bounded to 12)
		const candidates = await this.discovery.findCandidates(input.proposed);

		// PH-139: Discovery failure cannot prove unique
		if (candidates.coverage?.coverageClass === "failed") {
			throw new SteeringProtocolError(
				"Candidate discovery failed completely; cannot prove semantic uniqueness (PH-139)",
				"JEV-041",
			);
		}

		// 2. JEV-041: Pre-implementation semantic uniqueness
		const preCert = await this.steering.requireCertificate(
			"JEV-041",
			{
				proposed: input.proposed,
				candidates: candidates.map((c) => c.compact),
				sourceRevision: input.sourceRevision ?? this.registry.getRevision(),
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
				requirePass: false,
			},
		);

		if (preCert.directive === "retrieve_more") {
			throw new ResponsibilityEvidenceInsufficientError();
		}

		// 3. JEV-042: Responsibility disposition
		const dispCert = await this.steering.requireCertificate(
			"JEV-042",
			{
				proposed: input.proposed,
				candidates: candidates.map((c) => c.compact),
				preflightResult: preCert.answers,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		// PH-140: Missing disposition fails (never default to unique)
		const dispositionChoice = (dispCert.answers.recommended_disposition as { choice?: string })?.choice;
		if (!dispositionChoice) {
			throw new SteeringProtocolError("Missing recommended_disposition in JEV-042 certificate (PH-140)", "JEV-042");
		}

		let outcome: DispositionOutcome = "unique";
		if (
			dispositionChoice === "reuse_existing" ||
			dispositionChoice === "extend_existing" ||
			dispositionChoice === "extract_shared" ||
			dispositionChoice === "separate_required" ||
			dispositionChoice === "insufficient_evidence"
		) {
			outcome = dispositionChoice;
		}

		let targetResponsibilityId: string | null = null;
		if (candidates.length > 0 && outcome !== "unique") {
			targetResponsibilityId = candidates[0].id;
		}

		// Check waiver if separate_required or duplicate
		let waiverId: string | null = null;
		const waiver = this.waivers.findValidWaiver(input.objectiveId, input.proposed, input.proposed.targetLocation);
		if (waiver) {
			// S1A-218: JEV-045 validates waiver applicability
			const waiverCert = await this.steering.requireCertificate(
				"JEV-045",
				{
					waiver,
					proposed: input.proposed,
				},
				{
					objectiveId: input.objectiveId,
					taskId: input.taskId,
					evidenceRevision,
					signal: input.signal,
				},
			);

			// PH-141: JEV-045 must include a positive waiver_valid judgment
			const waiverValidAns = waiverCert.answers.waiver_valid as { boolean?: boolean; noul?: number } | undefined;
			// A waiver lets duplicated responsibility through, so it takes a decisive yes: an undecided
			// probability is not a waiver.
			const isWaiverValid =
				typeof waiverValidAns?.boolean === "boolean"
					? waiverValidAns.boolean
					: noulHolds(waiverValidAns?.noul, "required_true");

			if (!isWaiverValid) {
				throw new SteeringProtocolError("JEV-045 evaluated waiver as invalid (PH-141)", "JEV-045");
			}

			waiverId = waiver.waiver_id;
		}

		// S1A-211: separate_required must be evidence-backed or waived
		if (outcome === "separate_required" && !waiverId) {
			const sameResp = (dispCert.answers.same_responsibility as { noul?: number })?.noul ?? 0;
			if (sameResp >= 0.7) {
				// Competing duplicate responsibility without waiver
				throw new SemanticDuplicateResponsibilityError({
					reason: `Competing responsibility requires reuse/extend/extract or explicit waiver. Cannot separate without architectural authorization.`,
				});
			}
		}

		const disposition: ResponsibilityDisposition = {
			schema_version: "1.0",
			disposition_id: `DISP-${Date.now()}-${randomUUID().slice(0, 8)}`,
			objective_id: input.objectiveId,
			task_id: input.taskId,
			proposed_responsibility: input.proposed.statement,
			candidate_ids: candidates.map((c) => c.id),
			outcome,
			target_responsibility_id: targetResponsibilityId,
			certificate_refs: [preCert.certificate_id, dispCert.certificate_id],
			waiver_id: waiverId,
		};

		this.dispositions.set(disposition.disposition_id, disposition);

		if (outcome === "unique") {
			const newRec: ResponsibilityRecord = {
				schema_version: "1.0",
				responsibility_id: `resp_${Date.now()}_${randomUUID().slice(0, 6)}`,
				statement: input.proposed.statement,
				owner_locations: [input.proposed.targetLocation],
				requirement_ids: input.proposed.requirementIds ? [...input.proposed.requirementIds] : undefined,
				inputs: input.proposed.inputs ? [...input.proposed.inputs] : undefined,
				outputs: input.proposed.outputs ? [...input.proposed.outputs] : undefined,
				side_effects: input.proposed.sideEffects ? [...input.proposed.sideEffects] : undefined,
				invariants: input.proposed.invariants ? [...input.proposed.invariants] : undefined,
				source_revision: input.sourceRevision ?? this.registry.getRevision(),
				evidence_refs: [dispCert.certificate_id],
				uniqueness_certificate_id: dispCert.certificate_id,
				status: "active",
			};
			this.registry.register(newRec);
		}

		return disposition;
	}

	/**
	 * Post-mutation responsibility guard.
	 * S1A-212, S1A-213, S1A-214, S1A-215.
	 */
	async postMutation(input: {
		objectiveId: string;
		taskId: string;
		responsibility: ResponsibilityStatement;
		mutatedFile: string;
		evidenceRevision?: number;
		signal?: AbortSignal;
	}): Promise<PostMutationDedupVerdict> {
		if (input.signal?.aborted) {
			throw new Error("Post-mutation check aborted.");
		}

		const evidenceRevision = input.evidenceRevision ?? 1;
		const candidates = await this.discovery.findCandidates(input.responsibility);

		const cert = await this.steering.requireCertificate(
			"JEV-043",
			{
				responsibility: input.responsibility,
				mutatedFile: input.mutatedFile,
				candidates: candidates.map((c) => c.compact),
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
				requirePass: false,
			},
		);

		const dupAns = cert.answers.duplicate_responsibility_introduced as
			| { noul?: number; boolean?: boolean }
			| undefined;
		if (dupAns === undefined || (dupAns.noul === undefined && dupAns.boolean === undefined)) {
			throw new SteeringProtocolError(
				"Missing duplicate_responsibility_introduced answer in JEV-043 certificate",
				"JEV-043",
			);
		}
		const duplicateIntroduced =
			typeof dupAns.boolean === "boolean" ? (dupAns.boolean ? 1.0 : 0.0) : (dupAns.noul ?? 0.0);
		const intentionalWaiverApplies = (cert.answers.intentional_waiver_applies as { noul?: number })?.noul ?? 0;

		const waiver = this.waivers.findValidWaiver(input.objectiveId, input.responsibility, input.mutatedFile);

		// The waiver has to earn its exemption: it applies when the answer settles on a yes, and an
		// undecided probability leaves the duplicate unwaived rather than excusing it at a coin flip.
		const waiverApplies = waiver !== undefined && noulHolds(intentionalWaiverApplies, "required_true");
		const isUnintentionalDuplicate = duplicateIntroduced >= 0.6 && !waiverApplies;

		const verdict: PostMutationDedupVerdict = {
			unintentionalDuplicate: isUnintentionalDuplicate,
			duplicateResponsibilityId: candidates[0]?.id,
			existingOwnerLocation: candidates[0]?.locations[0],
			certificateId: cert.certificate_id,
			reason: isUnintentionalDuplicate
				? `Mutation introduced unintentional duplicate responsibility overlapping with ${candidates[0]?.id ?? "existing owner"}`
				: "Responsibility uniqueness verified",
		};

		return verdict;
	}

	/**
	 * Cold final semantic-dedup sweep before completion.
	 * S1A-219, S1A-220, S1A-221.
	 */
	async completionSweep(input: {
		objectiveId: string;
		evidenceRevision?: number;
		signal?: AbortSignal;
	}): Promise<{ passed: boolean; checkedCount: number; certificateId: string }> {
		if (input.signal?.aborted) {
			throw new Error("Completion sweep aborted.");
		}

		// S1A-200: Current jscpd zero-clone gate must be preserved and asserted green
		if (this.mechanicalCloneGate) {
			await this.mechanicalCloneGate.assertGreen();
		}

		const activeResponsibilities = this.registry.listActive();
		const cert = await this.steering.requireCertificate(
			"JEV-044",
			{
				activeResponsibilities: activeResponsibilities.map((r) => ({
					id: r.responsibility_id,
					statement: r.statement,
					locations: r.owner_locations,
				})),
			},
			{
				objectiveId: input.objectiveId,
				evidenceRevision: input.evidenceRevision ?? 1,
				signal: input.signal,
				requirePass: false,
			},
		);

		const dupRemAns = cert.answers.unintentional_duplicate_remaining as
			| { noul?: number; boolean?: boolean }
			| undefined;
		// PH-142: Missing JEV-044 result fails
		if (dupRemAns === undefined || (dupRemAns.noul === undefined && dupRemAns.boolean === undefined)) {
			throw new SteeringProtocolError(
				"Missing unintentional_duplicate_remaining answer in JEV-044 certificate (PH-142)",
				"JEV-044",
			);
		}
		const duplicateRemaining =
			typeof dupRemAns.boolean === "boolean" ? (dupRemAns.boolean ? 1.0 : 0.0) : (dupRemAns.noul ?? 0.0);

		// S1A-220, S1A-221: Completion cannot pass semantic duplicate even if tests pass.
		// The claim being made here is "a duplicate is still present", and blocking completion on it
		// takes a decisive yes -- the same bar every other adverse judgment answers to.
		if (noulHolds(duplicateRemaining, "required_true")) {
			throw new SemanticDuplicateResponsibilityError({
				reason:
					"Cold semantic dedup sweep detected remaining unintentional duplicate responsibilities in repository.",
				certificateId: cert.certificate_id,
			});
		}

		return {
			passed: true,
			checkedCount: activeResponsibilities.length,
			certificateId: cert.certificate_id,
		};
	}
}
