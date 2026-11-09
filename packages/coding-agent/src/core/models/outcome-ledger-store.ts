import { createHash } from "node:crypto";
import { harnessLog } from "../../kernel/harness-log.ts";
import { stateFile } from "../agent-paths.ts";
import { isWorkerSession } from "../session-role.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { type HostFingerprint, HostStateStore } from "./host-state-store.ts";

/**
 * Durable, host-keyed evidence of how models do on worker tasks, learned from outcomes. Keyed by
 * `(modelRef, taskClass, toolSurface)`; every part is computed by code. It holds model ids, class strings,
 * capability-family names, decayed counts, timestamps and short digests only: never task, requirement or prompt text,
 * paths, account names or per-task costs. Only the parent host writes (worker sessions open it read-only), and only
 * outcomes whose blocker is attributed to the model (or that succeeded) move it; System One answers never do.
 */

export interface OutcomeLedgerEntry {
	/** Decayed success weight plus the prior. */
	alpha: number;
	/** Decayed failure weight plus the prior. */
	beta: number;
	/** The prior the entry was opened with (from the model's stored fitness score, else 1 / 1). */
	priorAlpha: number;
	priorBeta: number;
	/** EWMA of the per-attempt covered fraction (smoothing 0.25). */
	ewma: number;
	/** Decayed observation count. */
	effective: number;
	/** Consecutive model-attributed failures. */
	streak: number;
	restUntil?: string;
	/** Doubles the rest window per demotion. */
	restLevel: number;
	lastAt: string;
	/** Per-session daily contribution cap: at most 8 rows of `{ day, 8-hex session digest, observations added }`. */
	sessionDay?: { day: string; sessionDigest: string; added: number }[];
	/** 8-hex digests of the last attempts recorded, so no attempt counts twice. */
	recent?: string[];
}

export interface OutcomeLedgerPolicy {
	readonly halfLifeDays: number;
	readonly restHours: number;
	readonly maxRestDays: number;
}

export interface OutcomeObservation {
	readonly modelRef: string;
	readonly taskClass: string;
	readonly toolSurface: string;
	readonly attemptId: string;
	readonly sessionId: string;
	/** Covered fraction of the attempt's required ids, 0..1 (a contradicted claim records 0). */
	readonly coverage: number;
	/** The prior to open a new key with. */
	readonly prior: { readonly alpha: number; readonly beta: number };
}

/** What the resolver knows when it ranks: the worker's role and whether it writes. */
export interface OutcomeRankQuery {
	readonly role: string;
	readonly write: boolean;
}

type LedgerHost = Record<string, OutcomeLedgerEntry>;

const MAX_KEYS = 512;
const MAX_HOST_BYTES = 128 * 1024;
const MAX_SESSION_DAY_ROWS = 8;
const MAX_RECENT = 16;
const SESSION_DAILY_CAP = 5;
const EWMA_WEIGHT = 0.25;
const DEMOTE_STREAK = 3;
const DEMOTE_MEAN = 0.35;
const DEMOTE_MIN_EFFECTIVE = 6;
/** The tool-performance store's evidence bar: a candidate passes the one ahead only with this much evidence and margin. */
export const RANK_MINIMUM_EVIDENCE = 3;
export const RANK_MINIMUM_MARGIN = 0.1;
const MAX_TOOL_FAMILIES = 8;
const HOUR_MS = 3_600_000;

/** Capability families of a worker's tool surface; capabilities outside these families do not shape the key. */
const CAPABILITY_FAMILIES: Readonly<Record<string, string>> = {
	"filesystem.read": "read",
	"repo.read": "read",
	"worktree.read": "read",
	"source.read": "read",
	"skill.read": "read",
	"settings.read": "read",
	"memory.query": "read",
	"filesystem.write": "write",
	"worktree.mutate": "write",
	"source.write": "write",
	"skill.write": "write",
	"settings.write": "write",
	"memory.mutate": "write",
	"process.exec": "shell",
	"tests.execute": "shell",
	"network.http": "web",
	"research.execute": "web",
	"service.mcp": "mcp",
	"semantic.judge": "judge",
	"workflow.delegate": "delegate",
	"workflow.message": "delegate",
};

/** `${role}:${w|r}:${band}` with band `1`, `2-4` or `5+` required ids. */
export function outcomeTaskClass(role: string, write: boolean, requirementCount: number): string {
	const band = requirementCount <= 1 ? "1" : requirementCount <= 4 ? "2-4" : "5+";
	return `${role}:${write ? "w" : "r"}:${band}`;
}

/** Sorted capability families of the worker's granted capabilities, at most 8, e.g. `read+shell+write`. */
export function outcomeToolSurface(capabilities: readonly string[]): string {
	const families = [...new Set(capabilities.map((capability) => CAPABILITY_FAMILIES[capability]))]
		.filter((family): family is string => family !== undefined)
		.sort()
		.slice(0, MAX_TOOL_FAMILIES);
	return families.length > 0 ? families.join("+") : "none";
}

