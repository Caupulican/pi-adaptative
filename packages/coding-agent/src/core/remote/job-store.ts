/**
 * The durable job stores of the link, under `<agentDir>/remote/jobs/`, one file per job so a plain directory watch sees
 * every change and two sessions never rewrite each other's jobs:
 *
 * - `out/<jobId>.json`: a job this machine placed on a peer (the placer's record). The owning session writes it
 *   `pending`; whichever session or channel host holds the link to the peer sends it; the owning session applies the end.
 * - `in/<placerId>.<jobId>.json`: a job a peer placed here (the executor's record). Created at most once per placer and
 *   job id, with the digest of the offer it admitted: the same offer again is a replay, a different one a conflict. Its
 *   outbox keeps every progress and outcome frame until the placer acknowledges it.
 * - `journal.jsonl`: one line per transition (ids, codes and counts only), bounded by rotation.
 * - `runner.json`: the session that runs placed jobs here, with its model access and room.
 *
 * Every change is a read, change and atomic replace under the record's own file lock.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { isProcessOwnerRecord, ownProcessOwner, type ProcessOwner } from "../../kernel/reliability/owner-identity.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { liveRunnerAdvert, type ModelFact, type RunnerAdvert } from "./capabilities.ts";
import {
	digestOutcome,
	JOB_CANCEL_REASONS,
	JOB_REFUSALS,
	type JobCancelReason,
	type JobFrame,
	type JobOffer,
	type JobOutcome,
	type JobPhase,
	type JobRefusal,
	parseJobFrame,
	parsePlacedJobReference,
	placedJobReference,
} from "./job-protocol.ts";

/** How a placed job ended on the placer's side without an outcome from the executor. */
export const PLACER_ENDINGS = [
	"machine_offline",
	"machine_revoked",
	"remote_lost",
	"remote_deadline",
	"owner_cancelled",
] as const;
export type PlacerEnding = (typeof PLACER_ENDINGS)[number];

export type PlacerJobState = "pending" | "accepted" | "refused" | "terminal" | "ended";

export interface PlacerJobRecord {
	readonly v: 1;
	readonly jobId: string;
	readonly executorId: string;
	/** The owner's label for the executor when the job was placed. */
	readonly executorName: string;
	/** The session that placed the job and applies its end. */
	readonly ownerSession: string;
	readonly laneId: string;
	/** The managed lane's attempt, written at placement. Absent on a record a replayed dispatch wrote, or an older build's. */
	readonly attemptId?: string;
	readonly offer: JobOffer;
	readonly offerDigest: string;
	readonly state: PlacerJobState;
	/** Placer clock, epoch milliseconds. */
	readonly createdAt: number;
	/** Placer clock: the lane ends here whatever the executor says. */
	readonly deadlineAt: number;
	readonly refusal?: JobRefusal;
	readonly progress?: { readonly seq: number; readonly phase: JobPhase; readonly line?: string };
	/** The highest executor frame number this record holds (acknowledged). */
	readonly lastSeq: number;
	readonly outcome?: JobOutcome;
	readonly outcomeDigest?: string;
	/** A second outcome with another digest arrived after the first; it was kept out. */
	readonly conflict?: true;
	readonly ending?: PlacerEnding;
	readonly cancel?: JobCancelReason;
	readonly cancelSent?: true;
	/** The managed lane holds the end; nothing more is applied. */
	readonly appliedAt?: number;
}

export type ExecutorJobState = "admitted" | "running" | "terminal";

export interface OutboxEntry {
	readonly seq: number;
	readonly frame: Extract<JobFrame, { t: "job.progress" | "job.outcome" }>;
}

export interface ExecutorJobRecord {
	readonly v: 1;
	readonly placerId: string;
	readonly placerName: string;
	readonly jobId: string;
	readonly offer: JobOffer;
	readonly offerDigest: string;
	readonly state: ExecutorJobState;
	/** Executor clock. */
	readonly admittedAt: number;
	readonly deadlineAt: number;
	/** The offered checkout the job reads, matched by identity at admission. */
	readonly checkout?: string;
	/** The session running the job; a dead runner's job ends as interrupted. */
	readonly runner?: ProcessOwner;
	/** The empty directory an answer-only job starts in, recorded so a restarted runner removes it. */
	readonly workspace?: string;
	readonly laneId?: string;
	/** The last frame number assigned. */
	readonly seq: number;
	readonly outbox: readonly OutboxEntry[];
	readonly ackedSeq: number;
	readonly cancel?: JobCancelReason;
}

