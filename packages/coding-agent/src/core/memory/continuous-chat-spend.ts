import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
	isProcessOwnerRecord,
	judgeOwner,
	type OwnerStanding,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { DEFAULT_RETRY_POLICY } from "../../kernel/reliability/retry.ts";
import { isSessionIdentity } from "../../kernel/session/session-identity.ts";
import { readOptionalBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";
import type { FaultableFs } from "../../kernel/storage/faultable-fs.ts";
import {
	acknowledgeSummarySpend,
	cancelUndispatchedSummarySpend,
	readSummarySpendReceipt,
	requestSummarySpendRecovery,
} from "../cost/semantic-usage-journal.ts";
import type { SemanticUsageLedgerIdentity } from "../cost/session-ledger-port.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";

/** What the chat's background summaries may spend per day when the setting is unset. */
export const DEFAULT_CONTINUOUS_CHAT_COMPACTION_MAX_USD_PER_DAY = 10;
export const CONTINUOUS_CHAT_ACCOUNTING_COOLDOWN_MS = DEFAULT_RETRY_POLICY.maxDelayMs;
const MAX_CIRCUITS = 256;
const MAX_STATE_BYTES = 256 * 1024;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function isUtcDay(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const time = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isObservationTime(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		Number.isFinite(new Date(value).getTime())
	);
}

function recoveryIdentity(value: unknown): SemanticUsageLedgerIdentity | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["sessionId", "sessionFile", "headerTimestamp", "persisted"]) ||
		value.persisted !== true ||
		typeof value.sessionId !== "string" ||
		!isSessionIdentity(value.sessionId) ||
		typeof value.sessionFile !== "string" ||
		value.sessionFile.length > 4096 ||
		!isAbsolute(value.sessionFile) ||
		/[\u0000-\u001f\u007f]/u.test(value.sessionFile) ||
		typeof value.headerTimestamp !== "string" ||
		value.headerTimestamp.length === 0 ||
		value.headerTimestamp.length > 200
	)
		return undefined;
	return {
		sessionId: value.sessionId,
		sessionFile: value.sessionFile,
		headerTimestamp: value.headerTimestamp,
		persisted: true,
	};
}

function pendingAckOf(value: unknown): PendingAck | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["identity", "costUsd", "observedAtMs", "ackStarted"]))
		return undefined;
	const identity = recoveryIdentity(value.identity);
	if (
		!identity ||
		typeof value.costUsd !== "number" ||
		!Number.isFinite(value.costUsd) ||
		value.costUsd < 0 ||
		!isObservationTime(value.observedAtMs) ||
		typeof value.ackStarted !== "boolean"
	)
		return undefined;
	return { identity, costUsd: value.costUsd, observedAtMs: value.observedAtMs, ackStarted: value.ackStarted };
}

type Circuit =
	| { status: "held"; until: number; token: string; pendingAck?: PendingAck }
	| { status: "flight"; token: string; owner: ProcessOwner; identity?: SemanticUsageLedgerIdentity }
	| { status: "reserved"; token: string; owner: ProcessOwner; identity?: SemanticUsageLedgerIdentity }
	| { status: "unknown"; token: string; identity?: SemanticUsageLedgerIdentity }
	| { status: "settled"; token: string; pendingAck?: PendingAck };
interface PendingAck {
	identity: SemanticUsageLedgerIdentity;
	costUsd: number;
	observedAtMs: number;
	ackStarted: boolean;
}
interface SpendState {
	schemaVersion: 3;
	day: string;
	usd: number;
	/** Known measured charges outside `day`; not a reconstruction of lifetime provider billing. */
	archivedMeasuredUsd: number;
	circuits: Record<string, Circuit>;
}

/** A physical request is already outstanding, or its accounting is cooling down. */
export class ContinuousChatAccountingBusy extends Error {}

/** A dead physical request has no safely reconciled usage evidence. */
export class ContinuousChatAccountingUnresolved extends Error {
	constructor() {
		super("Memory summaries wait for an earlier request's usage receipt to be reconciled.");
		this.name = "ContinuousChatAccountingUnresolved";
	}
}

