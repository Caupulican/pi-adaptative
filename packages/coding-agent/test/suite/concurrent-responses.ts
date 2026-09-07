import { type FauxResponseFactory, type FauxResponseStep, fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import type { Harness } from "./harness.ts";

/** Independent scripts for workers and foreground handoffs; filesystem latency cannot reorder their evidence. */
export function setConcurrentResponses(
	harness: Pick<Harness, "setResponses">,
	worker: readonly FauxResponseStep[],
	foreground: readonly FauxResponseStep[] = [],
): () => number {
	let workerIndex = 0;
	let foregroundIndex = 0;
	const respond: FauxResponseFactory = (context, options, state, model) => {
		const isWorker = options?.sessionId?.startsWith("lane:worker:") === true;
		const step = isWorker ? worker[workerIndex++] : foreground[foregroundIndex++];
		if (!step) {
			if (isWorker) throw new Error("Unexpected worker provider request: synthetic script exhausted");
			return fauxAssistantMessage("Background handoff acknowledged.");
		}
		return typeof step === "function" ? step(context, options, state, model) : step;
	};
	// A bounded allowance for coalesced or separate terminal notifications; never an infinite responder.
	harness.setResponses(Array.from({ length: worker.length + foreground.length + 8 }, () => respond));
	return () => Math.max(0, worker.length - workerIndex);
}
