/**
 * Expert Selection Trace Store.
 * Durable host-owned store for expert selection traces.
 * Implements HMOE-005, HM11-002, and HM11-004.
 */

import type { ExpertSelectionTrace } from "./contracts.ts";
import { loadJsonArraySync, persistJsonArraySync } from "./outcome-store.ts";

export interface ExpertSelectionTraceFilter {
	traceId?: string;
	requestDigest?: string;
	selectedExpertId?: string;
	limit?: number;
}

export class ExpertSelectionTraceStore {
	private readonly traces: ExpertSelectionTrace[] = [];
	private readonly filePath?: string;

	constructor(filePath?: string) {
		this.filePath = filePath;
		this.traces = loadJsonArraySync<ExpertSelectionTrace>(filePath);
	}

	private _persist(): void {
		persistJsonArraySync(this.filePath, this.traces);
	}

	async saveTrace(trace: ExpertSelectionTrace): Promise<void> {
		const existingIdx = this.traces.findIndex((t) => t.trace_id === trace.trace_id);
		if (existingIdx >= 0) {
			this.traces[existingIdx] = trace;
		} else {
			this.traces.push(trace);
		}
		this._persist();
	}

	async getTrace(traceId: string): Promise<ExpertSelectionTrace | undefined> {
		return this.traces.find((t) => t.trace_id === traceId);
	}

	async getTraces(filter?: ExpertSelectionTraceFilter): Promise<readonly ExpertSelectionTrace[]> {
		let results = this.traces;
		if (filter?.traceId) {
			results = results.filter((t) => t.trace_id === filter.traceId);
		}
		if (filter?.requestDigest) {
			results = results.filter((t) => t.request_digest === filter.requestDigest);
		}
		if (filter?.selectedExpertId) {
			results = results.filter((t) => t.selected_expert_ids.includes(filter.selectedExpertId!));
		}
		if (filter?.limit && filter.limit > 0) {
			results = results.slice(-filter.limit);
		}
		return results;
	}
}