/** A replacement may have committed; the caller must retain this token until it can settle it. */
export class ContinuousChatAccountingClaimWriteError extends Error {
	readonly token: string;
	constructor(token: string, cause: unknown) {
		super("Memory summary accounting claim could not be confirmed.", { cause });
		this.name = "ContinuousChatAccountingClaimWriteError";
		this.token = token;
	}
}

/** Liveness is injectable so ownership decisions share the host's one authority. */
export interface ContinuousChatSpendOwnerPort {
	own(): ProcessOwner;
	judge(owner: ProcessOwner): OwnerStanding;
}

/** Receipt storage boundary; production uses the semantic journal, with injection for deterministic fault tests. */
export interface ContinuousChatSpendJournalPort {
	read: typeof readSummarySpendReceipt;
	acknowledge: typeof acknowledgeSummarySpend;
	cancelUndispatched: typeof cancelUndispatchedSummarySpend;
	requestRecovery: typeof requestSummarySpendRecovery;
}

/**
 * Account-shared summary spend and physical request custody. Each model/session identity has one physical slot,
 * reducing background concurrency from eight jobs to one per identity so an unrecorded failure cannot race another
 * process. The locked claim is written before dispatch, and only its token can settle it. Dead owners are re-parked;
 * live, foreign and unknown owners remain fenced. Unknown historical journal obligations are not resolved here.
 */
