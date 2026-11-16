/**
 * The logical worker agent ids one call names (a broadcast, a wait), checked and made canonical: from one through the
 * orchestration's collection bound, each a trimmed non-empty id within the identifier bound, each kept once in the order
 * first named.
 */
import {
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
} from "../orchestration/contracts.ts";

/** `agentIds` checked and made canonical; `label` names the call in the error a malformed list throws. */
export function canonicalWorkerAgentIds(agentIds: readonly string[], label: string): string[] {
	if (!Array.isArray(agentIds) || agentIds.length < 1 || agentIds.length > MAX_ORCHESTRATION_COLLECTION_LENGTH) {
		throw new TypeError(
			`${label} agent ids must contain from 1 through ${MAX_ORCHESTRATION_COLLECTION_LENGTH} entries.`,
		);
	}
	const canonicalAgentIds: string[] = [];
	const seenAgentIds = new Set<string>();
	for (const agentId of agentIds) {
		if (typeof agentId !== "string") throw new TypeError("Logical worker agent id is required.");
		const canonicalAgentId = agentId.trim();
		if (!canonicalAgentId) throw new TypeError("Logical worker agent id is required.");
		if (canonicalAgentId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
			throw new TypeError(`Logical worker agent id exceeds ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH} characters.`);
		}
		if (seenAgentIds.has(canonicalAgentId)) continue;
		seenAgentIds.add(canonicalAgentId);
		canonicalAgentIds.push(canonicalAgentId);
	}
	return canonicalAgentIds;
}