function ledgerKey(modelRef: string, taskClass: string, toolSurface: string): string {
	return `${modelRef}|${taskClass}|${toolSurface}`;
}

function shortDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function finite(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function isEntry(value: unknown): value is OutcomeLedgerEntry {
	return (
		isPlainRecord(value) &&
		finite(value.alpha) &&
		finite(value.beta) &&
		finite(value.priorAlpha) &&
		finite(value.priorBeta) &&
		finite(value.ewma) &&
		finite(value.effective) &&
		finite(value.streak) &&
		finite(value.restLevel) &&
		typeof value.lastAt === "string" &&
		(value.restUntil === undefined || typeof value.restUntil === "string") &&
		(value.sessionDay === undefined ||
			(Array.isArray(value.sessionDay) &&
				value.sessionDay.every(
					(row) =>
						isPlainRecord(row) &&
						typeof row.day === "string" &&
						typeof row.sessionDigest === "string" &&
						finite(row.added),
				))) &&
		(value.recent === undefined ||
			(Array.isArray(value.recent) && value.recent.every((digest) => typeof digest === "string")))
	);
}

function parseLedgerHost(value: unknown): LedgerHost | undefined {
	if (!isPlainRecord(value)) return undefined;
	const host: LedgerHost = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key.split("|").length === 3 && isEntry(entry)) host[key] = entry;
	}
	return host;
}

/** Decay the evidence toward the prior by elapsed half-lives; the prior itself never decays. */
function decayed(entry: OutcomeLedgerEntry, nowMs: number, halfLifeDays: number): OutcomeLedgerEntry {
	const elapsed = Math.max(0, nowMs - Date.parse(entry.lastAt));
	if (!Number.isFinite(elapsed) || elapsed === 0) return entry;
	const factor = 0.5 ** (elapsed / (halfLifeDays * 24 * HOUR_MS));
	return {
		...entry,
		alpha: entry.priorAlpha + Math.max(0, entry.alpha - entry.priorAlpha) * factor,
		beta: entry.priorBeta + Math.max(0, entry.beta - entry.priorBeta) * factor,
		effective: entry.effective * factor,
	};
}

function mean(alpha: number, beta: number): number {
	return alpha + beta > 0 ? alpha / (alpha + beta) : 0.5;
}

function isResting(entry: OutcomeLedgerEntry, nowMs: number): boolean {
	return entry.restUntil !== undefined && Date.parse(entry.restUntil) > nowMs;
}

/** Drop the oldest rows until the host fits its key and byte caps. */
function evict(host: LedgerHost): void {
	const keys = Object.keys(host).sort(
		(left, right) => Date.parse(host[left]!.lastAt) - Date.parse(host[right]!.lastAt),
	);
	while (keys.length > MAX_KEYS) delete host[keys.shift()!];
	while (keys.length > 1 && Buffer.byteLength(JSON.stringify(host), "utf8") > MAX_HOST_BYTES)
		delete host[keys.shift()!];
}

export class OutcomeLedgerStore {
	private readonly storage: HostStateStore<LedgerHost>;

	constructor(filePath: string, options?: { fingerprint?: () => HostFingerprint; readOnly?: boolean }) {
		this.storage = new HostStateStore({
			filePath,
			version: 1,
			fingerprint: options?.fingerprint,
			readOnly: options?.readOnly ?? isWorkerSession(),
			parseHost: parseLedgerHost,
		});
	}

	static forAgentDir(
		agentDir: string,
		options?: { fingerprint?: () => HostFingerprint; readOnly?: boolean },
	): OutcomeLedgerStore {
		return new OutcomeLedgerStore(stateFile(agentDir, "outcome-ledger.json"), options);
	}

