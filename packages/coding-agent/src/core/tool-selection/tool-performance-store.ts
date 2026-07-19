import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stateFile } from "../agent-paths.ts";
import { currentHostFingerprint, type HostFingerprint } from "../models/fitness-store.ts";
import { isWorkerSession } from "../session-role.ts";

const STORE_VERSION = 1;
const MAX_STATS_PER_HOST = 500;
const MAX_OBSERVATIONS_PER_HOST = 1_000;
const MAX_INTENT_AGREEMENT_PER_HOST = 500;
const EWMA_ALPHA = 0.25;

export type ToolSelectionIntentClass = "read" | "search" | "execute" | "write" | "retrieve" | "explain" | "other";

export interface ToolPerformanceKey {
	modelRef: string;
	intentClass: ToolSelectionIntentClass;
	tool: string;
}

export interface ToolPerformanceStats extends ToolPerformanceKey {
	alpha: number;
	beta: number;
	sampleCount: number;
	latencyEwmaMs?: number;
	latencyDeviationEwmaMs?: number;
	inputTokenEstimateEwma?: number;
	outputTokenEstimateEwma?: number;
	repairCount: number;
	bounceCount: number;
	failureCount: number;
	lastUsedAt: string;
}

export interface ToolSelectionObservation {
	at: string;
	modelRef: string;
	intentClass: ToolSelectionIntentClass;
	actualTool: string;
	firstTool: boolean;
	succeeded: boolean;
	disposition: "recommend" | "shortlist" | "abstain";
	recommendation?: string;
	shortlist: string[];
	entropy: number;
	margin: number;
	/** Redacted ranking: names and numeric scores only, never prompts, arguments, paths, or output. */
	ranked: Array<{ tool: string; utility: number; probability: number }>;
	latencyMs?: number;
	inputTokenEstimate?: number;
	outputTokenEstimate?: number;
}

export interface ToolSelectionMetrics {
	firstToolAttempts: number;
	firstToolSuccesses: number;
	wrongToolOrFailureCount: number;
	recommendationCount: number;
	recommendationMatchedCount: number;
	shortlistCount: number;
	abstentionCount: number;
	averageLatencyMs?: number;
	averageInputTokenEstimate?: number;
	averageOutputTokenEstimate?: number;
}

/**
 * Durable, per-(model,intent) aggregate of the observe-mode loop: does the raw expected-utility
 * ranking's top pick (`ToolSelectionObservation.ranked[0]`) match what the model actually called
 * (`ToolSelectionObservation.actualTool`)? Tracked separately from the capped, rolling
 * `observations` log so evidence for a given (model,intent) pair survives that log's trimming.
 * `hintActive*` fields are the SAME agreement measure, but restricted to calls made while an
 * evidence-gated promotion hint (see promotion.ts) was active for this bucket — the hint's own
 * efficacy trace: it never gates activation directly (that is always
 * recomputed live from `ToolPerformanceStats`), but it is the durable evidence a report can show
 * for "is the hint still earning its keep".
 */
export interface ToolSelectionIntentAgreement {
	modelRef: string;
	intentClass: ToolSelectionIntentClass;
	sampleCount: number;
	agreementCount: number;
	hintActiveSampleCount: number;
	hintActiveAgreementCount: number;
	lastUpdatedAt: string;
}

interface HostToolPerformanceData {
	host: HostFingerprint;
	stats: Record<string, ToolPerformanceStats>;
	observations: ToolSelectionObservation[];
	intentAgreement: Record<string, ToolSelectionIntentAgreement>;
}

interface ToolPerformanceStoreFile {
	version: 1;
	hosts: Record<string, HostToolPerformanceData>;
}

export interface ToolExecutionObservation {
	key: ToolPerformanceKey;
	success: boolean;
	latencyMs: number;
	inputTokenEstimate?: number;
	outputTokenEstimate?: number;
	selection: Omit<ToolSelectionObservation, "at" | "modelRef" | "intentClass" | "actualTool" | "succeeded">;
	at?: string;
	/**
	 * Whether an evidence-gated promotion hint (promotion.ts) was already active for this
	 * (model,intent) bucket BEFORE this call was recorded — captured by the controller at
	 * `begin()` time, so it reflects evidence up to but not including this observation. Used only
	 * to bucket the durable agreement stats (`ToolSelectionIntentAgreement.hintActive*`); never
	 * changes what gets recorded, only how it is split for the efficacy report.
	 */
	hintActiveAtCallTime?: boolean;
}

