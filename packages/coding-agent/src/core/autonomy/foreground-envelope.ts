import type { CapabilityEnvelope, CapabilityName } from "./contracts.ts";

/**
 * G7: explicit tool-name -> capability mapping for foreground turns.
 *
 * Background lanes carry hand-authored {@link CapabilityEnvelope}s; foreground turns have none, so
 * {@link buildForegroundEnvelope} derives one per turn purely for VISIBILITY (observe-only this
 * round -- the foreground envelope is NOT enforced). Any tool not in this table contributes NO
 * capability: unknown capabilities are omitted, never guessed. Keys are matched against the
 * lowercased active tool name. Every value below is a real member of the {@link CapabilityName}
 * union in contracts.ts.
 */
const TOOL_CAPABILITY_MAP: Readonly<Record<string, CapabilityName>> = {
	read: "read_files",
	grep: "read_files",
	find: "read_files",
	ls: "read_files",
	edit: "write_files",
	write: "write_files",
	bash: "run_shell",
	run_toolkit_script: "run_shell",
	delegate: "delegate",
	goal: "memory_write",
	memory: "memory_write",
};

/**
 * Build the auto-constructed foreground {@link CapabilityEnvelope} for a single prompt turn.
 *
 * Pure and deterministic. `capabilities` are derived from the active tool names via the explicit
 * {@link TOOL_CAPABILITY_MAP} (deduplicated, first-seen order; unknown tools omitted).
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

	const capabilities: CapabilityName[] = [];
	const seen = new Set<CapabilityName>();
	for (const toolName of activeToolNames) {
		const capability = TOOL_CAPABILITY_MAP[toolName.toLowerCase()];
		if (capability !== undefined && !seen.has(capability)) {
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
 * Lists capability names (bounded by the small {@link CapabilityName} union) and the tool COUNT
 * (never the full tool list) so the line stays short regardless of how many tools are active.
 */
export function formatForegroundEnvelopeObservation(envelope: CapabilityEnvelope): string {
	const capabilityNames = envelope.capabilities.length > 0 ? envelope.capabilities.join(", ") : "none";
	const toolCount = envelope.allowedTools?.length ?? 0;
	const pathScope = envelope.allowedPaths?.[0] ?? "(unscoped)";
	return `foreground envelope: ${envelope.capabilities.length} capability(ies) [${capabilityNames}], ${toolCount} tool(s), path scope ${pathScope}`;
}
