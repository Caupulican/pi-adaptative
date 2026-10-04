import { fanoutLabelTag, parseFanoutHeader } from "./worker-fanout-header.ts";

const MAX_WORKER_TASK_LABEL_LENGTH = 120;

function boundedLabel(text: string, fallback: string, maxLength: number): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	if (!normalized) return fallback;
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Produce the one bounded human label used by durable worker tasks, lane records, and UI. */
export function deriveWorkerTaskLabel(instructions: string, fallback: string): string {
	// A fan-out member's header is machine identity: the label keeps the group and member as a short
	// tag and spends the rest of its budget on the work.
	const fanout = parseFanoutHeader(instructions);
	if (fanout) {
		const tag = fanoutLabelTag(fanout.membership);
		const body = boundedLabel(fanout.body, "", MAX_WORKER_TASK_LABEL_LENGTH - tag.length - 1);
		return body ? `${tag} ${body}` : tag;
	}
	return boundedLabel(instructions, fallback, MAX_WORKER_TASK_LABEL_LENGTH);
}