const MAX_OUTBOX = 64;
const JOURNAL_MAX_BYTES = 512 * 1024;
/** A finished record is kept this long for replay detection, then removed by the next scan. */
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const jobsDir = (agentDir: string): string => join(agentDir, "remote", "jobs");
export const outDir = (agentDir: string): string => join(jobsDir(agentDir), "out");
export const inDir = (agentDir: string): string => join(jobsDir(agentDir), "in");

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function offerOf(value: unknown): JobOffer | undefined {
	const frame = parseJobFrame({ t: "job.offer", offer: value });
	return frame?.t === "job.offer" ? frame.offer : undefined;
}

function outcomeOf(value: unknown): JobOutcome | undefined {
	const frame = parseJobFrame({ t: "job.outcome", jobId: "x", seq: 1, outcome: value });
	return frame?.t === "job.outcome" ? frame.outcome : undefined;
}

function pickOne<T extends string>(values: readonly T[], value: unknown): T | undefined {
	return values.find((entry) => entry === value);
}

function parsePlacerRecord(value: unknown): PlacerJobRecord | undefined {
	if (!isPlainRecord(value) || value.v !== 1) return undefined;
	const offer = offerOf(value.offer);
	const state = pickOne(["pending", "accepted", "refused", "terminal", "ended"] as const, value.state);
	const strings = [
		value.jobId,
		value.executorId,
		value.executorName,
		value.ownerSession,
		value.laneId,
		value.offerDigest,
	];
	if (!offer || !state || !strings.every((entry) => typeof entry === "string")) return undefined;
	if (!isCount(value.createdAt) || !isCount(value.deadlineAt) || !isCount(value.lastSeq)) return undefined;
	const progressFrame = isPlainRecord(value.progress)
		? parseJobFrame({ t: "job.progress", jobId: offer.jobId, ...value.progress })
		: undefined;
	const outcome = value.outcome === undefined ? undefined : outcomeOf(value.outcome);
	const refusal = pickOne(JOB_REFUSALS, value.refusal);
	const ending = pickOne(PLACER_ENDINGS, value.ending);
	const cancel = pickOne(JOB_CANCEL_REASONS, value.cancel);
	return {
		v: 1,
		jobId: value.jobId as string,
		executorId: value.executorId as string,
		executorName: value.executorName as string,
		ownerSession: value.ownerSession as string,
		laneId: value.laneId as string,
		offer,
		offerDigest: value.offerDigest as string,
		state,
		createdAt: value.createdAt,
		deadlineAt: value.deadlineAt,
		...(refusal ? { refusal } : {}),
		...(progressFrame?.t === "job.progress"
			? {
					progress: {
						seq: progressFrame.seq,
						phase: progressFrame.phase,
						...(progressFrame.line ? { line: progressFrame.line } : {}),
					},
				}
			: {}),
		lastSeq: value.lastSeq,
		...(outcome ? { outcome, outcomeDigest: digestOutcome(outcome) } : {}),
		...(value.conflict === true ? { conflict: true as const } : {}),
		...(ending ? { ending } : {}),
		...(cancel ? { cancel } : {}),
		...(value.cancelSent === true ? { cancelSent: true as const } : {}),
		...(isCount(value.appliedAt) ? { appliedAt: value.appliedAt } : {}),
		...(typeof value.attemptId === "string" && value.attemptId.length > 0 ? { attemptId: value.attemptId } : {}),
	};
}

function parseOutboxEntry(value: unknown): OutboxEntry | undefined {
	if (!isPlainRecord(value) || !isCount(value.seq)) return undefined;
	const frame = parseJobFrame(value.frame);
	return frame && (frame.t === "job.progress" || frame.t === "job.outcome") && frame.seq === value.seq
		? { seq: value.seq, frame }
		: undefined;
}

function parseExecutorRecord(value: unknown): ExecutorJobRecord | undefined {
	if (!isPlainRecord(value) || value.v !== 1) return undefined;
	const offer = offerOf(value.offer);
	const state = pickOne(["admitted", "running", "terminal"] as const, value.state);
	const strings = [value.placerId, value.placerName, value.jobId, value.offerDigest];
	if (!offer || !state || !strings.every((entry) => typeof entry === "string")) return undefined;
	if (!isCount(value.admittedAt) || !isCount(value.deadlineAt) || !isCount(value.seq) || !isCount(value.ackedSeq))
		return undefined;
	const outbox = Array.isArray(value.outbox) ? value.outbox.map(parseOutboxEntry) : [];
	if (!outbox.every((entry) => entry !== undefined)) return undefined;
	const cancel = pickOne(JOB_CANCEL_REASONS, value.cancel);
	return {
		v: 1,
		placerId: value.placerId as string,
		placerName: value.placerName as string,
		jobId: value.jobId as string,
		offer,
		offerDigest: value.offerDigest as string,
		state,
		admittedAt: value.admittedAt,
		deadlineAt: value.deadlineAt,
		...(typeof value.checkout === "string" ? { checkout: value.checkout } : {}),
		...(isProcessOwnerRecord(value.runner) ? { runner: value.runner } : {}),
		...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
		...(typeof value.laneId === "string" ? { laneId: value.laneId } : {}),
		seq: value.seq,
		outbox: outbox as OutboxEntry[],
		ackedSeq: value.ackedSeq,
		...(cancel ? { cancel } : {}),
	};
}

