/**
 * Adaptive Resolution Controller.
 * Manages adaptive dimension selection and the adaptation DAG.
 * Implements S1A-177..S1A-179, S1A-192, and JEV-040.
 */

import { randomUUID } from "node:crypto";
import { choiceAct } from "../decision/thresholds.ts";
import { type AdaptationTier, readAdaptationTier } from "../steering/programs.ts";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import { AdaptationGraph } from "./adaptation-graph.ts";
import type { CapabilityNeed } from "./capability-resolution.ts";
import type { SpecialistNeed } from "./specialist-synthesis-controller.ts";
import type { AdaptationNode, AdaptationNodeKind } from "./types.ts";

/** The dimension an adaptation resolves along: JEV-040's tiers. */
export type AdaptiveDimension = AdaptationTier;

export interface AdaptiveResolutionInput {
	readonly objectiveId: string;
	readonly taskId?: string;
	readonly request?: string;
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
				...(input.recentEvidence !== undefined ? { recentEvidence: input.recentEvidence } : {}),
				...(input.recentFailures !== undefined ? { recentFailures: input.recentFailures } : {}),
				...(input.currentExpert !== undefined ? { currentExpert: input.currentExpert } : {}),
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

		const answers = cert.answers;
		// System One owns the dimension (ERC-050, ERC-051): the tier its Choice lets code act on. An unsure
		// choice adapts the strategy, the lowest tier; words in the request never pick a costlier one.
		const tier: AdaptiveDimension = readAdaptationTier(answers.lowest_adequate_adaptation)?.tier ?? "strategy";
		// A specialist is synthesized only for a domain its Choice lets code act on. An unsure domain adapts the
		// strategy instead, which synthesizes nothing; no default domain stands in for it.
		const domainAnswer = answers.specialist_domain as { choice?: unknown } | undefined;
		const domain =
			tier === "specialist" &&
			typeof domainAnswer?.choice === "string" &&
			choiceAct(domainAnswer, undefined, "reversible") === "act"
				? domainAnswer.choice
				: undefined;
		const domainUnsure = tier === "specialist" && domain === undefined;
		const dimension: AdaptiveDimension = domainUnsure ? "strategy" : tier;

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

		if (dimension === "specialist" && domain !== undefined) {
			// JEV-040 asks only the domain: the chosen domain is what says the specialist is visual, and the rest of
			// its profile follows from that.
			const isVisual =
				domain === "ui_ux" || domain.toLowerCase().includes("ui") || domain.toLowerCase().includes("visual");
			specialistNeed = {
				specialty: domain,
				specialties: isVisual ? ["ui_ux", "visual_design"] : [domain, `${domain}_specialist`],
				purpose: isVisual
					? `Deliver UI/UX design and visual implementation for ${input.objectiveId}`
					: `Deliver specialized ${domain} implementation for ${input.objectiveId}`,
				mission: isVisual
					? "Analyze UI requirements, create visual design and component hierarchy, and verify user experience"
					: `Execute specialized ${domain} task for ${input.objectiveId}`,
				obligations: isVisual ? ["vision_inspection", "ui_ux_fidelity"] : [`${domain}_verification`],
				cognitiveRequirements: { vision: isVisual, reasoning: "high", tool_calling: true, long_context: true },
				requiredTools: isVisual
					? ["view_image", "capture_screenshot", "read_file", "write_file", "edit_file"]
					: ["read_file", "write_file", "edit_file"],
				requiredCapabilities: isVisual ? ["ui_inspection"] : [],
				authorityRole: "implementer",
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
			...(specialistNeed?.specialty !== undefined ? { specialty: specialistNeed.specialty } : {}),
			action: cert.directive,
			certificateId: cert.certificate_id,
			reasonCodes: [cert.directive, `dimension_${dimension}`, ...(domainUnsure ? ["specialist_domain_unsure"] : [])],
			node,
			...(specialistNeed !== undefined ? { specialistNeed } : {}),
			...(capabilityNeed !== undefined ? { capabilityNeed } : {}),
			...(runtimeNeed !== undefined ? { runtimeNeed } : {}),
		};
	}
}
