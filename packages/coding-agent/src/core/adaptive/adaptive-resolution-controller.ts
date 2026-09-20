/**
 * Adaptive Resolution Controller.
 * Manages adaptive dimension selection and the adaptation DAG.
 * Implements S1A-177..S1A-179, S1A-192, and JEV-040.
 */

import { randomUUID } from "node:crypto";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import { AdaptationGraph } from "./adaptation-graph.ts";
import type { CapabilityNeed } from "./capability-resolution.ts";
import type { SpecialistNeed } from "./specialist-synthesis-controller.ts";
import type { AdaptationNode, AdaptationNodeKind } from "./types.ts";

export type AdaptiveDimension = "strategy" | "expert_reroute" | "specialist" | "capability" | "runtime";

export interface AdaptiveResolutionInput {
	readonly objectiveId: string;
	readonly taskId?: string;
	readonly request?: string;
	readonly prompt?: string;
	readonly objectiveDescription?: string;
	readonly recentEvidence?: unknown;
	readonly recentFailures?: readonly string[];
	readonly currentExpert?: string;
	readonly specialistCatalogRevision?: number;
	readonly capabilityCatalogRevision?: number;
	readonly evidenceRevision?: number;
	readonly signal?: AbortSignal;
}

export interface AdaptiveResolution {
	readonly dimension: AdaptiveDimension;
	readonly specialty?: string;
	readonly action: string;
	readonly certificateId: string;
	readonly reasonCodes: readonly string[];
	readonly node: AdaptationNode;
	readonly specialistNeed?: SpecialistNeed;
	readonly capabilityNeed?: CapabilityNeed;
	readonly runtimeNeed?: Record<string, unknown>;
}

export interface CatalogRevisionProvider {
	revision(): number;
}

export class AdaptiveResolutionController {
	private readonly steering: SystemOneSteeringPlane;
	readonly graph: AdaptationGraph;
	private readonly specialistCatalog?: CatalogRevisionProvider;
	private readonly capabilityCatalog?: CatalogRevisionProvider;

	constructor(deps: {
		steering: SystemOneSteeringPlane;
		graph?: AdaptationGraph;
		specialistCatalog?: CatalogRevisionProvider;
		capabilityCatalog?: CatalogRevisionProvider;
	}) {
		this.steering = deps.steering;
		this.graph = deps.graph ?? new AdaptationGraph();
		this.specialistCatalog = deps.specialistCatalog;
		this.capabilityCatalog = deps.capabilityCatalog;
	}

	async resolve(input: AdaptiveResolutionInput): Promise<AdaptiveResolution> {
		if (input.signal?.aborted) {
			throw new Error("Adaptive resolution aborted.");
		}

		const cert = await this.steering.requireCertificate(
			"JEV-040",
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				recentEvidence: input.recentEvidence,
				recentFailures: input.recentFailures,
				currentExpert: input.currentExpert,
				specialistCatalogRevision: this.specialistCatalog?.revision() ?? 1,
				capabilityCatalogRevision: this.capabilityCatalog?.revision() ?? 1,
				adaptationGraph: this.graph.summary(input.objectiveId),
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision: input.evidenceRevision ?? 1,
				signal: input.signal,
			},
		);

		// Interpret lowest adequate adaptation dimension from typed Jev (ERC-050)
		const answers = cert.answers;
		const lowestChoice = (answers.lowest_adequate_adaptation as { choice?: string })?.choice;
		const requiredSpecialtyChoice =
			(answers.required_specialty as { choice?: string })?.choice ??
			(typeof answers.required_specialty === "string" ? answers.required_specialty : undefined);
		const specialistDomainChoice =
			requiredSpecialtyChoice ??
			(answers.specialist_domain as { choice?: string })?.choice ??
			(answers.domain as string) ??
			(answers.specialty as string);
		const reqText =
			`${input.request ?? ""} ${(input as any).prompt ?? ""} ${input.objectiveDescription ?? ""} ${JSON.stringify(input.recentEvidence ?? "")}`.toLowerCase();
		const isUiRegex = /\b(ui|ux|ui_ux|visual|design|frontend|interface|gui|layout)\b/i.test(reqText);
		const isCapNeed = /\b(tool|script|capability|extension|patch|missing)\b/i.test(reqText);

