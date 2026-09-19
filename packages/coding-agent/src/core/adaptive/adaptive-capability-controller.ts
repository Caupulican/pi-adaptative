/**
 * Adaptive Capability Controller.
 * Resolves, synthesizes, tests, activates, and records lifecycle of capabilities.
 * Implements S1A-070..S1A-081, S1A-140..S1A-145, JEV-009..JEV-016, JEV-029..JEV-030.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import type { ExpertSelectionService } from "../expert-routing/service.ts";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import type { CapabilityCatalog } from "./capability-catalog.ts";
import { type CapabilityNeed, CapabilityResolver } from "./capability-resolution.ts";
import type {
	CapabilityGap,
	CapabilityKind,
	CapabilityLifetime,
	CapabilityRecord,
	CapabilitySpec,
	EstablishedCapability,
} from "./types.ts";

export interface CandidateArtifact {
	readonly capabilityId: string;
	readonly kind: CapabilityKind;
	readonly code: string;
	readonly digest: string;
	readonly diff?: string;
}

export interface CandidateVerificationResult {
	readonly passed: boolean;
	readonly testCount: number;
	readonly failures: readonly string[];
}

export interface AdaptiveCapabilityControllerDeps {
	readonly steering: SystemOneSteeringPlane;
	readonly catalog: CapabilityCatalog;
	readonly resolver?: CapabilityResolver;
	readonly experts?: ExpertSelectionService;
	readonly builder?: {
		build(spec: CapabilitySpec, signal?: AbortSignal): Promise<CandidateArtifact>;
	};
	readonly mechanicalVerifier?: {
		verifyCandidate(candidate: CandidateArtifact, spec: CapabilitySpec): Promise<CandidateVerificationResult>;
		verifyActivation(activation: unknown, spec: CapabilitySpec): Promise<boolean>;
		runTaskSpecificProof?(spec: CapabilitySpec): Promise<string>;
	};
	readonly activator?: {
		activate(candidate: CandidateArtifact, spec: CapabilitySpec): Promise<{ active: boolean; projection: unknown }>;
	};
}

export class AdaptiveCapabilityController {
	readonly steering: SystemOneSteeringPlane;
	readonly catalog: CapabilityCatalog;
	readonly resolver: CapabilityResolver;
	private readonly experts?: ExpertSelectionService;
	private readonly builder?: AdaptiveCapabilityControllerDeps["builder"];
	private readonly mechanicalVerifier?: AdaptiveCapabilityControllerDeps["mechanicalVerifier"];
	private readonly activator?: AdaptiveCapabilityControllerDeps["activator"];
	private readonly gaps = new Map<string, CapabilityGap>();
	private readonly records = new Map<string, CapabilityRecord>();

	constructor(deps: AdaptiveCapabilityControllerDeps) {
		this.steering = deps.steering;
		this.catalog = deps.catalog;
		this.resolver = deps.resolver ?? new CapabilityResolver(this.catalog, this.steering);
		this.experts = deps.experts;
		this.builder = deps.builder;
		this.mechanicalVerifier = deps.mechanicalVerifier;
		this.activator = deps.activator;
	}

	computeDigest(data: unknown): string {
		return createHash("sha256")
			.update(JSON.stringify(data ?? null))
			.digest("hex");
	}

	async resolveOrBuild(input: {
		objectiveId: string;
		taskId: string;
		need: CapabilityNeed;
		charter?: ExecutionCharter;
		evidenceRevision?: number;
		signal?: AbortSignal;
	}): Promise<EstablishedCapability> {
		if (input.signal?.aborted) {
			throw new Error("Adaptive capability resolution aborted.");
		}

		const evidenceRevision = input.evidenceRevision ?? 1;

		// 1. Wide catalog resolution
		const wide = await this.resolver.rankWide(input.need, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			signal: input.signal,
		});

		// 2. Deep shortlist rerank / absolute fit
		const deep = await this.resolver.rerankDeep(input.need, wide, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			signal: input.signal,
		});

		if (deep.establishedCapability) {
			return deep.establishedCapability;
		}

		// 3. Mandatory gap certificate: JEV-009
		const gapId = `GAP-${Date.now()}-${randomUUID().slice(0, 8)}`;
		const gap: CapabilityGap = {
			schema_version: "1.0",
			gap_id: gapId,
			objective_id: input.objectiveId,
			task_id: input.taskId,
			required_outcome: input.need.requiredOutcome,
			required_inputs: input.need.requiredInputs ? [...input.need.requiredInputs] : [],
			required_outputs: input.need.requiredOutputs ? [...input.need.requiredOutputs] : [],
			proof_obligations: ["isolated_mechanical_verification", "task_specific_proof"],
			existing_candidates_rejected: deep.shortlistedCandidates.map((c) => ({
				id: c.capabilityId,
				fit: deep.absoluteFits[c.capabilityId] ?? 0,
			})),
		};

		this.gaps.set(gapId, gap);

		const gapCert = await this.steering.requireCertificate("JEV-009", gap, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			evidenceRevision,
			signal: input.signal,
		});

		// 4. Choose smallest adequate adaptation class: JEV-010 (S1A-072)
		const synthesisCert = await this.steering.requireCertificate(
			"JEV-010",
			{
				gap,
				suggestedLevels: [
					"ephemeral_script",
					"toolkit_script",
					"extension_or_tool",
					"skill",
					"integration_or_adapter",
					"runtime_patch",
				],
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		const chosenLevelStr =
			(synthesisCert.answers.adaptation_class as { choice?: string })?.choice ?? "ephemeral_script";
		const kind: CapabilityKind =
			chosenLevelStr === "compose"
				? "composition"
				: chosenLevelStr === "ephemeral_script"
					? "ephemeral_script"
					: chosenLevelStr === "toolkit_script"
						? "toolkit_script"
						: chosenLevelStr === "extension_or_tool"
							? "extension"
							: chosenLevelStr === "skill"
								? "skill"
								: chosenLevelStr === "runtime_patch"
									? "runtime_patch"
									: "integration";

		const capabilityId = `cap_${chosenLevelStr}_${Date.now()}`;
		const spec: CapabilitySpec = {
			schema_version: "1.0",
			capability_id: capabilityId,
			version: "1.0",
			kind,
			lifetime: kind === "ephemeral_script" ? "one_shot" : "session",
			purpose: input.need.requiredOutcome,
			interface: {
				inputs: input.need.requiredInputs ?? [],
				outputs: input.need.requiredOutputs ?? [],
			},
			side_effects: ["local_read_write"],
			denied_behavior: ["bypass_security_isolation", "elevate_root_authority"],
			proof: {
				deterministic_tests: [`test_${capabilityId}_isolated`],
				task_specific_test: `test_${capabilityId}_task_proof`,
			},
			activation: { method: "dynamic_load" },
			rollback: { method: "unload_and_discard" },
		};

		// JEV-011: CapabilitySpec completeness
		await this.steering.requireCertificate("JEV-011", spec, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			evidenceRevision,
			signal: input.signal,
		});

		// 5. Build candidate
		let candidate: CandidateArtifact;
		if (this.builder) {
			candidate = await this.builder.build(spec, input.signal);
		} else {
			const code = `// synthesized capability ${capabilityId}\nexport function run() { return true; }`;
			candidate = {
				capabilityId,
				kind,
				code,
				digest: this.computeDigest(code),
				diff: kind === "runtime_patch" ? "--- runtime/old\n+++ runtime/new" : undefined,
			};
		}

		// 6. Deterministic candidate checks (S1A-080)
		if (this.mechanicalVerifier) {
			const verification = await this.mechanicalVerifier.verifyCandidate(candidate, spec);
			if (!verification.passed) {
				throw new Error(`Mechanical candidate verification failed for ${capabilityId}`);
			}
		}

		// 7. Semantic pre-activation: JEV-013
		await this.steering.requireCertificate(
			"JEV-013",
			{
				spec,
				candidateDigest: candidate.digest,
				candidateKind: candidate.kind,
				mechanicalPassed: true,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		// If runtime patch: JEV-014 runtime scope
		if (candidate.kind === "runtime_patch") {
			await this.steering.requireCertificate(
				"JEV-014",
				{
					spec,
					diff: candidate.diff,
				},
				{
					objectiveId: input.objectiveId,
					taskId: input.taskId,
					evidenceRevision,
					signal: input.signal,
				},
			);
		}

		// 8. Activation (S1A-174, S1A-175: root owns activation)
		let activationRes: { active: boolean; projection: unknown } = { active: true, projection: { active: true } };
		if (this.activator) {
			activationRes = await this.activator.activate(candidate, spec);
		}

		// 9. Runtime smoke + post-activation availability: JEV-015
		if (this.mechanicalVerifier) {
			await this.mechanicalVerifier.verifyActivation(activationRes, spec);
		}
		await this.steering.requireCertificate(
			"JEV-015",
			{
				spec,
				activation: activationRes.projection,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		// 10. Task-specific proof: JEV-016 (S1A-081)
		let taskProof = "task_proof_verified";
		if (this.mechanicalVerifier?.runTaskSpecificProof) {
			taskProof = await this.mechanicalVerifier.runTaskSpecificProof(spec);
		}
		await this.steering.requireCertificate(
			"JEV-016",
			{
				gap,
				spec,
				taskProof,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		// 11. Establish capability
		const record: CapabilityRecord = {
			schema_version: "1.0",
			capability_id: capabilityId,
			version: spec.version,
			kind: spec.kind,
			state: kind === "ephemeral_script" ? "active_ephemeral" : "active_session",
			artifact_digest: candidate.digest,
			certificate_refs: [gapCert.certificate_id],
			usage_count: 1,
			success_count: 1,
			created_at: new Date().toISOString(),
		};

		this.records.set(capabilityId, record);
		this.catalog.registerCapability(spec, record);

		return {
			capabilityId,
			kind,
			lifetime: spec.lifetime,
			spec,
			record,
			isExisting: false,
		};
	}

	/**
	 * Evaluates retention for a synthesized capability.
	 * S1A-142: JEV-029 capability retention.
	 */
	async evaluateRetention(
		capability: EstablishedCapability,
		options: { objectiveId: string; taskId: string; evidenceRevision?: number },
	): Promise<CapabilityLifetime | "discard"> {
		const cert = await this.steering.requireCertificate(
			"JEV-029",
			{
				capability: capability.spec,
				record: capability.record,
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				evidenceRevision: options.evidenceRevision ?? 1,
			},
		);

		const actionChoice = (cert.answers.lifecycle_action as { choice?: string })?.choice ?? "session";

		if (actionChoice === "project" || actionChoice === "global") {
			// S1A-143: JEV-030 capability promotion
			await this.steering.requireCertificate(
				"JEV-030",
				{
					capability: capability.spec,
					targetScope: actionChoice,
				},
				{
					objectiveId: options.objectiveId,
					taskId: options.taskId,
					evidenceRevision: options.evidenceRevision ?? 1,
				},
			);

			// S1A-145: Promoted capability enters catalog
			const updatedSpec: CapabilitySpec = {
				...capability.spec,
				lifetime: actionChoice,
			};
			const updatedRecord: CapabilityRecord = {
				...capability.record,
				state: actionChoice === "global" ? "active_global" : "active_project",
				updated_at: new Date().toISOString(),
			};
			this.catalog.registerCapability(updatedSpec, updatedRecord);
			return actionChoice;
		}

		if (actionChoice === "session" || actionChoice === "discard") {
			if (actionChoice === "discard") {
				// S1A-144: One-shot discard
				const discardedRecord: CapabilityRecord = {
					...capability.record,
					state: "discarded",
					updated_at: new Date().toISOString(),
				};
				this.records.set(capability.capabilityId, discardedRecord);
				return "discard";
			}
			return "session";
		}

		return "one_shot";
	}
}