	/**
	 * Record one attempt. Returns false when nothing changed: the attempt was already counted, or the session reached its
	 * daily cap for the key. A failed attempt extends the streak; a demotion rests the key for its task class.
	 */
	observe(observation: OutcomeObservation, policy: OutcomeLedgerPolicy, nowMs: number): boolean {
		const attemptDigest = shortDigest(observation.attemptId);
		const sessionDigest = shortDigest(observation.sessionId);
		const day = new Date(nowMs).toISOString().slice(0, 10);
		const key = ledgerKey(observation.modelRef, observation.taskClass, observation.toolSurface);
		return this.storage.mutateCurrentHost(
			() => ({}),
			(host) => {
				const opened: OutcomeLedgerEntry = {
					alpha: observation.prior.alpha,
					beta: observation.prior.beta,
					priorAlpha: observation.prior.alpha,
					priorBeta: observation.prior.beta,
					ewma: observation.coverage,
					effective: 0,
					streak: 0,
					restLevel: 0,
					lastAt: new Date(nowMs).toISOString(),
				};
				const existing = host[key];
				const entry = existing ? decayed(existing, nowMs, policy.halfLifeDays) : opened;
				if (entry.recent?.includes(attemptDigest)) return { result: false, changed: false };
				const sessionRows = (entry.sessionDay ?? []).filter((row) => row.day === day);
				const own = sessionRows.find((row) => row.sessionDigest === sessionDigest);
				if ((own?.added ?? 0) >= SESSION_DAILY_CAP) return { result: false, changed: false };
				const c = Math.min(1, Math.max(0, observation.coverage));
				const failed = c < 1;
				const wasResting = entry.restLevel > 0 && !isResting(entry, nowMs);
				const next: OutcomeLedgerEntry = {
					...entry,
					alpha: entry.alpha + c,
					beta: entry.beta + (1 - c),
					ewma: existing ? entry.ewma * (1 - EWMA_WEIGHT) + c * EWMA_WEIGHT : c,
					effective: entry.effective + 1,
					streak: failed ? entry.streak + 1 : 0,
					restLevel: !failed && entry.restLevel > 0 ? entry.restLevel - 1 : entry.restLevel,
					lastAt: new Date(nowMs).toISOString(),
					sessionDay: [
						...sessionRows.filter((row) => row.sessionDigest !== sessionDigest),
						{ day, sessionDigest, added: (own?.added ?? 0) + 1 },
					].slice(-MAX_SESSION_DAY_ROWS),
					recent: [...(entry.recent ?? []), attemptDigest].slice(-MAX_RECENT),
				};
				const demote =
					failed &&
					(next.streak >= DEMOTE_STREAK ||
						(mean(next.alpha, next.beta) < DEMOTE_MEAN && next.effective >= DEMOTE_MIN_EFFECTIVE) ||
						wasResting);
				if (demote) {
					const restMs = Math.min(
						policy.restHours * 2 ** next.restLevel * HOUR_MS,
						policy.maxRestDays * 24 * HOUR_MS,
					);
					next.restUntil = new Date(nowMs + restMs).toISOString();
					next.restLevel += 1;
					next.streak = 0;
					harnessLog.warn("router", "a model rests for a worker task class after model-attributed failures", {
						modelRef: observation.modelRef,
						taskClass: observation.taskClass,
						toolSurface: observation.toolSurface,
						restUntil: next.restUntil,
						restLevel: next.restLevel,
					});
				} else if (!failed && next.restUntil !== undefined && !isResting(next, nowMs)) {
					delete next.restUntil;
				}
				host[key] = next;
				evict(host);
				return { result: true, changed: true };
			},
		);
	}

	/**
	 * Reorder candidates by outcome evidence for the role and write class, never adding or removing one. A candidate
	 * passes the one ahead only with enough evidence and margin, so a cold ledger keeps the routed order; candidates
	 * resting for the class go last. Evidence of every requirement band and tool surface of the class is pooled: the
	 * resolver ranks before the band and the compiled tool surface are known.
	 */
	rank<T>(
		candidates: readonly T[],
		modelRefOf: (candidate: T) => string,
		query: OutcomeRankQuery,
		priorOf: (modelRef: string) => { alpha: number; beta: number },
		policy: OutcomeLedgerPolicy,
		nowMs: number,
	): T[] {
		if (candidates.length < 2) return [...candidates];
		const host = this.storage.getHost() ?? {};
		const prefix = `${query.role}:${query.write ? "w" : "r"}:`;
		const scored = candidates.map((candidate, index) => {
			const modelRef = modelRefOf(candidate);
			const prior = priorOf(modelRef);
			let alpha = prior.alpha;
			let beta = prior.beta;
			let effective = 0;
			let resting = false;
			for (const [key, stored] of Object.entries(host)) {
				const [ref, taskClass] = key.split("|");
				if (ref !== modelRef || !taskClass?.startsWith(prefix)) continue;
				const entry = decayed(stored, nowMs, policy.halfLifeDays);
				alpha += Math.max(0, entry.alpha - entry.priorAlpha);
				beta += Math.max(0, entry.beta - entry.priorBeta);
				effective += entry.effective;
				resting ||= isResting(entry, nowMs);
			}
			return { candidate, index, modelRef, mean: mean(alpha, beta), effective, resting };
		});
		const order = [...scored];
		for (let moved = true; moved; ) {
			moved = false;
			for (let position = 1; position < order.length; position += 1) {
				const ahead = order[position - 1]!;
				const current = order[position]!;
				if (current.effective >= RANK_MINIMUM_EVIDENCE && current.mean - ahead.mean >= RANK_MINIMUM_MARGIN) {
					order[position - 1] = current;
					order[position] = ahead;
					moved = true;
				}
			}
		}
		const ranked = [...order.filter((entry) => !entry.resting), ...order.filter((entry) => entry.resting)];
		if (ranked.some((entry, position) => entry.index !== position)) {
			harnessLog.info("router", "outcome evidence reordered the routed worker models", {
				taskClass: prefix.slice(0, -1),
				before: scored.map((entry) => entry.modelRef).join(","),
				after: ranked.map((entry) => entry.modelRef).join(","),
			});
		}
		return ranked.map((entry) => entry.candidate);
	}
}
