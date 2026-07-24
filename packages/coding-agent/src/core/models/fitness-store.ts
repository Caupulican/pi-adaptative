import { stateFile } from "../agent-paths.ts";
import type { ModelFitnessReport } from "../research/model-fitness.ts";
import { isWorkerSession } from "../session-role.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { type HostFingerprint, HostStateStore, isHostFingerprint } from "./host-state-store.ts";

/**
 * Durable, HOST-KEYED storage for model fitness reports. Fitness is a property of a model ON a
 * host (tok/s and latency-driven failures do not travel between machines), so reports are keyed
 * by a hardware fingerprint: the same model can be "the heavy lifter" on one machine and
 * "waiting for better hardware" on another, and pi remembers both without confusing them —
 * including when settings/dotfiles are synced across machines.
 */

export interface StoredFitnessReport {
	model: string;
	report: ModelFitnessReport;
	at: string;
	host: HostFingerprint;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isLaneScore(value: unknown): boolean {
	return (
		isPlainRecord(value) &&
		isFiniteNumber(value.succeeded) &&
		isFiniteNumber(value.total) &&
		Array.isArray(value.outcomes) &&
		value.outcomes.every((outcome) => typeof outcome === "string") &&
		isFiniteNumber(value.meanMs) &&
		(value.tokensPerSecond === undefined || isFiniteNumber(value.tokensPerSecond))
	);
}

function isFitnessReport(value: unknown): value is ModelFitnessReport {
	return (
		isPlainRecord(value) &&
		isFiniteNumber(value.trials) &&
		(value.tokensPerSecond === undefined || isFiniteNumber(value.tokensPerSecond)) &&
		isLaneScore(value.research) &&
		isLaneScore(value.worker) &&
		isLaneScore(value.search) &&
		isLaneScore(value.toolCall) &&
		isLaneScore(value.digest) &&
		isPlainRecord(value.judge) &&
		isFiniteNumber(value.judge.parsed) &&
		isFiniteNumber(value.judge.planningElevated) &&
		isFiniteNumber(value.judge.planningTotal) &&
		isFiniteNumber(value.judge.trivialCheap) &&
		isFiniteNumber(value.judge.trivialTotal) &&
		isFiniteNumber(value.judge.total) &&
		Array.isArray(value.judge.outcomes) &&
		value.judge.outcomes.every((outcome) => typeof outcome === "string") &&
		isFiniteNumber(value.judge.meanMs) &&
		(value.judge.tokensPerSecond === undefined || isFiniteNumber(value.judge.tokensPerSecond)) &&
		(value.capacity === undefined ||
			(isPlainRecord(value.capacity) &&
				isFiniteNumber(value.capacity.registeredContextWindow) &&
				isFiniteNumber(value.capacity.servedContextWindow) &&
				Array.isArray(value.capacity.outcomes) &&
				value.capacity.outcomes.every((outcome) => typeof outcome === "string") &&
				isFiniteNumber(value.capacity.meanMs))) &&
		isFiniteNumber(value.totalCostUsd)
	);
}

function parseFitnessHost(value: unknown, hostId: string): Record<string, StoredFitnessReport> | undefined {
	if (!isPlainRecord(value)) return undefined;
	const reports: Record<string, StoredFitnessReport> = {};
	for (const [model, candidate] of Object.entries(value)) {
		if (
			!isPlainRecord(candidate) ||
			candidate.model !== model ||
			typeof candidate.at !== "string" ||
			!isHostFingerprint(candidate.host) ||
			candidate.host.id !== hostId ||
			!isFitnessReport(candidate.report)
		)
			continue;
		reports[model] = {
			model,
			report: candidate.report,
			at: candidate.at,
			host: candidate.host,
		};
	}
	return reports;
}

export class FitnessStore {
	private readonly storage: HostStateStore<Record<string, StoredFitnessReport>>;

	constructor(filePath: string, options?: { fingerprint?: () => HostFingerprint; readOnly?: boolean }) {
		this.storage = new HostStateStore({
			filePath,
			version: 1,
			fingerprint: options?.fingerprint,
			readOnly: options?.readOnly ?? isWorkerSession(),
			parseHost: parseFitnessHost,
		});
	}

	static forAgentDir(
		agentDir: string,
		options?: { fingerprint?: () => HostFingerprint; readOnly?: boolean },
	): FitnessStore {
		return new FitnessStore(stateFile(agentDir, "model-fitness.json"), options);
	}

	/** Persist the latest report for a model on the CURRENT host. Best-effort, returns the entry. */
	save(model: string, report: ModelFitnessReport, at?: string): StoredFitnessReport {
		return this.storage.mutateCurrentHost(
			() => ({}),
			(reports, host) => {
				const entry: StoredFitnessReport = { model, report, at: at ?? new Date().toISOString(), host };
				reports[model] = entry;
				return { result: entry, changed: true };
			},
		);
	}

	/** Drop a model's report for the CURRENT host (uninstall cleanup). No-op when absent. */
	remove(model: string): void {
		this.storage.mutateCurrentHost(
			() => ({}),
			(reports) => {
				if (!reports[model]) return { result: undefined, changed: false };
				delete reports[model];
				return { result: undefined, changed: true };
			},
		);
	}

	/** Reports for the current host (default) or an explicit host id. */
	getForHost(hostId?: string): StoredFitnessReport[] {
		return Object.values(this.storage.getHost(hostId) ?? {});
	}

	/** Every stored report across all hosts (for cross-machine comparisons). */
	getAll(): StoredFitnessReport[] {
		return this.storage.getAllHosts().flatMap((reports) => Object.values(reports));
	}
}