		// Jev owns dimension; regex is only a secondary fallback hint (ERC-050, ERC-051)
		let dimension: AdaptiveDimension = "strategy";
		if (lowestChoice === "expert_reroute") {
			dimension = "expert_reroute";
		} else if (lowestChoice === "specialist" || requiredSpecialtyChoice) {
			dimension = "specialist";
		} else if (lowestChoice === "capability") {
			dimension = "capability";
		} else if (lowestChoice === "runtime") {
			dimension = "runtime";
		} else if (cert.directive === "synthesize_capability") {
			dimension = "runtime";
		} else if (cert.directive === "resolve_capability") {
			dimension = cert.answers.specialist_gap_present ? "specialist" : "capability";
		} else {
			// Fallback hints when typed Jev does not specify lowestChoice
			if (isUiRegex && !isCapNeed) {
				dimension = "specialist";
			} else if (isCapNeed) {
				dimension = "capability";
			}
		}

		const kindMap: Record<AdaptiveDimension, AdaptationNodeKind> = {
			strategy: "strategy_change",
			expert_reroute: "expert_reroute",
			specialist: "specialist_spec",
			capability: "capability_spec",
			runtime: "runtime_patch",
		};

		const node: AdaptationNode = {
			schema_version: "1.0",
			node_id: `ADAPT-${dimension}-${Date.now()}-${randomUUID().slice(0, 8)}`,
			kind: kindMap[dimension],
			fingerprint: cert.state_digest,
			certificate_refs: [cert.certificate_id],
			status: "active",
			created_at: new Date().toISOString(),
		};

		this.graph.addNode(node);

		let specialistNeed: SpecialistNeed | undefined;
		let capabilityNeed: CapabilityNeed | undefined;
		let runtimeNeed: Record<string, unknown> | undefined;

		if (dimension === "specialist") {
			const domain = specialistDomainChoice || (isUiRegex ? "ui_ux" : "architecture");
			const isVisual =
				domain === "ui_ux" ||
				domain.toLowerCase().includes("ui") ||
				domain.toLowerCase().includes("visual") ||
				Boolean(
					typeof (answers.vision_required as { noul?: number })?.noul === "number"
						? ((answers.vision_required as { noul?: number }).noul ?? 0) > 0.5
						: answers.vision_required === true,
				);

			const specialties = Array.isArray((answers.specialties as any)?.list)
				? (answers.specialties as any).list
				: Array.isArray(answers.specialties)
					? (answers.specialties as string[])
					: isVisual
						? ["ui_ux", "visual_design"]
						: [domain, `${domain}_specialist`];

			const obligations = Array.isArray(answers.obligations)
				? (answers.obligations as string[])
				: isVisual
					? ["vision_inspection", "ui_ux_fidelity"]
					: [`${domain}_verification`];

			const requiredTools = Array.isArray(answers.required_tools)
				? (answers.required_tools as string[])
				: isVisual
					? ["view_image", "capture_screenshot", "read_file", "write_file", "edit_file"]
					: ["read_file", "write_file", "edit_file"];

			const requiredCapabilities = Array.isArray(answers.required_capabilities)
				? (answers.required_capabilities as string[])
				: isVisual
					? ["ui_inspection"]
					: [];

			specialistNeed = {
				specialty: domain,
				specialties,
				purpose:
					(answers.purpose as string) ??
					(isVisual
						? `Deliver UI/UX design and visual implementation for ${input.objectiveId}`
						: `Deliver specialized ${domain} implementation for ${input.objectiveId}`),
				mission:
					(answers.mission as string) ??
					(isVisual
						? "Analyze UI requirements, create visual design and component hierarchy, and verify user experience"
						: `Execute specialized ${domain} task for ${input.objectiveId}`),
				obligations,
				cognitiveRequirements: {
					vision: isVisual,
					reasoning: ((answers.reasoning as string) ||
						(answers.cognitiveRequirements as any)?.reasoning ||
						"high") as any,
					tool_calling: true,
					long_context: true,
				},
				requiredTools,
				requiredCapabilities,
				authorityRole: (answers.authority_role as string) ?? "implementer",
			};
		} else if (dimension === "capability") {
			capabilityNeed = {
				requiredOutcome: `Synthesize capability to close operational gap for ${input.objectiveId}: ${input.request ?? "tool extension"}`,
				requiredInputs: ["context", "parameters"],
				requiredOutputs: ["result", "evidence"],
			};
		} else if (dimension === "runtime") {
			runtimeNeed = {
				objectiveId: input.objectiveId,
				target: "runtime_modification",
				rollbackRequired: true,
			};
		}

		return {
			dimension,
			specialty: specialistNeed?.specialty,
			action: cert.directive,
			certificateId: cert.certificate_id,
			reasonCodes: [cert.directive, `dimension_${dimension}`],
			node,
			specialistNeed,
			capabilityNeed,
			runtimeNeed,
		};
	}
}
