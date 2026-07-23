import type { HarnessCapability } from "../capability-contract.ts";
import { requiredEnvelopeCapabilities } from "../tool-capability-policy.ts";
import type { CapabilityEnvelope } from "./contracts.ts";

/**
 * Background lanes carry hand-authored {@link CapabilityEnvelope}s; foreground turns have none, so
 * {@link buildForegroundEnvelope} derives one per turn purely for VISIBILITY (observe-only this
 * round -- the foreground envelope is NOT enforced). The shared tool capability policy is the
 * only mapping; unknown tools contribute no capability rather than receiving guessed authority.
 */
/**
 * Build the auto-constructed foreground {@link CapabilityEnvelope} for a single prompt turn.
 *
 * Pure and deterministic. `capabilities` are derived from the active tool names via the explicit
 * shared tool policy (deduplicated, first-seen order; unknown tools omitted).
 * `allowedTools` mirrors the active tool names, `allowedPaths` scopes to the working directory, and
 * `maxEstimatedUsd` is set only when a positive per-turn ceiling is supplied.
 */
export function buildForegroundEnvelope(args: {
	turnIndex: number;
	activeToolNames: readonly string[];
	cwd: string;
	maxTurnUsd?: number;
}): CapabilityEnvelope {
	const { turnIndex, activeToolNames, cwd, maxTurnUsd } = args;

	const capabilities: HarnessCapability[] = [];
	const seen = new Set<HarnessCapability>();
	for (const toolName of activeToolNames) {
		for (const capability of requiredEnvelopeCapabilities(toolName)) {
			if (seen.has(capability)) continue;
			seen.add(capability);
			capabilities.push(capability);
		}
	}

	const envelope: CapabilityEnvelope = {
		id: `foreground-turn-${turnIndex}`,
		capabilities,
		allowedTools: [...activeToolNames],
		allowedPaths: [cwd],
	};
	if (typeof maxTurnUsd === "number" && maxTurnUsd > 0) {
		envelope.maxEstimatedUsd = maxTurnUsd;
	}
	return envelope;
}

/**
 * One bounded plain-text line describing a foreground envelope, for the /context dashboard.
 * Lists capability names (bounded by the canonical harness capability union) and the tool COUNT
 * (never the full tool list) so the line stays short regardless of how many tools are active.
 */
export function formatForegroundEnvelopeObservation(envelope: CapabilityEnvelope): string {
	const capabilityNames = envelope.capabilities.length > 0 ? envelope.capabilities.join(", ") : "none";
	const toolCount = envelope.allowedTools?.length ?? 0;
	const pathScope = envelope.allowedPaths?.[0] ?? "(unscoped)";
	return `foreground envelope: ${envelope.capabilities.length} capability(ies) [${capabilityNames}], ${toolCount} tool(s), path scope ${pathScope}`;
}
