/**
 * What a session's memory lends its workers: whether it serves them memory reads at all, a fresh read-only memory
 * port per lane, the owner's selected knowledge versions and the owner's handoff guidance. Composed over the
 * session's memory controller, read at each call (the session builds its memory after its worker ports), so a worker is
 * lent exactly what the session's memory serves.
 */

import type { MemoryController } from "../memory-controller.ts";
import type { ParentExecutionPolicy } from "./parent-execution-context.ts";

/** The memory controller reads a worker's memory access needs. */
export type WorkerMemorySource = Pick<
	MemoryController,
	"servesLaneMemory" | "createLaneMemoryBroker" | "captureKnowledgeGrant" | "getHandoffPersonaGuidance"
>;

export function createWorkerMemoryAccess(
	memory: () => WorkerMemorySource,
): Required<
	Pick<
		ParentExecutionPolicy,
		"servesLaneMemory" | "createLaneMemoryBroker" | "captureKnowledgeGrant" | "getHandoffPersonaGuidance"
	>
> {
	return {
		servesLaneMemory: () => memory().servesLaneMemory(),
		createLaneMemoryBroker: (capacity, references) => memory().createLaneMemoryBroker(capacity, references),
		captureKnowledgeGrant: (references) => memory().captureKnowledgeGrant(references),
		getHandoffPersonaGuidance: () => memory().getHandoffPersonaGuidance(),
	};
}