/** One directory of JSON records, each changed only under its own file lock. */
class RecordDir<T> {
	readonly dir: string;
	private readonly parse: (value: unknown) => T | undefined;

	constructor(dir: string, parse: (value: unknown) => T | undefined) {
		this.dir = dir;
		this.parse = parse;
	}

	private path(name: string): string {
		return join(this.dir, `${name}.json`);
	}

	read(name: string): T | undefined {
		const path = this.path(name);
		if (!existsSync(path)) return undefined;
		try {
			return this.parse(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			return undefined;
		}
	}

	names(): string[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((file) => file.endsWith(".json"))
			.map((file) => file.slice(0, -".json".length));
	}

	list(): T[] {
		return this.names().flatMap((name) => {
			const record = this.read(name);
			return record ? [record] : [];
		});
	}

	/** Applies `change` to the current record under its lock; `undefined` from `change` writes nothing. */
	update(name: string, change: (current: T | undefined) => T | undefined): T | undefined {
		mkdirSync(this.dir, { recursive: true });
		const path = this.path(name);
		return withFileLockSync(path, () => {
			const current = this.read(name);
			const next = change(current);
			if (next === undefined) return current;
			writeFileAtomicSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
			return next;
		});
	}

	remove(name: string): void {
		rmSync(this.path(name), { force: true });
	}
}

export const executorRecordName = (placerId: string, jobId: string): string => `${placerId}.${jobId}`;

/** Both stores of one agent directory. */
export class JobStore {
	readonly agentDir: string;
	readonly out: RecordDir<PlacerJobRecord>;
	readonly in: RecordDir<ExecutorJobRecord>;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.out = new RecordDir(outDir(agentDir), parsePlacerRecord);
		this.in = new RecordDir(inDir(agentDir), parseExecutorRecord);
	}

	/** Placed jobs not sent yet, per machine: read once per synchronous pass, and dropped by this store's own writes to `out`. */
	private pendingByMachine: Map<string, number> | undefined;

	/** Placed jobs on `machineId` that are not sent yet: they will take that machine's room. */
	pendingPlacedCount(machineId: string): number {
		if (!this.pendingByMachine) {
			const counts = new Map<string, number>();
			for (const record of this.out.list())
				if (record.state === "pending") counts.set(record.executorId, (counts.get(record.executorId) ?? 0) + 1);
			this.pendingByMachine = counts;
			// A fleet pass reads every machine's room in turn; the next pass reads the store again, since other processes write it too.
			queueMicrotask(() => {
				this.pendingByMachine = undefined;
			});
		}
		return this.pendingByMachine.get(machineId) ?? 0;
	}

	/** Creates the placer's record unless one exists for the job id, and returns whichever record is there. */
	createPlaced(record: PlacerJobRecord): PlacerJobRecord {
		this.pendingByMachine = undefined;
		return this.out.update(record.jobId, (current) => (current ? undefined : record)) ?? record;
	}

	updatePlaced(
		jobId: string,
		change: (current: PlacerJobRecord) => PlacerJobRecord | undefined,
	): PlacerJobRecord | undefined {
		this.pendingByMachine = undefined;
		return this.out.update(jobId, (current) => (current ? change(current) : undefined));
	}

	/**
	 * Admits a peer's offer at most once. A record for the placer and job id with the same digest is a replay (the
	 * placer resent it after a lost link); another digest under the same ids is a conflict and changes nothing.
	 */
	admit(
		created: ExecutorJobRecord,
	): { readonly kind: "admitted" | "replay"; readonly record: ExecutorJobRecord } | { readonly kind: "conflict" } {
		let found: ExecutorJobRecord | undefined;
		const record = this.in.update(executorRecordName(created.placerId, created.jobId), (current) => {
			found = current;
			return current ? undefined : created;
		});
		if (!record) return { kind: "conflict" };
		if (!found) return { kind: "admitted", record };
		return record.offerDigest === created.offerDigest ? { kind: "replay", record } : { kind: "conflict" };
	}

