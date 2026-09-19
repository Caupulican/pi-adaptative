/**
 * Adaptive Resolution Controller.
 * Manages adaptive dimension selection and the adaptation DAG.
 * Implements S1A-177..S1A-179, S1A-192, and JEV-040.
 */

import { randomUUID } from "node:crypto";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import { AdaptationGraph } from "./adaptation-graph.ts";
import type { AdaptationNode, AdaptationNodeKind } from "./types.ts";

export type AdaptiveDimension = "strategy" | "expert_reroute" | "specialist" | "capability" | "runtime";

export interface AdaptiveResolutionInput {
	readonly objectiveId: string;
	readonly taskId?: string;
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
	readonly action: string;
	readonly certificateId: string;
	readonly reasonCodes: readonly string[];
	readonly node: AdaptationNode;
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

		// Interpret lowest adequate adaptation dimension
		const answers = cert.answers;
		const lowestChoice = (answers.lowest_adequate_adaptation as { choice?: string })?.choice;

		let dimension: AdaptiveDimension = "strategy";
		if (lowestChoice === "expert_reroute") {
			dimension = "expert_reroute";
		} else if (
			lowestChoice === "specialist" ||
			(cert.directive === "resolve_capability" && cert.answers.specialist_gap_present)
		) {
			dimension = "specialist";
		} else if (lowestChoice === "capability" || cert.directive === "resolve_capability") {
			dimension = "capability";
		} else if (lowestChoice === "runtime" || cert.directive === "synthesize_capability") {
			dimension = "runtime";
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

		return {
			dimension,
			action: cert.directive,
			certificateId: cert.certificate_id,
			reasonCodes: [cert.directive, `dimension_${dimension}`],
			node,
		};
	}
}