export class ContinuousChatSpendMeter {
	private readonly file: string;
	private readonly maxUsdPerDay: () => number;
	readonly timers: TimerPort;
	private readonly owners: ContinuousChatSpendOwnerPort;
	private readonly fs: FaultableFs | undefined;
	private readonly journal: ContinuousChatSpendJournalPort;
	constructor(
		file: string,
		maxUsdPerDay: () => number,
		timers: TimerPort,
		owners: ContinuousChatSpendOwnerPort = { own: ownProcessOwner, judge: judgeOwner },
		fs?: FaultableFs,
		journal: ContinuousChatSpendJournalPort = {
			read: readSummarySpendReceipt,
			acknowledge: acknowledgeSummarySpend,
			cancelUndispatched: cancelUndispatchedSummarySpend,
			requestRecovery: requestSummarySpendRecovery,
		},
	) {
		this.file = file;
		this.maxUsdPerDay = maxUsdPerDay;
		this.timers = timers;
		this.owners = owners;
		this.fs = fs;
		this.journal = journal;
	}
	private today(): string {
		return new Date(this.timers.now()).toISOString().slice(0, 10);
	}
	private read(): SpendState {
		const text = readOptionalBoundedTextFileSync(this.file, MAX_STATE_BYTES, "Continuous-chat spend");
		if (text === undefined)
			return { schemaVersion: 3, day: this.today(), usd: 0, archivedMeasuredUsd: 0, circuits: {} };
		const value: unknown = JSON.parse(text);
		if (
			!isPlainRecord(value) ||
			!(
				(value.schemaVersion === undefined && hasOnlyKeys(value, ["day", "usd"]) && value.circuits === undefined) ||
				(value.schemaVersion === 1 &&
					hasOnlyKeys(value, ["schemaVersion", "day", "usd", "circuits"]) &&
					isPlainRecord(value.circuits)) ||
				((value.schemaVersion === 2 || value.schemaVersion === 3) &&
					hasOnlyKeys(value, ["schemaVersion", "day", "usd", "archivedMeasuredUsd", "circuits"]) &&
					isPlainRecord(value.circuits) &&
					typeof value.archivedMeasuredUsd === "number" &&
					Number.isFinite(value.archivedMeasuredUsd) &&
					value.archivedMeasuredUsd >= 0)
			) ||
			!isUtcDay(value.day) ||
			typeof value.usd !== "number" ||
			!Number.isFinite(value.usd) ||
			value.usd < 0 ||
			(value.circuits !== undefined && !isPlainRecord(value.circuits))
		)
			throw new Error("Continuous-chat spend state is invalid.");
		const circuits: Record<string, Circuit> = {};
		const entries = Object.entries(value.circuits ?? {});
		if (entries.length > MAX_CIRCUITS) throw new Error("Continuous-chat accounting state exceeds its bound.");
		for (const [key, item] of entries) {
			if (
				!KEY_PATTERN.test(key) ||
				!isPlainRecord(item) ||
				typeof item.token !== "string" ||
				!TOKEN_PATTERN.test(item.token)
			)
				throw new Error("Continuous-chat accounting state is invalid.");
			const identity = item.identity === undefined ? undefined : recoveryIdentity(item.identity);
			const pendingAck = item.pendingAck === undefined ? undefined : pendingAckOf(item.pendingAck);
			if (value.schemaVersion !== 3 && (identity || pendingAck || item.status === "unknown"))
				throw new Error("Continuous-chat accounting state is invalid.");
			if ((item.identity !== undefined && !identity) || (item.pendingAck !== undefined && !pendingAck))
				throw new Error("Continuous-chat accounting state is invalid.");
			if (
				item.status === "held" &&
				hasOnlyKeys(item, ["status", "token", "until", "pendingAck"]) &&
				typeof item.until === "number" &&
				Number.isSafeInteger(item.until) &&
				item.until >= 0
			)
				circuits[key] = {
					status: "held",
					token: item.token,
					until: item.until,
					...(pendingAck ? { pendingAck } : {}),
				};
			else if (item.status === "settled" && hasOnlyKeys(item, ["status", "token", "pendingAck"]))
				circuits[key] = { status: "settled", token: item.token, ...(pendingAck ? { pendingAck } : {}) };
			else if (
				(item.status === "flight" || (value.schemaVersion === 3 && item.status === "reserved")) &&
				hasOnlyKeys(item, ["status", "token", "owner", "identity"]) &&
				isPlainRecord(item.owner) &&
				hasOnlyKeys(item.owner, ["pid", "startTime", "hostname", "machineId"]) &&
				isProcessOwnerRecord(item.owner) &&
				typeof item.owner.hostname === "string" &&
				item.owner.hostname.length > 0
			)
				circuits[key] = {
					status: item.status,
					token: item.token,
					owner: item.owner,
					...(identity ? { identity } : {}),
				};
			else if (item.status === "unknown" && hasOnlyKeys(item, ["status", "token", "identity"]))
				circuits[key] = { status: "unknown", token: item.token, ...(identity ? { identity } : {}) };
			else throw new Error("Continuous-chat accounting state is invalid.");
		}
		return {
			schemaVersion: 3,
			day: value.day,
			usd: value.usd,
			archivedMeasuredUsd:
				value.schemaVersion === 2 || value.schemaVersion === 3 ? (value.archivedMeasuredUsd as number) : 0,
			circuits,
		};
	}
	private save(state: SpendState): void {
		const serialized = JSON.stringify(state);
		if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES)
			throw new Error("Continuous-chat accounting state exceeds its byte limit.");
		writeFileAtomicSync(this.file, serialized, this.fs ? { fs: this.fs } : undefined);
	}
	private rollover(state: SpendState): void {
		const day = this.today();
		if (day < state.day) throw new Error("Continuous-chat accounting clock moved before its active UTC day.");
		if (state.day !== day) {
			state.archivedMeasuredUsd += state.usd;
			if (!Number.isFinite(state.archivedMeasuredUsd)) throw new Error("Continuous-chat archived spend overflow.");
			state.day = day;
			state.usd = 0;
		}
	}

	private addMeasured(state: SpendState, costUsd: number, observedAtMs: number): void {
		if (!Number.isFinite(costUsd) || costUsd < 0 || !isObservationTime(observedAtMs))
			throw new TypeError("Invalid measured summary cost or observation time.");
		if (observedAtMs > this.timers.now())
			throw new Error("Continuous-chat accounting clock moved before the response observation.");
		this.rollover(state);
		const observedDay = new Date(observedAtMs).toISOString().slice(0, 10);
		if (observedDay > state.day)
			throw new Error("Continuous-chat accounting clock moved before the response observation.");
		if (observedDay === state.day) state.usd += costUsd;
		else state.archivedMeasuredUsd += costUsd;
		if (!Number.isFinite(state.usd) || !Number.isFinite(state.archivedMeasuredUsd))
			throw new Error("Continuous-chat spend overflow.");
	}
	private locked<T>(fn: (state: SpendState, validatedDay: string) => T): T {
		return withFileLockSync(`${this.file}.lock`, () => {
			const state = this.read();
			const validatedDay = this.today();
			if (validatedDay < state.day)
				throw new Error("Continuous-chat accounting clock moved before its active UTC day.");
			return fn(state, validatedDay);
		});
	}
	private ensureRoom(state: SpendState, key: string): void {
		if (state.circuits[key] !== undefined || Object.keys(state.circuits).length < MAX_CIRCUITS) return;
		// An expired hold admits exactly like an absent entry; unknown bills remain in the usage journal.
		const removable = Object.keys(state.circuits).find((candidate) => {
			const circuit = state.circuits[candidate];
			return (
				(circuit?.status === "settled" && !circuit.pendingAck) ||
				(circuit?.status === "held" && !circuit.pendingAck && circuit.until <= this.timers.now())
			);
		});
		if (removable === undefined)
			throw new Error("Continuous-chat accounting state is full of active or held requests.");
		delete state.circuits[removable];
	}
	private remaining(state: SpendState, key: string): number {
		const circuit = state.circuits[key];
		if (!circuit || circuit.status === "settled") return 0;
		if (circuit.status === "held") return Math.max(0, circuit.until - this.timers.now());
		if (circuit.status === "unknown") throw new ContinuousChatAccountingUnresolved();
		if (this.owners.judge(circuit.owner) !== "dead") return DEFAULT_RETRY_POLICY.baseDelayMs;
		throw new ContinuousChatAccountingUnresolved();
	}

	/** Reconcile every dead or unsettled receipt before any account-wide admission decision. */
	private reconcile(): void {
		// First pass charges newly recovered receipts; the second can acknowledge those same records.
		const abandoned = this.locked((state) =>
			Object.entries(state.circuits).flatMap(([key, circuit]) =>
				circuit.status === "reserved" && this.owners.judge(circuit.owner) === "dead"
					? [{ key, circuit: structuredClone(circuit) }]
					: [],
			),
		);
		for (const { key, circuit } of abandoned) {
			if (!circuit.identity) continue;
			this.journal.cancelUndispatched(circuit.identity, circuit.token);
			this.locked((state) => {
				const current = state.circuits[key];
				if (
					current?.status !== "reserved" ||
					current.token !== circuit.token ||
					this.owners.judge(current.owner) !== "dead" ||
					JSON.stringify(current.identity) !== JSON.stringify(circuit.identity)
				)
					return;
				state.circuits[key] = {
					status: "held",
					token: current.token,
					until: this.timers.now() + CONTINUOUS_CHAT_ACCOUNTING_COOLDOWN_MS,
				};
				this.save(state);
			});
		}
		const unreadable = new Map<string, string>();
		for (let pass = 0; pass < 2; pass++) {
			const candidates = this.locked((state) =>
				Object.entries(state.circuits).flatMap(([key, circuit]) => {
					if (
						circuit.status === "unknown" ||
						circuit.status === "flight" ||
						((circuit.status === "held" || circuit.status === "settled") && circuit.pendingAck)
					)
						return [{ key, circuit: structuredClone(circuit) }];
					return [];
				}),
			);
			for (const { key, circuit } of candidates) {
				if (circuit.status === "flight" || circuit.status === "unknown") {
					if (!circuit.identity) continue;
					const receipt = this.journal.read(circuit.identity, circuit.token);
					if (receipt.kind !== "known" || !receipt.summarySpendPending) {
						if (
							receipt.kind === "unresolved" &&
							(circuit.status === "unknown" || this.owners.judge(circuit.owner) !== "alive")
						)
							this.journal.requestRecovery(circuit.identity, circuit.token);
						if (receipt.kind === "unknown" || receipt.kind === "known") unreadable.set(key, circuit.token);
						continue;
					}
					this.locked((state) => {
						const current = state.circuits[key];
						if (
							!current ||
							current.token !== circuit.token ||
							(current.status !== "flight" && current.status !== "unknown") ||
							JSON.stringify(current.identity) !== JSON.stringify(circuit.identity)
						)
							return;
						this.addMeasured(state, receipt.costUsd, receipt.observedAtMs);
						state.circuits[key] = {
							status: "held",
							token: current.token,
							until: this.timers.now() + CONTINUOUS_CHAT_ACCOUNTING_COOLDOWN_MS,
							pendingAck: {
								identity: circuit.identity!,
								costUsd: receipt.costUsd,
								observedAtMs: receipt.observedAtMs,
								ackStarted: false,
							},
						};
						this.save(state);
					});
					continue;
				}
				const pending = circuit.pendingAck;
				if (!pending) continue;
				const receipt = this.journal.read(pending.identity, circuit.token);
				if (receipt.kind === "unresolved") this.journal.requestRecovery(pending.identity, circuit.token);
				if (receipt.kind === "unknown" || receipt.kind === "unresolved") continue;
				if (
					receipt.kind === "known" &&
					(receipt.costUsd !== pending.costUsd || receipt.observedAtMs !== pending.observedAtMs)
				)
					continue;
				if (!pending.ackStarted && (receipt.kind !== "known" || !receipt.summarySpendPending)) continue;
				const admitted = this.locked((state) => {
					const current = state.circuits[key];
					if (
						!current ||
						current.token !== circuit.token ||
						(current.status !== "held" && current.status !== "settled") ||
						JSON.stringify(current.pendingAck) !== JSON.stringify(pending)
					)
						return false;
					if (!pending.ackStarted) {
						current.pendingAck!.ackStarted = true;
						this.save(state);
					}
					return true;
				});
				if (!admitted) continue;
				this.journal.acknowledge(pending.identity, circuit.token);
				this.locked((state) => {
					const current = state.circuits[key];
					if (
						!current ||
						current.token !== circuit.token ||
						(current.status !== "held" && current.status !== "settled") ||
						!current.pendingAck?.ackStarted ||
						current.pendingAck.costUsd !== pending.costUsd ||
						current.pendingAck.observedAtMs !== pending.observedAtMs ||
						JSON.stringify(current.pendingAck.identity) !== JSON.stringify(pending.identity)
					)
						return;
					delete current.pendingAck;
					this.save(state);
				});
			}
		}
		const unresolved = this.locked((state) =>
			Object.entries(state.circuits).some(
				([key, circuit]) =>
					circuit.status === "unknown" ||
					(circuit.status === "reserved" && (!circuit.identity || this.owners.judge(circuit.owner) !== "alive")) ||
					(circuit.status === "flight" &&
						(!circuit.identity ||
							this.owners.judge(circuit.owner) !== "alive" ||
							unreadable.get(key) === circuit.token)) ||
					((circuit.status === "held" || circuit.status === "settled") && circuit.pendingAck !== undefined),
			),
		);
		if (unresolved) throw new ContinuousChatAccountingUnresolved();
	}
	/** Daily spend hold; invalid state is never treated as zero. */
	hold(): string | undefined {
		this.reconcile();
		const limit = this.maxUsdPerDay();
		if (!(limit > 0)) return undefined;
		return this.locked((state, validatedDay) => {
			const spent = state.day === validatedDay ? state.usd : 0;
			return spent >= limit
				? `Memory summaries are paused for today: they have used $${spent.toFixed(2)} of the $${limit.toFixed(2)} daily limit. They resume tomorrow or as soon as the limit is raised, and the full history stays readable.`
				: undefined;
		});
	}
	resetsInMs(): number {
		const now = this.timers.now();
		const date = new Date(now);
		return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - now;
	}
	accountingWait(key: string): number {
		this.reconcile();
		return this.locked((state) => this.remaining(state, key));
	}
	/** Recheck shared account rules under the same lock as each admission transition. */
	private assertAccountAdmission(state: SpendState, validatedDay: string): void {
		if (
			Object.values(state.circuits).some(
				(item) =>
					item.status === "unknown" ||
					(item.status === "reserved" && (!item.identity || this.owners.judge(item.owner) !== "alive")) ||
					(item.status === "flight" && (!item.identity || this.owners.judge(item.owner) !== "alive")) ||
					((item.status === "held" || item.status === "settled") && item.pendingAck),
			)
		)
			throw new ContinuousChatAccountingUnresolved();
		const limit = this.maxUsdPerDay();
		if (limit > 0 && state.day === validatedDay && state.usd >= limit)
			throw new ContinuousChatAccountingBusy("The daily memory summary spending limit is reached.");
	}
	/** Reserves the physical slot under the shared lock before the provider can be called. */
	claim(key: string, identity: SemanticUsageLedgerIdentity): string {
		if (!KEY_PATTERN.test(key)) throw new TypeError("Invalid continuous-chat accounting key.");
		const reference = recoveryIdentity(identity);
		if (!reference) throw new Error("Memory summary requires a persisted usage ledger identity.");
		this.reconcile();
		return this.locked((state, validatedDay) => {
			this.assertAccountAdmission(state, validatedDay);
			if (this.remaining(state, key) > 0) throw new ContinuousChatAccountingBusy();
			this.ensureRoom(state, key);
			const token = randomUUID();
			state.circuits[key] = { status: "reserved", token, owner: this.owners.own(), identity: reference };
			try {
				this.save(state);
			} catch (error) {
				throw new ContinuousChatAccountingClaimWriteError(token, error);
			}
			return token;
		});
	}
	/** Fence the exact reservation as potentially sent before crossing the physical transport boundary. */
	attempt(key: string, token: string): void {
		this.reconcile();
		this.locked((state, validatedDay) => {
			const circuit = state.circuits[key];
			if (circuit?.status !== "reserved" || circuit.token !== token) throw new ContinuousChatAccountingUnresolved();
			this.assertAccountAdmission(state, validatedDay);
			state.circuits[key] = { ...circuit, status: "flight" };
			this.save(state);
		});
	}
	/** Atomically count measured cost once and settle only the exact outstanding physical claim. */
	settle(
		key: string,
		token: string,
		healthy: boolean,
		measuredCostUsd?: number,
		observedAtMs?: number,
		physicalAttempted = true,
	): void {
		if (measuredCostUsd !== undefined && (!Number.isFinite(measuredCostUsd) || measuredCostUsd < 0))
			throw new TypeError("Invalid measured summary cost.");
		if (
			measuredCostUsd !== undefined &&
			(observedAtMs === undefined ||
				!Number.isSafeInteger(observedAtMs) ||
				observedAtMs < 0 ||
				!Number.isFinite(new Date(observedAtMs).getTime()))
		)
			throw new TypeError("Measured summary cost requires a valid observation time.");
		if (!physicalAttempted && measuredCostUsd !== undefined)
			throw new TypeError("An undispatched summary cannot have a measured cost.");
		if (!physicalAttempted) {
			const identity = this.locked((state) => {
				const circuit = state.circuits[key];
				return circuit?.token === token && (circuit.status === "reserved" || circuit.status === "flight")
					? circuit.identity
					: undefined;
			});
			if (identity) this.journal.cancelUndispatched(identity, token);
		}
		this.locked((state) => {
			const circuit = state.circuits[key];
			if (!circuit || circuit.token !== token || (circuit.status !== "flight" && circuit.status !== "reserved"))
				return;
			if (circuit.status === "reserved" && physicalAttempted) throw new ContinuousChatAccountingUnresolved();
			if (measuredCostUsd !== undefined) {
				if (!circuit.identity) throw new ContinuousChatAccountingUnresolved();
				this.addMeasured(state, measuredCostUsd, observedAtMs!);
				const pendingAck: PendingAck = {
					identity: circuit.identity,
					costUsd: measuredCostUsd,
					observedAtMs: observedAtMs!,
					ackStarted: false,
				};
				state.circuits[key] = healthy
					? { status: "settled", token, pendingAck }
					: {
							status: "held",
							token,
							until: this.timers.now() + CONTINUOUS_CHAT_ACCOUNTING_COOLDOWN_MS,
							pendingAck,
						};
			} else if (physicalAttempted) {
				state.circuits[key] = {
					status: "unknown",
					token,
					...(circuit.identity ? { identity: circuit.identity } : {}),
				};
			} else {
				state.circuits[key] = {
					status: "held",
					token,
					until: this.timers.now() + CONTINUOUS_CHAT_ACCOUNTING_COOLDOWN_MS,
				};
			}
			this.save(state);
		});
		this.reconcile();
	}
}