	updateExecuted(
		placerId: string,
		jobId: string,
		change: (current: ExecutorJobRecord) => ExecutorJobRecord | undefined,
	): ExecutorJobRecord | undefined {
		return this.in.update(executorRecordName(placerId, jobId), (current) => (current ? change(current) : undefined));
	}

	/** Appends one outbox frame with the next number; the outbox never holds more than its bound (oldest progress first). */
	appendOutbox(
		placerId: string,
		jobId: string,
		frame: (seq: number) => OutboxEntry["frame"],
		state?: ExecutorJobState,
	): ExecutorJobRecord | undefined {
		return this.updateExecuted(placerId, jobId, (current) => {
			if (current.state === "terminal") return undefined;
			const seq = current.seq + 1;
			let outbox = [...current.outbox, { seq, frame: frame(seq) }];
			while (outbox.length > MAX_OUTBOX) {
				const progress = outbox.findIndex((entry) => entry.frame.t === "job.progress");
				if (progress < 0) break;
				outbox = outbox.filter((_, index) => index !== progress);
			}
			return { ...current, seq, outbox, ...(state ? { state } : {}) };
		});
	}

	/** Removes finished records older than the retention, so replay detection stays bounded. */
	prune(now: number): void {
		this.pendingByMachine = undefined;
		for (const record of this.out.list())
			if (record.appliedAt !== undefined && now - record.appliedAt > FINISHED_RETENTION_MS)
				this.out.remove(record.jobId);
		for (const record of this.prunable(now)) this.in.remove(executorRecordName(record.placerId, record.jobId));
	}

	/** The executor records `prune` removes at `now`: finished, outcome acknowledged by the placer, past retention. */
	prunable(now: number): ExecutorJobRecord[] {
		return this.in
			.list()
			.filter(
				(record) =>
					record.state === "terminal" &&
					record.outbox.length === 0 &&
					now - record.admittedAt > FINISHED_RETENTION_MS,
			);
	}
}

/** One journal line: who, which job, what happened; never a label, an instruction or a summary. */
export function journalJob(
	agentDir: string,
	entry: {
		readonly side: "placer" | "executor";
		readonly jobId: string;
		readonly peer: string;
		readonly event: string;
		readonly code?: string;
	},
): void {
	const path = join(jobsDir(agentDir), "journal.jsonl");
	try {
		mkdirSync(jobsDir(agentDir), { recursive: true });
		if (existsSync(path) && statSync(path).size > JOURNAL_MAX_BYTES) renameSync(path, `${path}.1`);
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
	} catch (error) {
		harnessLog.warn("link", "a job journal line could not be written", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}

const runnerPath = (agentDir: string): string => join(jobsDir(agentDir), "runner.json");

/** Publishes the session that runs placed jobs here; a peer's advert reads it while that session is alive. */
export function publishRunner(agentDir: string, models: readonly ModelFact[], room: number): void {
	mkdirSync(jobsDir(agentDir), { recursive: true });
	writeFileAtomicSync(
		runnerPath(agentDir),
		`${JSON.stringify({ owner: ownProcessOwner(), models, room, updatedAt: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	);
}

export function readRunner(agentDir: string): RunnerAdvert | undefined {
	const path = runnerPath(agentDir);
	if (!existsSync(path)) return undefined;
	try {
		return liveRunnerAdvert(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Jobs admitted here from every placer and not finished yet: what an advert's room is reduced by. */
export function activeExecutorJobs(store: JobStore): number {
	return store.in.list().filter((record) => record.state !== "terminal").length;
}

/** The references of every placed job this agent directory's store records as ended (outcome recorded). */
export function finishedPlacedJobReferences(agentDir: string): string[] {
	if (!existsSync(inDir(agentDir))) return [];
	return new JobStore(agentDir).in
		.list()
		.filter((record) => record.state === "terminal")
		.map((record) => placedJobReference(record.placerId, record.jobId));
}

/**
 * Whether this agent directory's job store records the placed job named by `reference` as ended (its outcome is in the
 * outbox, or delivered). The store is keyed by placer and job id together, so both must match.
 */
export function placedJobFinished(agentDir: string, reference: string): boolean {
	const key = parsePlacedJobReference(reference);
	if (key === undefined || !existsSync(inDir(agentDir))) return false;
	return new JobStore(agentDir).in
		.list()
		.some((record) => record.placerId === key.placerId && record.jobId === key.jobId && record.state === "terminal");
}