function statKey(key: ToolPerformanceKey): string {
	return `${key.modelRef}\0${key.intentClass}\0${key.tool}`;
}

function intentAgreementKey(modelRef: string, intentClass: ToolSelectionIntentClass): string {
	return `${modelRef}\0${intentClass}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntentClass(value: unknown): value is ToolSelectionIntentClass {
	return (
		value === "read" ||
		value === "search" ||
		value === "execute" ||
		value === "write" ||
		value === "retrieve" ||
		value === "explain" ||
		value === "other"
	);
}

function isStats(value: unknown): value is ToolPerformanceStats {
	return (
		isRecord(value) &&
		typeof value.modelRef === "string" &&
		isIntentClass(value.intentClass) &&
		typeof value.tool === "string" &&
		typeof value.alpha === "number" &&
		typeof value.beta === "number" &&
		typeof value.sampleCount === "number" &&
		typeof value.repairCount === "number" &&
		typeof value.bounceCount === "number" &&
		typeof value.failureCount === "number" &&
		typeof value.lastUsedAt === "string"
	);
}

function isObservation(value: unknown): value is ToolSelectionObservation {
	return (
		isRecord(value) &&
		typeof value.at === "string" &&
		typeof value.modelRef === "string" &&
		isIntentClass(value.intentClass) &&
		typeof value.actualTool === "string" &&
		typeof value.firstTool === "boolean" &&
		typeof value.succeeded === "boolean" &&
		(value.disposition === "recommend" || value.disposition === "shortlist" || value.disposition === "abstain") &&
		Array.isArray(value.shortlist) &&
		value.shortlist.every((tool) => typeof tool === "string") &&
		typeof value.entropy === "number" &&
		typeof value.margin === "number" &&
		Array.isArray(value.ranked) &&
		value.ranked.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.tool === "string" &&
				typeof entry.utility === "number" &&
				typeof entry.probability === "number",
		) &&
		(value.latencyMs === undefined || typeof value.latencyMs === "number") &&
		(value.inputTokenEstimate === undefined || typeof value.inputTokenEstimate === "number") &&
		(value.outputTokenEstimate === undefined || typeof value.outputTokenEstimate === "number")
	);
}

function isIntentAgreement(value: unknown): value is ToolSelectionIntentAgreement {
	return (
		isRecord(value) &&
		typeof value.modelRef === "string" &&
		isIntentClass(value.intentClass) &&
		typeof value.sampleCount === "number" &&
		typeof value.agreementCount === "number" &&
		typeof value.hintActiveSampleCount === "number" &&
		typeof value.hintActiveAgreementCount === "number" &&
		typeof value.lastUpdatedAt === "string"
	);
}

function emptyStats(key: ToolPerformanceKey, at: string): ToolPerformanceStats {
	return {
		...key,
		alpha: 1,
		beta: 1,
		sampleCount: 0,
		repairCount: 0,
		bounceCount: 0,
		failureCount: 0,
		lastUsedAt: at,
	};
}

function emptyIntentAgreement(
	modelRef: string,
	intentClass: ToolSelectionIntentClass,
	at: string,
): ToolSelectionIntentAgreement {
	return {
		modelRef,
		intentClass,
		sampleCount: 0,
		agreementCount: 0,
		hintActiveSampleCount: 0,
		hintActiveAgreementCount: 0,
		lastUpdatedAt: at,
	};
}

function finiteNonNegative(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function updateEwma(previous: number | undefined, next: number | undefined): number | undefined {
	if (next === undefined) return previous;
	return previous === undefined ? next : previous + EWMA_ALPHA * (next - previous);
}

function updateDeviation(
	previousValue: number | undefined,
	previousDeviation: number | undefined,
	next: number | undefined,
): number | undefined {
	if (next === undefined) return previousDeviation;
	const deviation = previousValue === undefined ? 0 : Math.abs(next - previousValue);
	return updateEwma(previousDeviation, deviation);
}

function parseHost(value: unknown): HostToolPerformanceData | undefined {
	if (!isRecord(value) || !isRecord(value.host) || !isRecord(value.stats) || !Array.isArray(value.observations))
		return undefined;
	const host = value.host;
	if (
		typeof host.id !== "string" ||
		typeof host.cpu !== "string" ||
		typeof host.cores !== "number" ||
		typeof host.totalMemGb !== "number"
	)
		return undefined;
	// intentAgreement is a purely additive field (older store files predate it) — tolerate absence
	// rather than bumping STORE_VERSION, same as any other backward-compatible default-empty field.
	const intentAgreementRaw = isRecord(value.intentAgreement) ? value.intentAgreement : {};
	return {
		host: { id: host.id, cpu: host.cpu, cores: host.cores, totalMemGb: host.totalMemGb },
		stats: Object.fromEntries(
			Object.entries(value.stats).filter((entry): entry is [string, ToolPerformanceStats] => isStats(entry[1])),
		),
		observations: value.observations.filter(isObservation),
		intentAgreement: Object.fromEntries(
			Object.entries(intentAgreementRaw).filter((entry): entry is [string, ToolSelectionIntentAgreement] =>
				isIntentAgreement(entry[1]),
			),
		),
	};
}

function parseFile(value: unknown): ToolPerformanceStoreFile {
	if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.hosts)) {
		return { version: STORE_VERSION, hosts: {} };
	}
	return {
		version: STORE_VERSION,
		hosts: Object.fromEntries(
			Object.entries(value.hosts)
				.map(([hostId, host]) => [hostId, parseHost(host)] as const)
				.filter((entry): entry is readonly [string, HostToolPerformanceData] => entry[1] !== undefined),
		),
	};
}

function trimStats(stats: Record<string, ToolPerformanceStats>): Record<string, ToolPerformanceStats> {
	const entries = Object.entries(stats);
	if (entries.length <= MAX_STATS_PER_HOST) return stats;
	return Object.fromEntries(
		entries
			.sort(([, left], [, right]) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt))
			.slice(0, MAX_STATS_PER_HOST),
	);
}

function trimIntentAgreement(
	records: Record<string, ToolSelectionIntentAgreement>,
): Record<string, ToolSelectionIntentAgreement> {
	const entries = Object.entries(records);
	if (entries.length <= MAX_INTENT_AGREEMENT_PER_HOST) return records;
	return Object.fromEntries(
		entries
			.sort(([, left], [, right]) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
			.slice(0, MAX_INTENT_AGREEMENT_PER_HOST),
	);
}

export class ToolPerformanceStore {
	private readonly filePath: string;
	private readonly fingerprint: () => HostFingerprint;
	private readonly readOnly: boolean;

	constructor(filePath: string, options: { fingerprint?: () => HostFingerprint; readOnly?: boolean } = {}) {
		this.filePath = filePath;
		this.fingerprint = options.fingerprint ?? currentHostFingerprint;
		this.readOnly = options.readOnly ?? isWorkerSession();
	}

	static forAgentDir(
		agentDir: string,
		options: { fingerprint?: () => HostFingerprint; readOnly?: boolean } = {},
	): ToolPerformanceStore {
		return new ToolPerformanceStore(stateFile(agentDir, "tool-performance.json"), options);
	}

	private load(): ToolPerformanceStoreFile {
		try {
			if (!existsSync(this.filePath)) return { version: STORE_VERSION, hosts: {} };
			return parseFile(JSON.parse(readFileSync(this.filePath, "utf8")));
		} catch {
			return { version: STORE_VERSION, hosts: {} };
		}
	}

	private save(file: ToolPerformanceStoreFile): void {
		// Zero-footprint (worker session): never create the state dir, lock, or file -- the caller
		// still gets its normally-computed return value from the in-memory `file`.
		if (this.readOnly) return;
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	}

	private hostData(file: ToolPerformanceStoreFile): HostToolPerformanceData {
		const fingerprint = this.fingerprint();
		const existing = file.hosts[fingerprint.id];
		if (existing) return existing;
		const created: HostToolPerformanceData = { host: fingerprint, stats: {}, observations: [], intentAgreement: {} };
		file.hosts[fingerprint.id] = created;
		return created;
	}

	get(key: ToolPerformanceKey): ToolPerformanceStats {
		const file = this.load();
		const host = file.hosts[this.fingerprint().id];
		const stats = host?.stats[statKey(key)];
		return stats ? { ...stats } : emptyStats(key, new Date(0).toISOString());
	}

	/** Every per-tool track record recorded for a (model,intent) bucket — the promotion.ts input. */
	getStatsForIntent(modelRef: string, intentClass: ToolSelectionIntentClass): ToolPerformanceStats[] {
		const host = this.load().hosts[this.fingerprint().id];
		if (!host) return [];
		return Object.values(host.stats)
			.filter((stats) => stats.modelRef === modelRef && stats.intentClass === intentClass)
			.map((stats) => ({ ...stats }));
	}

	/** Durable observe-mode agreement for one (model,intent) bucket (see {@link ToolSelectionIntentAgreement}). */
	getIntentAgreement(modelRef: string, intentClass: ToolSelectionIntentClass): ToolSelectionIntentAgreement {
		const host = this.load().hosts[this.fingerprint().id];
		const record = host?.intentAgreement[intentAgreementKey(modelRef, intentClass)];
		return record ? { ...record } : emptyIntentAgreement(modelRef, intentClass, new Date(0).toISOString());
	}

	/** All recorded (model,intent) agreement buckets, optionally scoped to one model — report input. */
	getAllIntentAgreements(modelRef?: string): ToolSelectionIntentAgreement[] {
		const host = this.load().hosts[this.fingerprint().id];
		return Object.values(host?.intentAgreement ?? {})
			.filter((record) => modelRef === undefined || record.modelRef === modelRef)
			.map((record) => ({ ...record }));
	}

	recordValidation(
		key: ToolPerformanceKey,
		outcome: "repaired" | "bounced",
		at = new Date().toISOString(),
	): ToolPerformanceStats {
		const file = this.load();
		const host = this.hostData(file);
		const storageKey = statKey(key);
		const current = host.stats[storageKey] ?? emptyStats(key, at);
		const next: ToolPerformanceStats = {
			...current,
			repairCount: current.repairCount + (outcome === "repaired" ? 1 : 0),
			bounceCount: current.bounceCount + (outcome === "bounced" ? 1 : 0),
			lastUsedAt: at,
		};
		host.stats[storageKey] = next;
		host.stats = trimStats(host.stats);
		this.save(file);
		return { ...next };
	}

	recordExecution(observation: ToolExecutionObservation): ToolPerformanceStats {
		const at = observation.at ?? new Date().toISOString();
		const file = this.load();
		const host = this.hostData(file);
		const storageKey = statKey(observation.key);
		const current = host.stats[storageKey] ?? emptyStats(observation.key, at);
		const latencyMs = finiteNonNegative(observation.latencyMs);
		const inputTokenEstimate = finiteNonNegative(observation.inputTokenEstimate);
		const outputTokenEstimate = finiteNonNegative(observation.outputTokenEstimate);
		const next: ToolPerformanceStats = {
			...current,
			alpha: current.alpha + (observation.success ? 1 : 0),
			beta: current.beta + (observation.success ? 0 : 1),
			sampleCount: current.sampleCount + 1,
			latencyEwmaMs: updateEwma(current.latencyEwmaMs, latencyMs),
			latencyDeviationEwmaMs: updateDeviation(current.latencyEwmaMs, current.latencyDeviationEwmaMs, latencyMs),
			inputTokenEstimateEwma: updateEwma(current.inputTokenEstimateEwma, inputTokenEstimate),
			outputTokenEstimateEwma: updateEwma(current.outputTokenEstimateEwma, outputTokenEstimate),
			failureCount: current.failureCount + (observation.success ? 0 : 1),
			lastUsedAt: at,
		};
		host.stats[storageKey] = next;
		host.stats = trimStats(host.stats);
		host.observations.push({
			...observation.selection,
			at,
			modelRef: observation.key.modelRef,
			intentClass: observation.key.intentClass,
			actualTool: observation.key.tool,
			succeeded: observation.success,
			ranked: observation.selection.ranked.slice(0, 6),
			shortlist: observation.selection.shortlist.slice(0, 3),
			latencyMs,
			inputTokenEstimate,
			outputTokenEstimate,
		});
		if (host.observations.length > MAX_OBSERVATIONS_PER_HOST) {
			host.observations = host.observations.slice(-MAX_OBSERVATIONS_PER_HOST);
		}

		// Observe-mode agreement: did the RAW ranking's top pick (before any actual-tool-only
		// eligibility gating) match what the model actually called? Recorded durably per
		// (model,intent), separate from the capped `observations` log above, so it survives trimming.
		const predictedBest = observation.selection.ranked[0]?.tool;
		const agreed = predictedBest !== undefined && predictedBest === observation.key.tool;
		const agreementKey = intentAgreementKey(observation.key.modelRef, observation.key.intentClass);
		const currentAgreement =
			host.intentAgreement[agreementKey] ??
			emptyIntentAgreement(observation.key.modelRef, observation.key.intentClass, at);
		host.intentAgreement[agreementKey] = {
			...currentAgreement,
			sampleCount: currentAgreement.sampleCount + 1,
			agreementCount: currentAgreement.agreementCount + (agreed ? 1 : 0),
			hintActiveSampleCount: currentAgreement.hintActiveSampleCount + (observation.hintActiveAtCallTime ? 1 : 0),
			hintActiveAgreementCount:
				currentAgreement.hintActiveAgreementCount + (observation.hintActiveAtCallTime && agreed ? 1 : 0),
			lastUpdatedAt: at,
		};
		host.intentAgreement = trimIntentAgreement(host.intentAgreement);

		this.save(file);
		return { ...next };
	}

	getMetrics(modelRef?: string): ToolSelectionMetrics {
		const host = this.load().hosts[this.fingerprint().id];
		const observations = (host?.observations ?? []).filter(
			(observation) => modelRef === undefined || observation.modelRef === modelRef,
		);
		const firstTools = observations.filter((observation) => observation.firstTool);
		const recommended = observations.filter((observation) => observation.disposition === "recommend");
		const average = (values: Array<number | undefined>): number | undefined => {
			const present = values.filter((value): value is number => value !== undefined);
			return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : undefined;
		};
		return {
			firstToolAttempts: firstTools.length,
			firstToolSuccesses: firstTools.filter((observation) => observation.succeeded).length,
			wrongToolOrFailureCount: observations.filter(
				(observation) =>
					!observation.succeeded ||
					(observation.disposition === "recommend" && observation.recommendation !== observation.actualTool),
			).length,
			recommendationCount: recommended.length,
			recommendationMatchedCount: recommended.filter(
				(observation) => observation.recommendation === observation.actualTool,
			).length,
			shortlistCount: observations.filter((observation) => observation.disposition === "shortlist").length,
			abstentionCount: observations.filter((observation) => observation.disposition === "abstain").length,
			averageLatencyMs: average(observations.map((observation) => observation.latencyMs)),
			averageInputTokenEstimate: average(observations.map((observation) => observation.inputTokenEstimate)),
			averageOutputTokenEstimate: average(observations.map((observation) => observation.outputTokenEstimate)),
		};
	}

	getObservations(modelRef?: string): ToolSelectionObservation[] {
		const host = this.load().hosts[this.fingerprint().id];
		return (host?.observations ?? [])
			.filter((observation) => modelRef === undefined || observation.modelRef === modelRef)
			.map((observation) => ({
				...observation,
				shortlist: [...observation.shortlist],
				ranked: observation.ranked.map((candidate) => ({ ...candidate })),
			}));
	}
}
