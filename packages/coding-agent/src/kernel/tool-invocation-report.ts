import { retainedToolInvocation } from "./tool-invocation-receipt.ts";

export interface ToolInvocationObservation {
	toolCallId: string;
	isError: boolean;
	details: unknown;
}

type ExecutionCategory = "notStarted" | "running" | "succeeded" | "negative" | "unknown" | "unclassified";
export type ToolInvocationCounts = Record<
	ExecutionCategory | "calls" | "errorResults" | "postprocessing" | "conflicts",
	number
>;

interface ObservationRecord {
	cycle: number;
	category: ExecutionCategory;
	error: boolean;
	postprocessing: boolean;
	conflict: boolean;
}

function emptyCounts(): ToolInvocationCounts {
	return {
		calls: 0,
		notStarted: 0,
		running: 0,
		succeeded: 0,
		negative: 0,
		unknown: 0,
		unclassified: 0,
		errorResults: 0,
		postprocessing: 0,
		conflicts: 0,
	};
}

function countObservation(counts: ToolInvocationCounts, record: ObservationRecord, delta: 1 | -1): void {
	counts.calls += delta;
	counts[record.category] += delta;
	if (record.error) counts.errorResults += delta;
	if (record.postprocessing) counts.postprocessing += delta;
	if (record.conflict) counts.conflicts += delta;
}

/**
 * Incremental, provider-neutral reporting over explicitly observed calls, not a session-wide
 * failure-rate estimate. Identities stay paired with their original cycle through handoff.
 * Retention is byte-budgeted; saturation is disclosed and never evicts replay protection.
 * No outputs, arguments, tool names, or listener diagnostics are retained.
 */
export class ToolInvocationReport {
	private readonly records = new Map<string, ObservationRecord>();
	private readonly maxBytes: number;
	private retainedBytes = 0;
	private partial = false;
	private cycle = 1;
	private current = emptyCounts();
	private retained = emptyCounts();

	constructor(maxBytes = 256 * 1024) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Invalid invocation report budget");
		this.maxBytes = maxBytes;
	}

	beginCycle(): void {
		this.cycle++;
		this.current = emptyCounts();
	}

	reset(): void {
		this.records.clear();
		this.retainedBytes = 0;
		this.partial = false;
		this.cycle = 1;
		this.current = emptyCounts();
		this.retained = emptyCounts();
	}

	record(observation: ToolInvocationObservation, source: "foreground" | "background" = "foreground"): boolean {
		if (
			typeof observation.toolCallId !== "string" ||
			!observation.toolCallId ||
			observation.toolCallId.length > 512
		) {
			this.partial = true;
			return false;
		}
		const receipt = retainedToolInvocation(observation.details);
		// A background message without request identity cannot be paired with a foreground call.
		if (source === "background" && !receipt) {
			this.partial = true;
			return false;
		}
		const key = JSON.stringify([receipt?.requestId ?? null, observation.toolCallId]);
		const previous = this.records.get(key);
		let boundToCycle = false;
		if (previous?.cycle === 0 && source === "foreground") {
			// Completion can beat the foreground handoff event. Its first foreground observation
			// supplies cycle ownership, without undoing already-known terminal evidence.
			previous.cycle = this.cycle;
			countObservation(this.current, previous, 1);
			boundToCycle = true;
		}
		const record: ObservationRecord = {
			cycle: previous?.cycle ?? (source === "foreground" ? this.cycle : 0),
			category: !receipt
				? "unclassified"
				: receipt.execution === "completed"
					? receipt.operationStatus === "success"
						? "succeeded"
						: "negative"
					: receipt.execution === "not_started"
						? "notStarted"
						: receipt.execution,
			error: observation.isError,
			postprocessing: (receipt?.postprocessingFailures.length ?? 0) > 0,
			conflict: false,
		};
		if (previous) {
			if (previous.category !== "running" && record.category === "running") return boundToCycle;
			if (
				previous.category === record.category &&
				previous.error === record.error &&
				previous.postprocessing === record.postprocessing
			)
				return boundToCycle;
			if (previous.category !== "running") {
				record.category = "unknown";
				record.conflict = true;
				record.error ||= previous.error;
				record.postprocessing ||= previous.postprocessing;
			}
			countObservation(this.retained, previous, -1);
			if (previous.cycle === this.cycle) countObservation(this.current, previous, -1);
		} else {
			// UTF-16 key storage plus a fixed conservative charge for the bounded record. This is a
			// bookkeeping budget, not a promise about a particular JavaScript VM's object overhead.
			const bytes = key.length * 2 + 128;
			if (this.retainedBytes + bytes > this.maxBytes) {
				this.partial = true;
				return false;
			}
			this.retainedBytes += bytes;
		}
		this.records.set(key, record);
		countObservation(this.retained, record, 1);
		if (record.cycle === this.cycle) countObservation(this.current, record, 1);
		return true;
	}

	snapshot(): {
		current: ToolInvocationCounts;
		retained: ToolInvocationCounts;
		partial: boolean;
		retainedBytes: number;
	} {
		return {
			current: { ...this.current },
			retained: { ...this.retained },
			partial: this.partial,
			retainedBytes: this.retainedBytes,
		};
	}
}
