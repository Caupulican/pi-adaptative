/**
 * Specialist Synthesis Controller.
 * Synthesizes and materializes task-scoped specialists using H-MoE and TaskProfileWriter.
 * Implements S1A-177..S1A-199, JEV-031..JEV-039.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import type { ExpertSelectionService } from "../expert-routing/service.ts";
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
	readonly taskProfiles?: {
		createTaskProfile?(input: {
			profileId: string;
			authorityRole: string;
			allowedTools?: readonly string[];
			modelId?: string;
			providerId?: string;
		}): { created: boolean; profileId?: string; reason?: string };
	};
}

export class SpecialistSynthesisController {
	readonly steering: SystemOneSteeringPlane;
	readonly catalog: SpecialistCatalog;
	private readonly experts?: ExpertSelectionService;
	private readonly capabilityController?: SpecialistSynthesisControllerDeps["capabilityController"];
	private readonly taskProfiles?: SpecialistSynthesisControllerDeps["taskProfiles"];
	private readonly records = new Map<string, SpecialistRecord>();

	constructor(deps: SpecialistSynthesisControllerDeps) {
		this.steering = deps.steering;
		this.catalog = deps.catalog;
		this.experts = deps.experts;
		this.capabilityController = deps.capabilityController;
		this.taskProfiles = deps.taskProfiles;
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
			// Deep absolute fit check
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

			if (fitChoice && newSpecialistRequired < 0.5) {
				existingEntry = this.catalog.get(fitChoice);
			}
		}

		if (existingEntry) {
			// S1A-181: Existing specialist reuse
			const existingSpec = existingEntry.spec ?? {
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

			return {
				spec: existingSpec,
				expert: {
					providerId: "typesafe",
					modelId: "mock-specialist-model",
					routingBand: "standard",
					capabilityTier: "standard",
				},
				profileId: `profile-${existingEntry.specialistId}`,
				executionContract: { specialistId: existingEntry.specialistId, role: existingEntry.authorityRole },
				isExisting: true,
			};
		}

		// 3. Build SpecialistSpec
		const specialistId = `spec_${input.need.specialty}_${Date.now()}`;
		const authorityRole = input.need.authorityRole ?? "implementer"; // S1A-194: no kernel role changes, defaults to standard role
		const cognitive: SpecialistCognitiveRequirements = {
			reasoning: input.need.cognitiveRequirements?.reasoning ?? "medium",
			vision:
				input.need.cognitiveRequirements?.vision ??
				allSpecialties.some((s) => s.toLowerCase().includes("ui") || s.toLowerCase().includes("visual")),
			long_context: input.need.cognitiveRequirements?.long_context ?? true,
			tool_calling: input.need.cognitiveRequirements?.tool_calling ?? true,
		};

		const spec: SpecialistSpec = {
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
			lifetime: "one_task", // S1A-195: new specialist defaults to one_task
		};

		// JEV-033: SpecialistSpec completeness
		await this.steering.requireCertificate("JEV-033", spec, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			evidenceRevision,
			signal: input.signal,
		});

		// 4. Resolve missing dependencies through capability loop (S1A-183, S1A-193)
		if (this.capabilityController && spec.required_capabilities.length > 0) {
			for (const capName of spec.required_capabilities) {
				await this.capabilityController.resolveOrBuild({
					objectiveId: input.objectiveId,
					taskId: input.taskId,
					need: { requiredOutcome: capName },
					charter: input.charter,
					signal: input.signal,
				});
			}
		}

		// JEV-034: Specialist dependencies complete
		await this.steering.requireCertificate(
			"JEV-034",
			{
				spec,
				dependenciesComplete: true,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);

		// 5. Select model via H-MoE (S1A-184)
		let expertBinding = {
			providerId: "typesafe",
			modelId: cognitive.vision ? "vision-capable-model" : "standard-coder-model",
			routingBand: "expensive",
			capabilityTier: cognitive.reasoning === "critical" ? "tier_3" : "tier_2",
		};

		if (this.experts) {
			try {
				const plan = await this.experts.select(
					{
						schema_version: "1.0",
						request_id: `req_${Date.now()}_${randomUUID().slice(0, 6)}`,
						objective_id: input.objectiveId,
						task_id: input.taskId,
						work_class: "implement",
						worker_role: spec.authority_role,
						consequence: cognitive.reasoning === "critical" ? "critical" : "high",
						routing_band: "expensive",
						required_tools: spec.required_tools,
						required_capabilities: spec.required_capabilities,
					},
					{ signal: input.signal },
				);
				if (plan.primary) {
					expertBinding = {
						providerId: plan.primary.provider,
						modelId: plan.primary.model_id,
						routingBand: "expensive",
						capabilityTier: cognitive.reasoning === "critical" ? "tier_3" : "tier_2",
					};
				}
			} catch {
				// Fallback to default binding
			}
		}

		// 6. Materialize task profile via TaskProfileWriter (S1A-185, S1A-186: authority <= base)
		const profileId = `profile-${specialistId}`;
		if (this.taskProfiles?.createTaskProfile) {
			const res = this.taskProfiles.createTaskProfile({
				profileId,
				authorityRole: spec.authority_role,
				allowedTools: spec.required_tools,
				modelId: expertBinding.modelId,
				providerId: expertBinding.providerId,
			});
			if (!res.created) {
				throw new SpecialistMaterializationError(res.reason ?? "profile_creation_failed");
			}
		}

		const executionContract = {
			specialistSpecId: spec.specialist_id,
			authorityRole: spec.authority_role,
			profileId,
			expert: expertBinding,
			allowedCapabilities: spec.required_capabilities,
		};

		// JEV-035: Materialization fit
		await this.steering.requireCertificate(
			"JEV-035",
			{
				spec,
				expert: expertBinding,
				contract: executionContract,
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
			state: "materialized_task",
			profile_ids: [profileId],
			certificate_refs: [needCert.certificate_id],
			created_at: new Date().toISOString(),
		};

		this.records.set(spec.specialist_id, record);

		return {
			spec,
			expert: expertBinding,
			profileId,
			executionContract,
			isExisting: false,
		};
	}

	/**
	 * Evaluates effectiveness after a specialist attempt completes.
	 * S1A-188: JEV-036 specialist effectiveness.
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

		const missionFulfilled = (cert.answers.mission_fulfilled as { noul?: number })?.noul ?? 1;
		return missionFulfilled >= 0.7;
	}

	/**
	 * Evaluates retention and lifecycle for a synthesized specialist.
	 * S1A-190, S1A-191: JEV-038 retention, JEV-039 promotion.
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

		const actionChoice = (cert.answers.lifecycle_action as { choice?: string })?.choice ?? "task";

		if (actionChoice === "project" || actionChoice === "global") {
			// S1A-191: JEV-039 specialist promotion
			await this.steering.requireCertificate(
				"JEV-039",
				{
					specialist: specialist.spec,
					targetScope: actionChoice,
				},
				{
					objectiveId: options.objectiveId,
					taskId: options.taskId,
					evidenceRevision: options.evidenceRevision ?? 1,
				},
			);

			// S1A-196: Retained specialist enters catalog
			const updatedSpec: SpecialistSpec = {
				...specialist.spec,
				lifetime: actionChoice,
			};
			const record: SpecialistRecord = {
				schema_version: "1.0",
				specialist_id: updatedSpec.specialist_id,
				spec_version: updatedSpec.version,
				state: actionChoice === "global" ? "retained_global" : "retained_project",
				profile_ids: [specialist.profileId],
				certificate_refs: [cert.certificate_id],
				success_count: 1,
				created_at: new Date().toISOString(),
			};
			this.catalog.registerSpecialist(updatedSpec, record);
			return actionChoice;
		}

		if (actionChoice === "session" || actionChoice === "task") {
			return "one_task";
		}

		return "discard";
	}
}
