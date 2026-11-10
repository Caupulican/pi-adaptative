/** The knowledge view a delegated lane receives, one projection per surface. Reads the store; never stores. */
import type { MemoryPromptBudget } from "../context/memory-prompt-budget.ts";
import type { KnowledgeGrantReference } from "./knowledge-grant.ts";
import type { KnowledgeProjection, KnowledgeProjectionReader } from "./knowledge-projection.ts";
import type { KnowledgeScope } from "./knowledge-record.ts";

/**
 * The lane surface a view is built for. A worker's prompt view adds the owner's taste to the selected records;
 * a managed lane's handoff and a worker's `memory_read` hold the selected records alone.
 */
export type LaneKnowledgeSurface = "worker_prompt" | "managed_handoff" | "memory_read";

/**
 * What a lane's delegation says it may read: the records selected for its task (empty: none were selected), or
 * `undefined` when the lane reads no owner facts now (its attempt lost its lease, or carries a third party's words).
 */
export type LaneKnowledgeSelection = readonly KnowledgeGrantReference[] | undefined;

/** One lifecycle and scope fence over the owner's knowledge, captured by the caller for the request. */
export interface LaneKnowledgeContext {
	readonly reader: KnowledgeProjectionReader | undefined;
	readonly scope: KnowledgeScope;
	readonly settings: { readonly enabled: boolean; readonly includeInPrompt: boolean };
	isCurrent(): boolean;
}

/**
 * An absent or disabled reader projects nothing: every selected record counts as omitted. A lane that reads no
 * owner facts now gets no view on any surface.
 */
export function projectLaneKnowledge(
	context: LaneKnowledgeContext,
	selection: LaneKnowledgeSelection,
	budget: MemoryPromptBudget,
	surface: LaneKnowledgeSurface,
): KnowledgeProjection {
	const { reader, scope, settings } = context;
	const references = selection ?? [];
	const enabled =
		selection !== undefined && settings.enabled && (surface === "memory_read" || settings.includeInPrompt);
	const projection = !enabled
		? undefined
		: surface === "worker_prompt"
			? reader?.previewSelectedWithTaste(scope, references, budget)
			: references.length > 0
				? reader?.previewSelected(scope, references, budget)
				: undefined;
	return {
		revision: projection?.revision ?? 0,
		text: projection?.text ?? "",
		includedCount: projection?.includedCount ?? 0,
		omittedCount: projection?.omittedCount ?? references.length,
		references: projection?.references ?? [],
		...(projection?.dropped ? { dropped: projection.dropped } : {}),
		isCurrent: () => context.isCurrent() && (projection?.isCurrent() ?? true),
	};
}
