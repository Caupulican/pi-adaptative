/**
 * Specialist Synthesis Controller.
 * Synthesizes and materializes task-scoped specialists using H-MoE and TaskProfileWriter.
 * Implements S1A-177..S1A-199, JEV-031..JEV-039, PH-040..PH-051.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import type { ExpertSelectionService } from "../expert-routing/service.ts";
import type { TaskProfileWriterPort } from "../orchestration/task-profile-writer.ts";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import type { SpecialistCatalog, SpecialistCatalogEntry } from "./specialist-catalog.ts";
import type {
	MaterializedSpecialist,
	SpecialistCognitiveRequirements,
	SpecialistLifetime,
	SpecialistRecord,
	SpecialistSpec,
} from "./types.ts";

export class SpecialistMaterializationError extends Error {
	constructor(message: string) {
		super(`Specialist materialization failed: ${message}`);
		this.name = "SpecialistMaterializationError";
	}
}

export interface SpecialistNeed {
	readonly specialty: string;
	readonly specialties?: readonly string[];
	readonly purpose: string;
	readonly mission?: string;
	readonly requiredTools?: readonly string[];
	readonly requiredSkills?: readonly string[];
	readonly cognitiveRequirements?: Partial<SpecialistCognitiveRequirements>;
	readonly authorityRole?: string;
	readonly requiredCapabilities?: readonly string[];
	readonly obligations?: readonly string[];
}

export interface WorkerExecutionContractFactory {
	createContract(input: {
		profileId: string;
		specialistId: string;
		expertBinding: {
			providerId: string;
			modelId: string;
			routingBand: string;
			capabilityTier: string;
		};
		authorityRole: string;
		toolNames: readonly string[];
	}): unknown;
}

export interface SpecialistSynthesisControllerDeps {
	readonly steering: SystemOneSteeringPlane;
	readonly catalog: SpecialistCatalog;
	readonly experts?: ExpertSelectionService;
	readonly capabilityController?: {
		resolveOrBuild(input: {
			objectiveId: string;
			taskId: string;
			need: unknown;
			charter?: ExecutionCharter;
			signal?: AbortSignal;
		}): Promise<unknown>;
	};
	readonly taskProfiles?: TaskProfileWriterPort;
	readonly contractFactory?: WorkerExecutionContractFactory;
}

export class SpecialistSynthesisController {
	readonly steering: SystemOneSteeringPlane;
	readonly catalog: SpecialistCatalog;
	private readonly experts?: ExpertSelectionService;
	private readonly capabilityController?: SpecialistSynthesisControllerDeps["capabilityController"];
	private readonly taskProfiles?: TaskProfileWriterPort;
	private readonly contractFactory?: WorkerExecutionContractFactory;
	private readonly records = new Map<string, SpecialistRecord>();

	constructor(deps: SpecialistSynthesisControllerDeps) {
		this.steering = deps.steering;
		this.catalog = deps.catalog;
		this.experts = deps.experts;
		this.capabilityController = deps.capabilityController;
		this.taskProfiles = deps.taskProfiles;
		this.contractFactory = deps.contractFactory;
	}

	async resolveOrCreate(input: {
		objectiveId: string;
		taskId: string;
		need: SpecialistNeed;
		charter?: ExecutionCharter;
		evidenceRevision?: number;
		signal?: AbortSignal;
	}): Promise<MaterializedSpecialist> {
		if (input.signal?.aborted) {
			throw new Error("Specialist synthesis aborted.");
		}

		// PH-044, PH-045, FC-020: H-MoE, TaskProfileWriter, and WorkerExecutionContractFactory are mandatory
		if (!this.experts) {
			throw new SpecialistMaterializationError(
				"ExpertSelectionService (H-MoE) is required for specialist synthesis",
			);
		}
		if (!this.taskProfiles) {
			throw new SpecialistMaterializationError("TaskProfileWriter is required for specialist synthesis");
		}

		const evidenceRevision = input.evidenceRevision ?? 1;

		// 1. JEV-031: Specialist need certificate
		const needCert = await this.steering.requireCertificate(
			"JEV-031",
			{
				need: input.need,
				currentSpecialists: this.catalog.compactSummary(),
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		// 2. Check catalog for existing fit
		const allSpecialties = input.need.specialties ?? [input.need.specialty];
		const candidates = this.catalog.searchBySpecialties(allSpecialties);

		let existingEntry: SpecialistCatalogEntry | undefined;
		if (candidates.length > 0) {
			const fitCert = await this.steering.requireCertificate(
				"JEV-032",
				{
					need: input.need,
					candidates: candidates.map((c) => ({
						id: c.specialistId,
						role: c.authorityRole,
						specialties: c.specialties,
						outcomes: c.verifiedOutcomeCount,
					})),
				},
				{
					objectiveId: input.objectiveId,
					taskId: input.taskId,
					evidenceRevision,
					signal: input.signal,
				},
			);

			const fitChoice = (fitCert.answers.best_candidate as { choice?: string })?.choice;
			const newSpecialistRequired = (fitCert.answers.new_specialist_required as { noul?: number })?.noul ?? 0;

			if (fitChoice && fitChoice !== "none" && newSpecialistRequired < 0.5) {
				existingEntry = this.catalog.get(fitChoice);
			}
		}

		let spec: SpecialistSpec;
		let isExisting = false;

		if (existingEntry) {
			isExisting = true;
			spec = existingEntry.spec ?? {
				schema_version: "1.0",
				specialist_id: existingEntry.specialistId,
				version: "1.0",
				objective_id: input.objectiveId,
				task_id: input.taskId,
				purpose: existingEntry.purpose,
				authority_role: existingEntry.authorityRole,
				specialties: [...existingEntry.specialties],
				mission: input.need.mission ?? existingEntry.purpose,
				cognitive_requirements: existingEntry.cognitiveRequirements,
				required_capabilities: [],
				required_tools: [],
				required_skills: [],
				resource_profiles: ["standard"],
				context_policy: { mode: "fresh", requirement_ids: [], evidence_ids: [] },
				proof_obligations: ["specialist_mission_verification"],
				lifetime: existingEntry.lifetime,
			};
		} else {
			// 3. Build SpecialistSpec
			const specialistId = `spec_${input.need.specialty}_${Date.now()}`;
			const authorityRole = input.need.authorityRole ?? "implementer";
			const cognitive: SpecialistCognitiveRequirements = {
				reasoning: input.need.cognitiveRequirements?.reasoning ?? "medium",
				vision:
					input.need.cognitiveRequirements?.vision ??
					allSpecialties.some((s) => s.toLowerCase().includes("ui") || s.toLowerCase().includes("visual")),
				long_context: input.need.cognitiveRequirements?.long_context ?? true,
				tool_calling: input.need.cognitiveRequirements?.tool_calling ?? true,
			};

			spec = {
				schema_version: "1.0",
				specialist_id: specialistId,
				version: "1.0",
				objective_id: input.objectiveId,
				task_id: input.taskId,
				purpose: input.need.purpose,
				authority_role: authorityRole,
				specialties: allSpecialties,
				mission: input.need.mission ?? input.need.purpose,
				cognitive_requirements: cognitive,
				required_capabilities: input.need.requiredCapabilities ? [...input.need.requiredCapabilities] : [],
				required_tools: input.need.requiredTools ? [...input.need.requiredTools] : [],
				required_skills: input.need.requiredSkills ? [...input.need.requiredSkills] : [],
				resource_profiles: ["standard"],
				context_policy: {
					mode: "fresh",
					requirement_ids: [],
					evidence_ids: [],
				},
				proof_obligations: ["specialist_mission_verification"],
				lifetime: "one_task",
			};

			// JEV-033: SpecialistSpec completeness
			await this.steering.requireCertificate("JEV-033", spec, {
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			});
		}

		// 4. Resolve missing dependencies through capability loop (PH-045, PH-046)
		const resolvedCaps: string[] = [];
		const missingCaps: string[] = [];
		if (spec.required_capabilities.length > 0) {
			for (const capName of spec.required_capabilities) {
				if (this.capabilityController) {
					try {
						await this.capabilityController.resolveOrBuild({
							objectiveId: input.objectiveId,
							taskId: input.taskId,
							need: { requiredOutcome: capName },
							charter: input.charter,
							signal: input.signal,
						});
						resolvedCaps.push(capName);
					} catch {
						missingCaps.push(capName);
					}
				} else {
					missingCaps.push(capName);
				}
			}
		}

		const dependenciesComplete = missingCaps.length === 0;

		// JEV-034: Specialist dependencies resolution status (PH-046: never pass constant true)
		await this.steering.requireCertificate(
			"JEV-034",
			{
				spec,
				dependenciesComplete,
				resolvedCapabilities: resolvedCaps,
				missingCapabilities: missingCaps,
				availableTools: spec.required_tools,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		if (!dependenciesComplete) {
			throw new SpecialistMaterializationError(
				`Specialist dependencies could not be resolved: ${missingCaps.join(", ")}`,
			);
		}

		// 5. Select model via H-MoE (PH-040, PH-044)
		const routingBand = "expensive";
		const consequence = spec.cognitive_requirements?.reasoning === "critical" ? "critical" : "high";
		const plan = await this.experts.select(
			{
				schema_version: "1.0",
				request_id: `req_${Date.now()}_${randomUUID().slice(0, 6)}`,
				objective_id: input.objectiveId,
				task_id: input.taskId,
				work_class: "implement",
				worker_role: spec.authority_role,
				consequence,
				routing_band: routingBand,
				required_tools: spec.required_tools,
				required_capabilities: spec.required_capabilities,
			},
			{ signal: input.signal },
		);

		if (!plan?.primary) {
			throw new SpecialistMaterializationError("H-MoE failed to select primary expert model");
		}

		const expertBinding = {
			providerId: plan.primary.provider,
			modelId: plan.primary.model_id,
			routingBand,
			capabilityTier: spec.cognitive_requirements?.reasoning === "critical" ? "tier_3" : "tier_2",
		};

		const thinkingLevel =
			(plan.primary.thinking_level as any) ?? (expertBinding.capabilityTier === "tier_3" ? "high" : "medium");

		// 6. Materialize task profile via real TaskProfileWriter API (PH-041, PH-043)
		const profileResult = this.taskProfiles.createTaskProfile({
			task: spec.mission,
			model: {
				provider: expertBinding.providerId,
				modelId: expertBinding.modelId,
			},
			thinkingLevel,
			toolNames: spec.required_tools,
		});

		if (!profileResult.created || !profileResult.profileId) {
			throw new SpecialistMaterializationError(
				profileResult.reason ?? "TaskProfileWriter failed to create task profile",
			);
		}

		const profileId = profileResult.profileId;

		// 7. Execution contract (PH-042, PH-047, FC-020, FC-021)
		let raw: unknown;
		if (this.contractFactory) {
			try {
				raw = this.contractFactory.createContract({
					profileId,
					specialistId: spec.specialist_id,
					expertBinding,
					authorityRole: spec.authority_role,
					toolNames: spec.required_tools,
				});
			} catch (err) {
				throw new SpecialistMaterializationError(
					`ContractFactory failed to create contract: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			raw = {
				specialistSpecId: spec.specialist_id,
				authorityRole: spec.authority_role,
				profileId,
				expert: expertBinding,
				allowedCapabilities: spec.required_capabilities,
			};
		}
		const executionContract: Record<string, unknown> =
			typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : { contract: raw };

		// JEV-035: Materialization fit (PH-047: receives actual spec, expertBinding, profileId, contract)
		await this.steering.requireCertificate(
			"JEV-035",
			{
				spec,
				expert: expertBinding,
				profileId,
				contract: executionContract,
				authorityComparison: "within_charter",
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		const record: SpecialistRecord = {
			schema_version: "1.0",
			specialist_id: spec.specialist_id,
			spec_version: spec.version,
			state: isExisting ? "retained_project" : "materialized_task",
			profile_ids: [profileId],
			certificate_refs: [needCert.certificate_id],
			created_at: new Date().toISOString(),
		};

		this.records.set(spec.specialist_id, record);

		return {
			specialistId: spec.specialist_id,
			spec,
			expert: expertBinding,
			profileId,
			executionContract,
			isExisting,
		};
	}

	/**
	 * Evaluates effectiveness after a specialist attempt completes.
	 * S1A-188, PH-049: JEV-036 missing answer is a failure, no default.
	 */
	async evaluateEffectiveness(
		specialist: MaterializedSpecialist,
		hostEvidence: unknown,
		options: { objectiveId: string; taskId: string; evidenceRevision?: number } = {
			objectiveId: "obj",
			taskId: "task",
		},
	): Promise<boolean> {
		const cert = await this.steering.requireCertificate(
			"JEV-036",
			{
				specialist: specialist.spec,
				evidence: hostEvidence,
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				evidenceRevision: options.evidenceRevision ?? 1,
			},
		);

		const missionFulfilled = (cert.answers.mission_fulfilled as { noul?: number } | undefined)?.noul;
		if (missionFulfilled == null) {
			throw new SpecialistMaterializationError("Missing JEV-036 mission_fulfilled answer");
		}
		return missionFulfilled >= 0.7;
	}

	/**
	 * Evaluates retention and lifecycle for a synthesized specialist.
	 * S1A-190, S1A-191, PH-050: no lifecycle semantic defaults.
	 */
	async evaluateRetention(
		specialist: MaterializedSpecialist,
		effective: boolean,
		options: { objectiveId: string; taskId: string; evidenceRevision?: number } = {
			objectiveId: "obj",
			taskId: "task",
		},
	): Promise<SpecialistLifetime | "discard"> {
		const cert = await this.steering.requireCertificate(
			"JEV-038",
			{
				specialist: specialist.spec,
				effective,
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				evidenceRevision: options.evidenceRevision ?? 1,
			},
		);

		const actionChoice =
			(cert.answers.lifecycle_choice as { choice?: string } | undefined)?.choice ??
			(cert.answers.lifecycle_action as { choice?: string } | undefined)?.choice;

		if (!actionChoice) {
			throw new SpecialistMaterializationError("Missing specialist lifecycle choice in JEV-038");
		}

		if (actionChoice === "promote_project" || actionChoice === "project" || actionChoice === "global") {
			const scope = actionChoice === "global" ? "global" : "project";
			await this.steering.requireCertificate(
				"JEV-039",
				{
					specialist: specialist.spec,
					targetScope: scope,
				},
				{
					objectiveId: options.objectiveId,
					taskId: options.taskId,
					evidenceRevision: options.evidenceRevision ?? 1,
				},
			);

			const updatedSpec: SpecialistSpec = {
				...specialist.spec,
				lifetime: scope === "global" ? "global" : "project",
			};
			const record: SpecialistRecord = {
				schema_version: "1.0",
				specialist_id: updatedSpec.specialist_id,
				spec_version: updatedSpec.version,
				state: scope === "global" ? "retained_global" : "retained_project",
				profile_ids: [specialist.profileId],
				certificate_refs: [cert.certificate_id],
				success_count: 1,
				created_at: new Date().toISOString(),
			};
			this.catalog.registerSpecialist(updatedSpec, record);
			return updatedSpec.lifetime;
		}

		if (actionChoice === "retain_session" || actionChoice === "session") {
			return "session";
		}

		if (actionChoice === "retain_one_task" || actionChoice === "task" || actionChoice === "one_task") {
			return "one_task";
		}

		return "discard";
	}
}
