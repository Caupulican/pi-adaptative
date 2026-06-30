import type { CapabilityEnvelope, CapabilityName, EvidenceSourceKind, GateOutcome } from "../autonomy/contracts.ts";

interface ResearchRequestArgs {
	envelope?: CapabilityEnvelope | null;
	sourceKind: EvidenceSourceKind | string;
	estimatedUsd: number;
	maxEstimatedUsd?: number;
	privateHistoryAllowed?: boolean;
}

function missingCapabilityOutcome(sourceKind: string, capabilities: readonly CapabilityName[]): GateOutcome {
	return {
		outcome: "block",
		gate: "research_gate",
		reasonCode: "missing_capability",
		message: `Source kind '${sourceKind}' requires capability ${capabilities.join(" or ")}.`,
	};
}

function hasAnyCapability(envelope: CapabilityEnvelope, capabilities: readonly CapabilityName[]): boolean {
	return capabilities.some((capability) => envelope.capabilities.includes(capability));
}

function isWellFormedEnvelope(value: CapabilityEnvelope | null | undefined): value is CapabilityEnvelope {
	return Boolean(value) && typeof value?.id === "string" && Array.isArray(value.capabilities);
}

export function evaluateResearchRequest(args: ResearchRequestArgs): GateOutcome {
	if (!isWellFormedEnvelope(args.envelope)) {
		return {
			outcome: "block",
			gate: "research_gate",
			reasonCode: "missing_envelope",
			message: "Missing or malformed capability envelope.",
		};
	}

	const { envelope, sourceKind, estimatedUsd, maxEstimatedUsd, privateHistoryAllowed } = args;
	const limit = maxEstimatedUsd ?? envelope.maxEstimatedUsd;
	if (limit !== undefined && estimatedUsd > limit) {
		return {
			outcome: "ask-user",
			gate: "research_gate",
			reasonCode: "over_budget",
			message: `Estimated cost (${estimatedUsd}) exceeds maximum allowed (${limit}).`,
		};
	}

	switch (sourceKind) {
		case "workspace":
		case "tool":
		case "user": {
			const requiredCapabilities: readonly CapabilityName[] = ["read_files", "research"];
			if (!hasAnyCapability(envelope, requiredCapabilities)) {
				return missingCapabilityOutcome(sourceKind, requiredCapabilities);
			}
			break;
		}

		case "transcript":
			if (!hasAnyCapability(envelope, ["memory_read"])) {
				return missingCapabilityOutcome(sourceKind, ["memory_read"]);
			}
			break;

		case "automata":
			if (!hasAnyCapability(envelope, ["memory_read"])) {
				return missingCapabilityOutcome(sourceKind, ["memory_read"]);
			}
			if (!privateHistoryAllowed) {
				return {
					outcome: "ask-user",
					gate: "research_gate",
					reasonCode: "private_history_denied",
					message: "Automata source requires privateHistoryAllowed=true.",
				};
			}
			break;

		case "web":
			if (!hasAnyCapability(envelope, ["network"])) {
				return missingCapabilityOutcome(sourceKind, ["network"]);
			}
			break;

		default:
			return {
				outcome: "block",
				gate: "research_gate",
				reasonCode: "unknown_source_kind",
				message: `Unknown source kind '${sourceKind}'.`,
			};
	}

	return {
		outcome: "allow",
		gate: "research_gate",
		reasonCode: "allowed",
		message: "Research request allowed.",
	};
}
